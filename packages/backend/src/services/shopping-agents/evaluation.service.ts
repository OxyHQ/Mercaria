/**
 * One agent, evaluated once (#97 §"Evaluation pipeline").
 *
 * The impure half: load the agent and its lines, ask
 * {@link evaluateAgentDeterministically}, append an idempotent finding, decide
 * whether it is worth saying, and queue a delivery.
 *
 * ## The order is load-bearing and there are three places it could be wrong
 *
 * 1. **The finding is written BEFORE any notification decision.** A
 *    `not_qualified` observation and an `incomplete` one are both worth
 *    recording — #97 UX 3 asks for a timeline with current validity, and a
 *    timeline of only the good news cannot show a shopper that their agent has
 *    been running and finding nothing. The row is also the idempotency: the
 *    unique index on `(agent_id, evaluation_key)` is what makes a repeated
 *    source event one finding (#97 evaluation 2, acceptance 1).
 * 2. **The empty `RETURNING` set IS the "already recorded" answer.** A
 *    read-then-write lets two workers both see "no" and both notify. Nothing
 *    here calls a finder first.
 * 3. **The notification is queued in the SAME transaction as the finding.** A
 *    finding that qualified and a delivery job that was never written is the
 *    one failure a retry cannot repair, because the retry converges on the
 *    finding and stops.
 *
 * ## A withheld notification is a ROW
 *
 * #97 notification 1 and 2 want at most one notification per cooldown; #97 cost
 * rule 6 wants duplicate suppression MONITORED. Those are the same mechanism:
 * every qualified finding writes a notification row, and the policy decides
 * whether it is `queued` or already `suppressed` with a coded reason. A table
 * of messages that were sent can never answer how many were not.
 */

import {
  SHOPPING_AGENT_POLICY_VERSION,
  shoppingAgentEvaluationKey,
  shoppingAgentNotificationDecision,
  type ShoppingAgentFindingOutcome,
  type ShoppingAgentNotificationChannel,
  type ShoppingAgentTriggerSource,
  type CurrencyCode,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  findShoppingAgentById,
  listShoppingAgentLines,
  recordShoppingAgentEvaluated,
  recordShoppingAgentNotified,
  type ShoppingAgentFactsRow,
} from '../../db/shoppingAgents/shoppingAgentRepository.js';
import {
  findLatestQualifiedFinding,
  insertShoppingAgentFinding,
  type NewShoppingAgentFindingLine,
} from '../../db/shoppingAgents/shoppingAgentFindingRepository.js';
import {
  enqueueShoppingAgentNotification,
  recordShoppingAgentNotificationSuppressed,
} from '../../db/shoppingAgents/shoppingAgentNotificationRepository.js';
import { resolveOfferComparisonMode } from '../backfill/read-mode.js';
import { evaluateAgentDeterministically } from './deterministic.js';

/** What one pass did, for the dispatcher's own counters. */
export interface ShoppingAgentEvaluationOutcome {
  readonly evaluated: boolean;
  readonly findingRecorded: boolean;
  readonly qualified: boolean;
  /**
   * The verdict this pass reached, or ABSENT when there was nothing to
   * evaluate.
   *
   * Three values and not a boolean, because `not_qualified` and `incomplete`
   * are different facts and the queue's own summary counts them separately:
   * one says the catalogue was read and does not satisfy the objective, the
   * other says it could not be read. A dispatcher that reported only
   * `qualified` would leave the second at a permanent zero.
   */
  readonly findingOutcome?: ShoppingAgentFindingOutcome;
  readonly notificationsQueued: number;
  readonly notificationsSuppressed: number;
}

const NOTHING: ShoppingAgentEvaluationOutcome = {
  evaluated: false,
  findingRecorded: false,
  qualified: false,
  notificationsQueued: 0,
  notificationsSuppressed: 0,
};

/**
 * Evaluate one agent.
 *
 * Returns rather than throws for an agent that is not evaluable — a paused,
 * blocked, completed or deleted agent is a fact rather than a fault, and
 * throwing would make the dispatcher retry a state only its owner can change.
 */
export async function evaluateShoppingAgent(
  agentId: string,
  triggerSource: ShoppingAgentTriggerSource,
  now: Date = new Date(),
): Promise<ShoppingAgentEvaluationOutcome> {
  const agent = await findShoppingAgentById(agentId);
  if (agent === undefined) return NOTHING;
  if (agent.state !== 'enabled' || agent.ambiguityState !== 'resolved') return NOTHING;

  const lines = await listShoppingAgentLines(agentId);
  if (lines.length === 0) return NOTHING;

  const prior = await findLatestQualifiedFinding(agentId);
  const evaluation = await evaluateAgentDeterministically({
    subject: {
      id: agent.id,
      kind: agent.kind,
      displayCurrency: agent.displayCurrency as CurrencyCode,
      priceBasis: agent.priceBasis,
      channelPolicy: agent.channelPolicy,
      ...(agent.market === null ? {} : { market: agent.market }),
      conditionGroups: agent.conditionGroups,
      excludedMerchantIds: agent.excludedMerchantIds,
      ...(agent.targetAmount === null ? {} : { targetAmountMinor: agent.targetAmount }),
      ...(agent.targetCurrency === null
        ? {}
        : { targetCurrency: agent.targetCurrency as CurrencyCode }),
      constraintSet: agent.constraintSet,
      lines: lines.map((line) => ({
        id: line.id,
        canonicalProductId: line.canonicalProductId,
        ...(line.canonicalVariantId === null
          ? {}
          : { canonicalVariantId: line.canonicalVariantId }),
        quantity: line.quantity,
        conditionGroups: line.conditionGroups,
        ...(line.merchantId === null ? {} : { merchantId: line.merchantId }),
      })),
    },
    // #96's lever, read HERE rather than inside the evaluator: a service
    // reading it would be a second place the rollout is decided.
    offerComparisonPermitted: resolveOfferComparisonMode() === 'on',
    ...(prior === undefined ||
    prior.objectiveAmount === null ||
    prior.objectiveCurrency === null
      ? {}
      : {
          prior: {
            objectiveAmountMinor: prior.objectiveAmount,
            objectiveCurrency: prior.objectiveCurrency as CurrencyCode,
          },
        }),
  });

  const evaluationKey = shoppingAgentEvaluationKey({
    agentId: agent.id,
    agentRevision: agent.revision,
    inputDigest: evaluation.inputDigest,
    policyVersion: SHOPPING_AGENT_POLICY_VERSION,
  });

  const findingLines: NewShoppingAgentFindingLine[] = evaluation.selection.map(
    (line, position) => ({
      lineId: line.lineId,
      canonicalProductId: line.canonicalProductId,
      offerRef: line.offerRef,
      quantity: line.quantity,
      ...(line.unitItemPrice === undefined
        ? {}
        : {
            unitItemPriceAmount: line.unitItemPrice.amount,
            unitItemPriceCurrency: line.unitItemPrice.currency,
          }),
      ...(line.conditionGroup === undefined ? {} : { conditionGroup: line.conditionGroup }),
      nativeCheckoutEligible: line.nativeCheckoutEligible,
      officialChannel: line.officialChannel,
      position,
    }),
  );

  const decision = shoppingAgentNotificationDecision({
    cooldownSeconds: agent.cooldownSeconds,
    ...(agent.lastNotifiedAt === null ? {} : { lastNotifiedAt: agent.lastNotifiedAt }),
    ...(agent.lastNotifiedAmount === null
      ? {}
      : { lastNotifiedAmountMinor: agent.lastNotifiedAmount }),
    ...(evaluation.objectiveValue === undefined
      ? {}
      : { candidateAmountMinor: evaluation.objectiveValue.amount }),
    now,
  });

  const channels = agent.notificationChannels;
  const written = await getDb().transaction(async (tx) => {
    const finding = await insertShoppingAgentFinding(
      {
        agentId: agent.id,
        evaluationKey,
        agentRevision: agent.revision,
        triggerSource,
        triggeredAt: now,
        evaluatedAt: now,
        outcome: evaluation.outcome,
        incompleteReasons: evaluation.incompleteReasons,
        completeness: evaluation.completeness,
        freshness: evaluation.freshness,
        ...(evaluation.optimality === undefined ? {} : { optimality: evaluation.optimality }),
        inputDigest: evaluation.inputDigest,
        agentPolicyVersion: evaluation.agentPolicyVersion,
        constraintEvaluationVersion: evaluation.constraintEvaluationVersion,
        normalizationRuleVersion: evaluation.normalizationRuleVersion,
        comparisonPolicyVersion: evaluation.comparisonPolicyVersion,
        rankingPolicyVersion: evaluation.rankingPolicyVersion,
        satisfiedConstraintIds: evaluation.satisfiedConstraintIds,
        failedConstraintIds: evaluation.failedConstraintIds,
        unknownConstraintIds: evaluation.unknownConstraintIds,
        ...(evaluation.objectiveValue === undefined
          ? {}
          : {
              objectiveAmount: evaluation.objectiveValue.amount,
              objectiveCurrency: evaluation.objectiveValue.currency,
            }),
        ...(evaluation.objectiveDeltaMinor === undefined
          ? {}
          : { objectiveDeltaAmount: evaluation.objectiveDeltaMinor }),
        recordRefs: evaluation.records,
        lines: findingLines,
      },
      tx,
    );

    // The empty result IS the "already recorded" answer. See the module header.
    if (finding === undefined) return { recorded: false, queued: 0, suppressed: 0 };
    if (evaluation.outcome !== 'qualified') {
      return { recorded: true, queued: 0, suppressed: 0 };
    }

    let queued = 0;
    let suppressed = 0;
    for (const channel of channels as readonly ShoppingAgentNotificationChannel[]) {
      if (decision.decision === 'withhold') {
        await recordShoppingAgentNotificationSuppressed(
          {
            findingId: finding.id,
            agentId: agent.id,
            channel,
            reason: decision.reason,
            now,
          },
          tx,
        );
        suppressed += 1;
        continue;
      }
      await enqueueShoppingAgentNotification(
        { findingId: finding.id, agentId: agent.id, channel, availableAt: now },
        tx,
      );
      queued += 1;
    }

    if (queued > 0) {
      await recordShoppingAgentNotified(
        {
          id: agent.id,
          ...(evaluation.objectiveValue === undefined
            ? {}
            : { amountMinor: evaluation.objectiveValue.amount }),
          now,
        },
        tx,
      );
    }
    return { recorded: true, queued, suppressed };
  });

  await recordShoppingAgentEvaluated({
    id: agent.id,
    now,
    ...(nextScheduleFor(agent, now) === undefined
      ? {}
      : { nextScheduledAt: nextScheduleFor(agent, now) }),
  });

  return {
    evaluated: true,
    findingRecorded: written.recorded,
    qualified: evaluation.outcome === 'qualified',
    findingOutcome: evaluation.outcome,
    notificationsQueued: written.queued,
    notificationsSuppressed: written.suppressed,
  };
}

/**
 * When a scheduled agent is next due.
 *
 * Takes the description-FREE row, and that is the guarantee working rather than
 * a convenience: the evaluation path composes the package a model provider is
 * shown, and #97 privacy 5 forbids a private note reaching one. It cannot,
 * because nothing on this path has a type with that property.
 *
 * `undefined` for an agent that is not scheduled, so the column stays NULL and
 * the partial index that drives the sweep stays the size of the live scheduled
 * set rather than of every agent.
 */
function nextScheduleFor(agent: ShoppingAgentFactsRow, now: Date): Date | undefined {
  const interval = agent.scheduleIntervalSeconds;
  if (interval === null) return undefined;
  return new Date(now.getTime() + interval * 1_000);
}
