/**
 * The automation-rule evaluator: a periodic sweep over CURRENT state (#89,
 * `automation_rules`).
 *
 * ## Why a sweep, and not a hook in the write paths
 *
 * The things a rule reacts to — a variant's stock, an order becoming paid — are
 * written by `inventory.service` (deliberately transaction-free, one guarded
 * UPDATE per mutation) and `order.service.transition` (a CAS and then
 * best-effort side effects). Hooking a rule into either would put plan-domain
 * code inside the commerce write path, where its failure or its latency would
 * be the checkout's. A sweep reads what those paths already committed and
 * cannot block, slow or fail one: a rule that throws costs a log line and a
 * `failed` run, never a sale. It also keeps the commerce modules free of any
 * reference to the plan domain, which `merchant-plan-isolation.test.ts` reads.
 *
 * The price is latency: a rule acts within one interval
 * (`AUTOMATION_RULES_EVALUATE_INTERVAL_MS`, a minute by default) of the
 * change, not inside the request that made it.
 *
 * ## Idempotent per (rule, subject, occurrence), on every task at once
 *
 * - A stock rule's occurrence is an EPISODE: the row in
 *   `automation_rule_listing_states` claimed by `INSERT … ON CONFLICT DO
 *   NOTHING`. While it exists the rule does not fire again for that listing;
 *   when stock recovers the row is claimed back by `DELETE … RETURNING`, and the
 *   next dip is a new episode.
 * - An order rule's occurrence is the payment (`paid`), claimed by the run row's
 *   unique key.
 *
 * Each claim, the action and the run row share one transaction, so a crash
 * mid-action rolls the claim back and the next tick retries; a second task's
 * claim waits on the first's uncommitted key and then claims nothing. An action
 * that ran and was refused or failed is recorded and NOT retried for the same
 * occurrence — the run log is where a merchant sees it.
 *
 * ## The plan is asked per store, before anything runs
 *
 * `holdsCapability` (the `requireCapability` answer) is asked once per store
 * per pass. A store at its ceiling still runs its rules; a store whose plan
 * ended runs none and logs nothing, and every rule it wrote stays where it is.
 *
 * ## The LOOP is gated; the rules never are
 *
 * `AUTOMATION_RULES_EVALUATOR_ENABLED` stops the timer and nothing else: the
 * rules and their history stay readable and editable while it is off.
 */

import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  closeStockEpisode,
  findListingsEnteringStockEpisode,
  findPaidOrdersForRule,
  findRecoveredStockEpisodes,
  insertAutomationRuleRun,
  listEnabledAutomationRulesPage,
  markStockEpisodePaused,
  openStockEpisode,
  settleAutomationRuleRun,
  type AutomationRuleRow,
} from '../../db/automationRules/automationRuleRepository.js';
import { log } from '../../lib/logger.js';
import { holdsCapability } from '../entitlements/enforce.js';
import {
  markOrderProcessing,
  notifyListingStock,
  notifyOrderPaid,
  pauseListing,
  republishListing,
  type ActionOutcome,
} from './actions.js';
import { AUTOMATION_RULES_CAPABILITY } from './rule.service.js';

/** What one pass did, for the log line and for tests. */
export interface EvaluationSummary {
  rulesEvaluated: number;
  rulesSkippedNotEntitled: number;
  runsRecorded: number;
}

/** Bounds a pass takes; the defaults are the deployment's config. */
export interface EvaluationOptions {
  now?: Date;
  /** Restrict the pass to these stores — the test harness's scope on a shared database. */
  storeIds?: readonly string[];
  maxRules?: number;
  subjectsPerRule?: number;
}

/** Where the keyset walk over enabled rules resumes on this task. */
let ruleCursor: string | null = null;

/** Evaluate one stock rule: open new episodes, then close recovered ones. */
async function evaluateStockRule(rule: AutomationRuleRow, limit: number): Promise<number> {
  let runs = 0;

  for (const candidate of await findListingsEnteringStockEpisode(rule, limit)) {
    const recorded = await getDb().transaction(async (tx) => {
      const episode = await openStockEpisode(tx, {
        ruleId: rule.id,
        listingId: candidate.listingId,
      });
      if (!episode) return false;
      let result: ActionOutcome;
      if (rule.action === 'pause_listing') {
        result = await pauseListing(rule, candidate.listingId);
        if (result.outcome === 'succeeded') await markStockEpisodePaused(tx, episode.id);
      } else {
        result = await notifyListingStock(rule, candidate);
      }
      await insertAutomationRuleRun(tx, {
        ruleId: rule.id,
        storeId: rule.storeId,
        subjectKind: 'listing',
        subjectId: candidate.listingId,
        occurrence: `${episode.id}:${rule.action}`,
        step: rule.action === 'pause_listing' ? 'pause_listing' : 'notify_owner',
        outcome: result.outcome,
        detail: result.detail,
      });
      return true;
    });
    if (recorded) runs += 1;
  }

  for (const episode of await findRecoveredStockEpisodes(rule, limit)) {
    const recorded = await getDb().transaction(async (tx) => {
      const closed = await closeStockEpisode(tx, episode.stateId);
      if (!closed) return false;
      // Only the second half of a pause has anything to do on recovery, and only
      // for a listing THIS rule paused in THIS episode.
      if (
        !(rule.action === 'pause_listing' && rule.republishWhenRestocked && closed.pausedByRule)
      ) {
        return false;
      }
      const result = await republishListing(rule, closed.listingId);
      await insertAutomationRuleRun(tx, {
        ruleId: rule.id,
        storeId: rule.storeId,
        subjectKind: 'listing',
        subjectId: closed.listingId,
        occurrence: `${closed.id}:republish_listing`,
        step: 'republish_listing',
        outcome: result.outcome,
        detail: result.detail,
      });
      return true;
    });
    if (recorded) runs += 1;
  }

  return runs;
}

/** Evaluate one order rule over the orders paid since it was armed. */
async function evaluateOrderRule(
  rule: AutomationRuleRow,
  now: Date,
  limit: number,
): Promise<number> {
  const lookbackFloor = new Date(now.getTime() - config.automationRules.orderLookbackMs);
  const paidSince = rule.armedAt > lookbackFloor ? rule.armedAt : lookbackFloor;
  let runs = 0;

  for (const candidate of await findPaidOrdersForRule(rule, { paidSince, limit })) {
    const recorded = await getDb().transaction(async (tx) => {
      // The claim comes FIRST, so a second task waits on this uncommitted key
      // and then claims nothing; the outcome is settled before the commit.
      const claim = await insertAutomationRuleRun(tx, {
        ruleId: rule.id,
        storeId: rule.storeId,
        subjectKind: 'order',
        subjectId: candidate.orderId,
        occurrence: 'paid',
        step: rule.action === 'mark_order_processing' ? 'mark_order_processing' : 'notify_owner',
        outcome: 'failed',
        detail: null,
      });
      if (!claim) return false;
      const result =
        rule.action === 'mark_order_processing'
          ? await markOrderProcessing(rule, candidate.orderId)
          : await notifyOrderPaid(rule, candidate);
      await settleAutomationRuleRun(tx, claim.id, result);
      return true;
    });
    if (recorded) runs += 1;
  }
  return runs;
}

/** Evaluate one rule. Never throws: a rule's failure is its own. */
async function evaluateRule(rule: AutomationRuleRow, now: Date, limit: number): Promise<number> {
  try {
    return rule.trigger === 'listing_stock_at_or_below'
      ? await evaluateStockRule(rule, limit)
      : await evaluateOrderRule(rule, now, limit);
  } catch (err) {
    log.general.warn(
      { err, ruleId: rule.id, storeId: rule.storeId },
      '[AutomationRules] rule evaluation failed; the next pass retries',
    );
    return 0;
  }
}

/**
 * One pass: up to `maxRules` enabled rules from where the last pass on this
 * task stopped, each bounded to `subjectsPerRule` subjects per direction.
 */
export async function evaluateAutomationRules(
  options: EvaluationOptions = {},
): Promise<EvaluationSummary> {
  const now = options.now ?? new Date();
  const maxRules = options.maxRules ?? config.automationRules.rulesPerPass;
  const limit = options.subjectsPerRule ?? config.automationRules.subjectsPerRule;
  // A scoped pass (a test) walks from the start and leaves the task's cursor alone.
  const scoped = options.storeIds !== undefined;
  const afterId = scoped ? null : ruleCursor;

  const rules = await listEnabledAutomationRulesPage({
    afterId,
    limit: maxRules,
    ...(scoped ? { storeIds: options.storeIds } : {}),
  });
  if (!scoped) ruleCursor = rules.length < maxRules ? null : (rules.at(-1)?.id ?? null);

  const entitled = new Map<string, boolean>();
  const summary: EvaluationSummary = {
    rulesEvaluated: 0,
    rulesSkippedNotEntitled: 0,
    runsRecorded: 0,
  };
  for (const rule of rules) {
    let holds = entitled.get(rule.storeId);
    if (holds === undefined) {
      try {
        holds = await holdsCapability({
          storeId: rule.storeId,
          capability: AUTOMATION_RULES_CAPABILITY,
          at: now,
        });
      } catch (err) {
        // The entitlement could not be read: fail CLOSED for this pass.
        log.general.warn(
          { err, storeId: rule.storeId },
          '[AutomationRules] entitlement unreadable',
        );
        holds = false;
      }
      entitled.set(rule.storeId, holds);
    }
    if (!holds) {
      summary.rulesSkippedNotEntitled += 1;
      continue;
    }
    summary.rulesEvaluated += 1;
    summary.runsRecorded += await evaluateRule(rule, now, limit);
  }
  return summary;
}

/** The timer, so the evaluator can be stopped in a test. */
let timer: ReturnType<typeof setInterval> | null = null;

/** Start the evaluator on this task. `.unref()`, so it never holds the event loop open. */
export function startAutomationRuleEvaluator(): void {
  if (timer !== null) return;
  if (!config.automationRules.evaluatorEnabled) {
    log.general.info('[AutomationRules] evaluator disabled; rules stay readable and run nothing');
    return;
  }
  timer = setInterval(() => {
    void evaluateAutomationRules()
      .then((summary) => {
        if (summary.runsRecorded > 0) log.general.info(summary, '[AutomationRules] pass complete');
      })
      .catch((err: unknown) => {
        log.general.error({ err }, '[AutomationRules] evaluator pass failed');
      });
  }, config.automationRules.evaluateIntervalMs);
  timer.unref?.();
}

/** Stop the evaluator. */
export function stopAutomationRuleEvaluator(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
