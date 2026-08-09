/**
 * `moderation_enforcements` — the ledger of what Mercaria did, and the lock that
 * makes it happen exactly once.
 *
 * ## The claim is an INSERT, and losing it is the answer
 *
 * `UNIQUE(decision_id, revision, action)` IS the idempotency key. Each action
 * claims its row BEFORE acting; a second attempt — a redelivered webhook, a
 * reclaimed outbox lease, an operator replay — loses the insert and does nothing.
 * Reading "have I done this?" and then acting leaves a gap between the two, and
 * that gap is precisely when a redelivery arrives.
 *
 * `ON CONFLICT DO NOTHING … RETURNING` reports the loss as an empty result rather
 * than as an exception to classify, so a duplicate and a database failure are
 * structurally distinguishable: the first returns `null`, the second throws. Under
 * Mongo both arrived as errors and were told apart by `code === 11000`, one
 * mis-widened `catch` away from treating an outage as "already enforced".
 *
 * ## `revision` is IN the key, not merely stored beside it
 *
 * A correction (an accepted appeal) arrives as a NEW revision of the same
 * decision, and its `restore` has to be a different action from the `restrict` it
 * supersedes. Drop `revision` from the key and the restore collides with the
 * removal, loses, and the seller's listing stays down forever — with the case
 * saying it was fine and no error anywhere.
 *
 * ## `previous_state` is three columns, and each effect writes exactly one
 *
 * Never partially updated, and never `jsonb`: `restore` reads these back and
 * writes them straight into `listings.status` / `reviews.status`, so the schema
 * CHECKs them against the SAME value sets those destination columns use. A bad
 * value therefore fails the write that CREATED it rather than the restore that
 * needs it — which is when a seller is waiting for their listing back.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  AbuseReportedType,
  ListingStatus,
  ModerationEnforcementAction,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import type { REVIEW_STATUSES } from '../schema/reviews.js';
import { moderationEnforcements } from '../schema/moderation.js';

/** `reviews.status` — the value set `restore` may put back. */
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * What an effect displaced, so a reversal has something true to put back.
 *
 * Each effect writes exactly one of the three: `restrict`/`request_changes` on a
 * listing writes `listingStatus`, `restrict` on a review writes `reviewStatus`,
 * and `freeze_transaction` writes `heldOrderIds`.
 */
export interface EnforcementPreviousState {
  listingStatus?: ListingStatus;
  reviewStatus?: ReviewStatus;
  heldOrderIds?: string[];
}

/** One row of the enforcement ledger, with absent optionals as `undefined`. */
export interface ModerationEnforcementRecord {
  id: string;
  decisionId: string;
  revision: number;
  action: ModerationEnforcementAction;
  caseId?: string;
  subjectType: AbuseReportedType;
  subjectId: string;
  applied: boolean;
  reason: string;
  recommendedAction?: string;
  previousState: EnforcementPreviousState;
  createdAt: Date;
  updatedAt: Date;
}

type EnforcementRow = typeof moderationEnforcements.$inferSelect;

function toRecord(row: EnforcementRow): ModerationEnforcementRecord {
  return {
    id: row.id,
    decisionId: row.decisionId,
    revision: row.revision,
    action: row.action,
    ...(row.caseId === null ? {} : { caseId: row.caseId }),
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    applied: row.applied,
    reason: row.reason,
    ...(row.recommendedAction === null ? {} : { recommendedAction: row.recommendedAction }),
    previousState: {
      ...(row.previousStateListingStatus === null
        ? {}
        : { listingStatus: row.previousStateListingStatus }),
      ...(row.previousStateReviewStatus === null
        ? {}
        : { reviewStatus: row.previousStateReviewStatus }),
      ...(row.previousStateHeldOrderIds === null
        ? {}
        : { heldOrderIds: row.previousStateHeldOrderIds }),
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Claim one `decisionId + revision + action`, or lose to whoever already has it.
 *
 * The row is written with the outcome the caller INTENDS (`applied: false` plus a
 * reason), and the effect is attempted only after the claim is held. So a crash
 * between the claim and the effect leaves evidence that the action was owned,
 * which is what {@link deleteModerationEnforcement} exists to undo when the effect
 * itself throws.
 *
 * @returns The claimed row, or `null` when another delivery of this exact decision
 *   revision already owns the action. Never both — and an error means the store
 *   could not answer, which is a third thing again.
 */
export async function claimModerationEnforcement(
  input: {
    decisionId: string;
    revision: number;
    action: ModerationEnforcementAction;
    caseId?: string;
    subjectType: AbuseReportedType;
    subjectId: string;
    reason: string;
    recommendedAction?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ModerationEnforcementRecord | null> {
  const claimed = await db
    .insert(moderationEnforcements)
    .values({
      decisionId: input.decisionId,
      revision: input.revision,
      action: input.action,
      caseId: input.caseId ?? null,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      applied: false,
      reason: input.reason,
      recommendedAction: input.recommendedAction ?? null,
    })
    // `revision` stays in the conflict target. Dropping it would make a
    // correction's `restore` collide with the `restrict` it supersedes, so an
    // accepted appeal could never relist the item.
    .onConflictDoNothing({
      target: [
        moderationEnforcements.decisionId,
        moderationEnforcements.revision,
        moderationEnforcements.action,
      ],
    })
    .returning();

  return claimed[0] ? toRecord(claimed[0]) : null;
}

/** Record that the effect really happened, and what it displaced. */
export async function markModerationEnforcementApplied(
  id: string,
  previousState: EnforcementPreviousState,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(moderationEnforcements)
    .set({
      applied: true,
      // Written explicitly, all three, so a second write cannot leave a stale
      // half of a previous state beside a fresh one. Exactly one is ever
      // non-null in practice; the other two say so.
      previousStateListingStatus: previousState.listingStatus ?? null,
      previousStateReviewStatus: previousState.reviewStatus ?? null,
      previousStateHeldOrderIds: previousState.heldOrderIds ?? null,
    })
    .where(eq(moderationEnforcements.id, id));
}

/**
 * Record that the action was claimed and deliberately did nothing, with the
 * reason.
 *
 * `applied: false` covers three genuinely different situations — observe/manual
 * mode declined to act, there was nothing to undo, the object no longer exists —
 * which is why the reason is NOT NULL beside it. All three are evidence; none is a
 * failure.
 */
export async function recordModerationEnforcementNotApplied(
  id: string,
  reason: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(moderationEnforcements)
    .set({ applied: false, reason })
    .where(eq(moderationEnforcements.id, id));
}

/**
 * Release a claim whose effect THREW.
 *
 * Otherwise that action could never be retried and the subject would stay in
 * whatever half-state the failure left it. Being releasable is the whole reason
 * the claim is a row rather than a flag.
 */
export async function deleteModerationEnforcement(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.delete(moderationEnforcements).where(eq(moderationEnforcements.id, id));
}

/**
 * The most recent enforcement whose effect really happened against this subject.
 *
 * `applied` is filtered, not merely preferred, and the partial index
 * `moderation_enforcements_subject_created_at_idx` is `WHERE applied` for exactly
 * this query. The filter is what makes a restore read the truth: an observe-mode
 * deployment records a row for every decision, so the NEWEST row about a subject
 * is routinely one that changed nothing — and restoring from its `previousState`
 * would publish a listing whose seller had only ever kept it as a draft.
 */
export async function findLatestAppliedEnforcement(
  subjectType: AbuseReportedType,
  subjectId: string,
  actions: readonly ModerationEnforcementAction[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ModerationEnforcementRecord | undefined> {
  const [row] = await db
    .select()
    .from(moderationEnforcements)
    .where(
      and(
        eq(moderationEnforcements.subjectType, subjectType),
        eq(moderationEnforcements.subjectId, subjectId),
        // `inArray`, never `= any(array)`: the latter binds a TUPLE and Postgres
        // raises `op ANY/ALL (array) requires array on right side`.
        inArray(moderationEnforcements.action, [...actions]),
        eq(moderationEnforcements.applied, true),
      ),
    )
    // `id` breaks the tie: two rows written in the same millisecond share
    // `created_at` exactly, and `desc` alone would leave which one wins to the
    // planner. Both are v7 ids, so id order IS write order within that
    // millisecond.
    .orderBy(desc(moderationEnforcements.createdAt), desc(moderationEnforcements.id))
    .limit(1);
  return row ? toRecord(row) : undefined;
}
