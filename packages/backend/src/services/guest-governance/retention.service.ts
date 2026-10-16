/**
 * The controlled retention job (#111 "Retention policy").
 *
 * ## What this job does, and what `db/expirySweeper.ts` already did
 *
 * The expiry sweep performs every `expiry_sweep` class: a hard DELETE on a
 * stamped deadline, one statement per registered target, and this job does not
 * duplicate a line of it. What it adds is the class the sweep structurally
 * cannot serve — MINIMIZATION, where the row survives and its identifying
 * columns do not.
 *
 * `ExpirySweepTarget` is `{table, column, retentionSeconds}` and deletes. ADR
 * 0003 D15 needs the opposite: a `guest_checkouts` row that an order still
 * references, with the contact inside it erased. Reaching past the module with
 * a hand-written DELETE would satisfy the words and destroy the order's
 * referential anchor, so minimization is its own job, on its own clock, with
 * its own auditable counters.
 *
 * ## It RUNS, on a timer, under the published policy (M8-02)
 *
 * The M8 review found no scheduler at all: this pass was reachable only from
 * the operator route, while the configuration declared a loop and two
 * docblocks cited one. {@link startGuestRetentionLoop} is that loop, started
 * unconditionally from `src/index.ts` beside the expiry sweeper, and
 * {@link runScheduledRetention} is what each tick does — every class with an
 * ACTIVE `minimization_job` policy row, page by page. The policy row is the
 * only switch; a deployment that has published none runs nothing.
 *
 * ## The vacuity floor is a CHECK, and it caught the shape of this loop
 *
 * `guest_retention_runs_counters_total_check` forces
 * `examined = minimized + deleted + skipped_held + failed`, an EQUALITY. A pass
 * that swallowed a row cannot write a row at all, which is why every branch
 * below increments exactly one counter and the loop cannot `continue` without
 * doing so. A retention job that silently did nothing and one that correctly
 * found nothing produce identical output otherwise, and the first is the
 * failure this whole domain exists to make visible.
 *
 * ## A dry run is the DEFAULT
 *
 * `GUEST_RETENTION_DRY_RUN` defaults TRUE, which is the one default in this
 * area on the cautious side of every other rollout lever — because the two
 * errors are not symmetric. A dry run that should have erased leaves data for
 * another day; an apply that should not have erased leaves nothing at all.
 */

import { and, asc, gt, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { GuestRetentionClass } from '@mercaria/shared-types';
import { GUEST_RETENTION_SCHEDULE } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { guestCheckouts } from '../../db/schema/guests.js';
import { orders } from '../../db/schema/orders.js';
import { minimizeGuestCheckoutContact } from '../../db/guests/guestCheckoutRepository.js';
import {
  closeRetentionRun,
  openRetentionRun,
  readActiveRetentionRules,
  readHeldCheckoutGroups,
  type ActiveRetentionRule,
} from '../../db/guestGovernance/retentionRepository.js';

/** What one pass did. */
export interface RetentionRunResult {
  readonly runId: string;
  readonly retentionClass: GuestRetentionClass;
  readonly mode: 'dry_run' | 'apply';
  readonly examined: number;
  readonly minimized: number;
  readonly skippedHeld: number;
  readonly failed: number;
  readonly cursorId: string | null;
}

/**
 * Why a pass could not run. A discriminated union with a STRING discriminant,
 * for the `strict: false` reason every union in this codebase now uses one.
 *
 * `idle` is the SCHEDULER's answer when a page held nothing to examine: the
 * loop asks for it, so a deployment with nothing due does not write a
 * `guest_retention_runs` row every fifteen minutes on every task into a table
 * that is never swept. An operator-triggered pass never asks, and always
 * records its run — zero examined is a real answer to "did it run".
 */
export type RetentionRunOutcome =
  | { readonly outcome: 'ran'; readonly result: RetentionRunResult }
  | { readonly outcome: 'idle' }
  | {
      readonly outcome: 'refused';
      readonly reason:
        | 'policy_missing'
        | 'mechanism_not_minimization'
        | 'performed_by_contact_pass';
    };

/** The classes this job performs. Every other class is the expiry sweep's. */
const MINIMIZATION_CLASSES: readonly GuestRetentionClass[] = [
  'unpaid_pending_checkout',
  'plaintext_equivalent_contact',
];

/**
 * Classes declaring `minimization_job` that no pass of their own performs,
 * each mapped to the passes that DO perform it (M8-09).
 *
 * `lookup_hash` is the one: the hash lives in the same row as the ciphertext it
 * digests and `minimizeGuestCheckoutContact` nulls both in ONE statement, so a
 * hash cannot outlive its value by construction. A pass of its own would be a
 * second selection over the same rows that consults ITS holds and not the
 * contact classes' — a hold on a disputed group's contact bypassed by a pass
 * nobody thought of as touching the contact. The review found it declared and
 * unimplemented; `guest-governance-mechanisms.test.ts` now fails the build if a
 * class declaring the mechanism appears in neither list, or if a carrier would
 * let the hash outlive the value.
 */
const CARRIED_MINIMIZATION_CLASSES: Readonly<
  Partial<Record<GuestRetentionClass, readonly GuestRetentionClass[]>>
> = {
  lookup_hash: ['unpaid_pending_checkout', 'plaintext_equivalent_contact'],
};

/** Every class this job performs, exported so the scheduler and the tests agree. */
export function minimizationClasses(): readonly GuestRetentionClass[] {
  return MINIMIZATION_CLASSES;
}

/** The carried classes and their carriers, exported for the mechanism census. */
export function carriedMinimizationClasses(): Readonly<
  Partial<Record<GuestRetentionClass, readonly GuestRetentionClass[]>>
> {
  return CARRIED_MINIMIZATION_CLASSES;
}

/** The classes whose live hold on a group pauses a pass over `retentionClass`. */
function holdingClassesFor(retentionClass: GuestRetentionClass): readonly GuestRetentionClass[] {
  const carried = Object.entries(CARRIED_MINIMIZATION_CLASSES)
    .filter(([, carriers]) => carriers?.includes(retentionClass))
    .map(([carriedClass]) => carriedClass as GuestRetentionClass);
  return [retentionClass, ...carried];
}

/**
 * Run one bounded pass over one class.
 *
 * Refuses when no version of the policy is ACTIVE for that class, rather than
 * falling back to the code constant beside it. `GUEST_RETENTION_SCHEDULE` is
 * what somebody PUBLISHES; a job that read it directly would make the published
 * version decorative and would delete under a rule nobody approved — the
 * `#58 policy_missing` posture, applied to a deletion. It also refuses when the
 * ACTIVE rule names a mechanism other than minimization: the published version
 * is the authority, and a pass that ran against a rule saying "swept" or
 * "never deleted" would be erasing under a rule that says otherwise.
 *
 * The page is selected `FOR UPDATE SKIP LOCKED` inside one transaction, so the
 * loop running on every task shares the work rather than racing for it: two
 * tasks never examine the same row, and the run counters are not inflated by a
 * row another task already minimized. Each row's UPDATE runs in a SAVEPOINT,
 * which keeps #60's per-record isolation inside the transaction.
 *
 * @param afterId - a keyset cursor: the page starts after this `guest_checkouts`
 *   id. The scheduler threads each pass's `cursorId` into the next, so a page
 *   full of held or failing rows cannot starve the rows behind it.
 * @param skipWhenEmpty - the scheduler's flag; see {@link RetentionRunOutcome}.
 */
export async function runRetentionPass(input: {
  retentionClass: GuestRetentionClass;
  now: Date;
  afterId?: string | null;
  skipWhenEmpty?: boolean;
}): Promise<RetentionRunOutcome> {
  if (CARRIED_MINIMIZATION_CLASSES[input.retentionClass] !== undefined) {
    return { outcome: 'refused', reason: 'performed_by_contact_pass' };
  }
  if (!MINIMIZATION_CLASSES.includes(input.retentionClass)) {
    return { outcome: 'refused', reason: 'mechanism_not_minimization' };
  }
  const db = getDb();
  const rules = await readActiveRetentionRules(db);
  const rule = rules.find((entry) => entry.retentionClass === input.retentionClass);
  if (rule === undefined || rule.retentionSeconds === null) {
    return { outcome: 'refused', reason: 'policy_missing' };
  }
  if (rule.mechanism !== 'minimization_job') {
    return { outcome: 'refused', reason: 'mechanism_not_minimization' };
  }

  const mode = config.guest.governance.retentionDryRun ? 'dry_run' : 'apply';

  const held = new Set<string>();
  if (rule.pausableByLegalHold) {
    for (const holdingClass of holdingClassesFor(input.retentionClass)) {
      for (const group of await readHeldCheckoutGroups(db, holdingClass)) held.add(group);
    }
  }
  const cutoff = new Date(input.now.getTime() - rule.retentionSeconds * 1000);

  let runId = null as string | null;
  let examined = 0;
  let minimized = 0;
  let skippedHeld = 0;
  let failed = 0;
  let cursorId: string | null = null;

  try {
    await db.transaction(async (tx) => {
      const candidates = await selectCandidates(tx, {
        retentionClass: input.retentionClass,
        cutoff,
        afterId: input.afterId ?? null,
        limit: config.guest.governance.retentionBatchSize,
      });
      if (candidates.length === 0 && input.skipWhenEmpty === true) return;

      // On the ROOT connection, so the run row is committed whatever this
      // transaction does: a page that rolls back still leaves the record that
      // it was attempted, closed `failed` below.
      runId = await openRetentionRun(db, {
        retentionClass: input.retentionClass,
        policyVersion: rule.version,
        mode,
        now: input.now,
      });

      for (const candidate of candidates) {
        examined += 1;
        cursorId = candidate.id;
        if (held.has(candidate.checkoutGroupId)) {
          skippedHeld += 1;
          continue;
        }
        if (mode === 'dry_run') {
          // A dry run reports what it WOULD do, and `minimized` is the honest
          // counter for it: #60's rule that a dry-run outcome is a PREDICTION,
          // and refusing to record one would make the mode unable to report the
          // counts it exists for. The CHECK that forbids a dry run reporting a
          // DELETE is what keeps the two modes distinguishable.
          minimized += 1;
          continue;
        }
        try {
          // The row is locked by this transaction, so the CAS inside can only
          // miss if the row was anonymized before the page was read — which
          // the selection excludes. Counted as minimized either way: the row
          // examined IS minimized when this returns.
          await tx.transaction(async (savepoint) =>
            minimizeGuestCheckoutContact(savepoint, candidate.id, input.now),
          );
          minimized += 1;
        } catch (error: unknown) {
          // Per-record isolation, #60's `examineSubject`: a pass that aborted on
          // its worst row would leave the cursor stuck there forever. The log
          // carries the ROW id and never a value from it.
          failed += 1;
          log.guest.error(
            { err: error, guestCheckoutId: candidate.id, retentionClass: input.retentionClass },
            '[GuestRetention] failed to minimize one contact',
          );
        }
      }
    });
  } catch (error: unknown) {
    // A PAGE-level failure is different from a record-level one: the
    // transaction rolled back, so nothing on the page was minimized whatever
    // the loop had counted, the cursor is not advanced, and the run is closed
    // `failed` so the next pass retries from where this one started.
    if (runId !== null) {
      await closeRetentionRun(db, {
        runId,
        status: 'failed',
        examined,
        minimized: 0,
        deleted: 0,
        skippedHeld,
        failed: examined - skippedHeld,
        cursorId: null,
        failureCode: 'page_failure',
        now: new Date(),
      });
    }
    log.guest.error(
      { err: error, retentionClass: input.retentionClass },
      '[GuestRetention] a retention pass failed',
    );
    throw error;
  }

  if (runId === null) return { outcome: 'idle' };

  await closeRetentionRun(db, {
    runId,
    status: 'completed',
    examined,
    minimized,
    deleted: 0,
    skippedHeld,
    failed,
    cursorId,
    now: new Date(),
  });

  return {
    outcome: 'ran',
    result: {
      runId,
      retentionClass: input.retentionClass,
      mode,
      examined,
      minimized,
      skippedHeld,
      failed,
      cursorId,
    },
  };
}

/** One row a pass may act on. */
interface RetentionCandidate {
  readonly id: string;
  readonly checkoutGroupId: string;
}

/**
 * The candidates for one class, LOCKED by the caller's transaction.
 *
 * The two classes select DIFFERENT sets and the difference is the whole policy:
 *
 *  - `unpaid_pending_checkout` — a contact whose group produced NO order. Its
 *    clock runs from creation, because nothing else ever happened to it.
 *  - `plaintext_equivalent_contact` — a contact whose group DID produce orders.
 *    Its clock runs from creation too, but with a far longer retention, and the
 *    order stays exactly where it is: #106 kept the snapshot off the immutable
 *    order precisely so this erasure can reach the contact without touching the
 *    commercial record.
 *
 * Both exclude rows already anonymized, so a repeated pass converges rather
 * than re-counting work it already did — and both order by `id` after the
 * keyset cursor, so a resumed pass is deterministic. `SKIP LOCKED` hands a row
 * another task is already holding to nobody rather than to two.
 */
async function selectCandidates(
  tx: DatabaseOrTransaction,
  input: {
    retentionClass: GuestRetentionClass;
    cutoff: Date;
    afterId: string | null;
    limit: number;
  },
): Promise<readonly RetentionCandidate[]> {
  const groupsWithOrders = tx
    .select({ checkoutGroupId: orders.checkoutGroupId })
    .from(orders)
    .where(isNotNull(orders.checkoutGroupId));

  return tx
    .select({
      id: guestCheckouts.id,
      checkoutGroupId: guestCheckouts.checkoutGroupId,
    })
    .from(guestCheckouts)
    .where(
      and(
        isNull(guestCheckouts.anonymizedAt),
        lt(guestCheckouts.createdAt, input.cutoff),
        input.afterId === null ? undefined : gt(guestCheckouts.id, input.afterId),
        input.retentionClass === 'unpaid_pending_checkout'
          ? notInArray(guestCheckouts.checkoutGroupId, groupsWithOrders)
          : sql`${guestCheckouts.checkoutGroupId} in ${groupsWithOrders}`,
      ),
    )
    .orderBy(asc(guestCheckouts.id))
    .limit(input.limit)
    .for('update', { skipLocked: true });
}

/**
 * The published schedule this deployment would apply if somebody activated the
 * code constant as a policy version.
 *
 * Exported so the operator surface can show what a `POST` would publish, and so
 * `retention-policy-census.test.ts` can compare the constant against what is
 * ACTIVE. It is deliberately not what the job reads.
 */
export function proposedRetentionRules(): readonly ActiveRetentionRule[] {
  return GUEST_RETENTION_SCHEDULE.map((definition) => ({
    retentionClass: definition.retentionClass,
    version: 'proposed',
    retentionSeconds: definition.retentionSeconds,
    mechanism: definition.mechanism,
    pausableByLegalHold: definition.pausableByLegalHold,
    rationale: definition.rationale,
  }));
}

/* -------------------------------------------------------------------------- */
/*  The scheduled loop (M8-02)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How many pages one tick may take per class. Bounded, like every sweep here: a
 * cold start after an outage drains over several ticks rather than holding one
 * long run, and the next tick resumes from the oldest row because the
 * selection excludes everything already minimized.
 */
export const MAX_RETENTION_PAGES_PER_TICK = 20;

/**
 * One tick of the scheduled job: every minimization class with an APPROVED,
 * ACTIVE policy row, drained page by page.
 *
 * Only a class whose active rule says `minimization_job` runs — the recorded
 * decision is that retention executes under a PUBLISHED policy and never under
 * the code constant, so a deployment where `POST /governance/retention-policy`
 * has not been called runs nothing and writes nothing (`runRetentionPass` would
 * answer `policy_missing` for each). The policy row is the switch; there is
 * deliberately no environment flag in front of it.
 *
 * Exported so a test and an operator drive exactly what the timer drives.
 */
export async function runScheduledRetention(
  now: Date = new Date(),
): Promise<readonly RetentionRunResult[]> {
  const rules = await readActiveRetentionRules(getDb());
  const results: RetentionRunResult[] = [];
  for (const retentionClass of MINIMIZATION_CLASSES) {
    const rule = rules.find((entry) => entry.retentionClass === retentionClass);
    if (rule === undefined || rule.mechanism !== 'minimization_job') continue;

    let afterId: string | null = null;
    for (let page = 0; page < MAX_RETENTION_PAGES_PER_TICK; page += 1) {
      const outcome = await runRetentionPass({ retentionClass, now, afterId, skipWhenEmpty: true });
      if (outcome.outcome !== 'ran') break;
      results.push(outcome.result);
      if (
        outcome.result.cursorId === null ||
        outcome.result.examined < config.guest.governance.retentionBatchSize
      ) {
        break;
      }
      afterId = outcome.result.cursorId;
    }
  }
  return results;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const results = await runScheduledRetention();
    if (results.length > 0) {
      log.guest.info(
        {
          passes: results.length,
          examined: results.reduce((sum, result) => sum + result.examined, 0),
          minimized: results.reduce((sum, result) => sum + result.minimized, 0),
          skippedHeld: results.reduce((sum, result) => sum + result.skippedHeld, 0),
          failed: results.reduce((sum, result) => sum + result.failed, 0),
        },
        '[GuestRetention] scheduled minimization tick',
      );
    }
  } catch (error: unknown) {
    // Logged and swallowed so the timer survives. Nothing is lost: the deadline
    // is `created_at` plus the published figure, so the next tick finds exactly
    // the rows this one did not finish.
    log.guest.error({ err: error }, '[GuestRetention] scheduled tick failed; will retry');
  } finally {
    running = false;
  }
}

/**
 * Start the scheduled contact-minimization loop (M8-02). Idempotent.
 *
 * Before the M8 review this loop did not exist while the configuration and two
 * docblocks said it did. It runs on EVERY task, like the expiry sweeper it sits
 * beside: the page is taken `FOR UPDATE SKIP LOCKED`, so N tasks share it, and
 * a leader would only add a way for nobody to minimize at all. It is started
 * UNCONDITIONALLY — no environment variable gates it. What decides whether it
 * erases anything is the published retention policy, which is an attributable,
 * versioned operator act rather than a deployment setting.
 */
export function startGuestRetentionLoop(): void {
  if (timer !== undefined) return;
  timer = setInterval(() => {
    void tick();
  }, config.guest.governance.retentionPollIntervalMs);
  // Never hold the event loop open for a poll — `~/Oxy/AGENTS.md`.
  timer.unref?.();
  log.guest.info('[GuestRetention] scheduled contact-minimization loop started');
}

/** Stop the loop. A pass already in flight finishes its page. */
export function stopGuestRetentionLoop(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
