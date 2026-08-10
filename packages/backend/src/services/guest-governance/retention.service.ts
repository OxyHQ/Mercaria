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

import { and, asc, eq, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { GuestRetentionClass } from '@mercaria/shared-types';
import { GUEST_RETENTION_SCHEDULE } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import { guestCheckouts } from '../../db/schema/guests.js';
import { orders } from '../../db/schema/orders.js';
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
 */
export type RetentionRunOutcome =
  | { readonly outcome: 'ran'; readonly result: RetentionRunResult }
  | {
      readonly outcome: 'refused';
      readonly reason: 'policy_missing' | 'mechanism_not_minimization';
    };

/** The classes this job performs. Every other class is the expiry sweep's. */
const MINIMIZATION_CLASSES: readonly GuestRetentionClass[] = [
  'unpaid_pending_checkout',
  'plaintext_equivalent_contact',
];

/** Every class this job performs, exported so the scheduler and the tests agree. */
export function minimizationClasses(): readonly GuestRetentionClass[] {
  return MINIMIZATION_CLASSES;
}

/**
 * Run one bounded pass over one class.
 *
 * Refuses when no version of the policy is ACTIVE for that class, rather than
 * falling back to the code constant beside it. `GUEST_RETENTION_SCHEDULE` is
 * what somebody PUBLISHES; a job that read it directly would make the published
 * version decorative and would delete under a rule nobody approved — the
 * `#58 policy_missing` posture, applied to a deletion.
 */
export async function runRetentionPass(input: {
  retentionClass: GuestRetentionClass;
  now: Date;
}): Promise<RetentionRunOutcome> {
  if (!MINIMIZATION_CLASSES.includes(input.retentionClass)) {
    return { outcome: 'refused', reason: 'mechanism_not_minimization' };
  }
  const db = getDb();
  const rules = await readActiveRetentionRules(db);
  const rule = rules.find((entry) => entry.retentionClass === input.retentionClass);
  if (rule === undefined || rule.retentionSeconds === null) {
    return { outcome: 'refused', reason: 'policy_missing' };
  }

  const mode = config.guest.governance.retentionDryRun ? 'dry_run' : 'apply';
  const runId = await openRetentionRun(db, {
    retentionClass: input.retentionClass,
    policyVersion: rule.version,
    mode,
    now: input.now,
  });

  const held = rule.pausableByLegalHold
    ? await readHeldCheckoutGroups(db, input.retentionClass)
    : [];
  const cutoff = new Date(input.now.getTime() - rule.retentionSeconds * 1000);

  let examined = 0;
  let minimized = 0;
  let skippedHeld = 0;
  let failed = 0;
  let cursorId: string | null = null;

  try {
    const candidates = await selectCandidates({
      retentionClass: input.retentionClass,
      cutoff,
      limit: config.guest.governance.retentionBatchSize,
    });

    for (const candidate of candidates) {
      examined += 1;
      cursorId = candidate.id;
      if (held.includes(candidate.checkoutGroupId)) {
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
        await minimizeGuestContact(candidate.id, input.now);
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
  } catch (error: unknown) {
    // A PAGE-level failure is different from a record-level one: the cursor is
    // not advanced and the run is closed `failed`, so the next pass retries
    // from where this one started.
    await closeRetentionRun(db, {
      runId,
      status: 'failed',
      examined,
      minimized,
      deleted: 0,
      skippedHeld,
      failed: examined - minimized - skippedHeld,
      cursorId: null,
      failureCode: 'page_failure',
      now: new Date(),
    });
    log.guest.error(
      { err: error, retentionClass: input.retentionClass },
      '[GuestRetention] a retention pass failed',
    );
    throw error;
  }

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
 * The candidates for one class.
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
 * than re-counting work it already did — and both order by `id`, so a resumed
 * pass is deterministic.
 */
async function selectCandidates(input: {
  retentionClass: GuestRetentionClass;
  cutoff: Date;
  limit: number;
}): Promise<readonly RetentionCandidate[]> {
  const db = getDb();
  const groupsWithOrders = db
    .select({ checkoutGroupId: orders.checkoutGroupId })
    .from(orders)
    .where(isNotNull(orders.checkoutGroupId));

  const rows = await db
    .select({
      id: guestCheckouts.id,
      checkoutGroupId: guestCheckouts.checkoutGroupId,
    })
    .from(guestCheckouts)
    .where(
      and(
        isNull(guestCheckouts.anonymizedAt),
        lt(guestCheckouts.createdAt, input.cutoff),
        input.retentionClass === 'unpaid_pending_checkout'
          ? notInArray(guestCheckouts.checkoutGroupId, groupsWithOrders)
          : sql`${guestCheckouts.checkoutGroupId} in ${groupsWithOrders}`,
      ),
    )
    .orderBy(asc(guestCheckouts.id))
    .limit(input.limit);
  return rows;
}

/**
 * Erase one contact in place (ADR 0003 D15).
 *
 * All four columns in ONE statement, because `guest_checkouts_anonymization_check`
 * states the transition WHOLE — once `anonymized_at` is set there must be no
 * ciphertext, no hash and no phone left. Writing them one at a time would fail
 * the CHECK on the first partial state, which is the constraint working: an
 * anonymization that half-happened is a deletion record that did not delete.
 *
 * `emailRedacted` becomes the literal `deleted` rather than being nulled — the
 * column is NOT NULL and the display form is what a merchant's order view
 * renders, so the honest value is a word saying the address is gone rather than
 * an empty string that reads as a rendering bug.
 */
async function minimizeGuestContact(guestCheckoutId: string, now: Date): Promise<void> {
  await getDb()
    .update(guestCheckouts)
    .set({
      emailCiphertext: null,
      emailHash: null,
      phoneCiphertext: null,
      phoneRedacted: null,
      emailRedacted: 'deleted',
      anonymizedAt: now,
    })
    .where(and(eq(guestCheckouts.id, guestCheckoutId), isNull(guestCheckouts.anonymizedAt)));
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
