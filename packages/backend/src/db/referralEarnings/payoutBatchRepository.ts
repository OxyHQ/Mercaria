/**
 * `referral_payout_batches` and `referral_payout_batch_items` (#145 "Payout
 * batches").
 *
 * Two properties live here and neither is a check somebody remembered:
 *
 *  - **One OPEN batch per partner per currency.** `referral_payout_batches_open_key`
 *    is a partial unique, so a second builder is refused by the database and the
 *    empty `RETURNING` set IS the refusal.
 *  - **One LIVE claim per reward, ever.** `referral_payout_batch_items_live_reward_key`
 *    is a partial unique on `(reward_id) WHERE released_at IS NULL`, so a reward
 *    already in a batch cannot enter a second one — which is what makes a
 *    duplicate payout unrepresentable rather than unlikely.
 *
 * Every status change is a compare-and-swap on the status the caller expected,
 * so a retry, a concurrent operator and the construction loop converge on one
 * outcome rather than each writing their own.
 */

import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  ReferralPayoutBatchStatus,
  ReferralPayoutFailureReason,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  referralPayoutBatchItems,
  referralPayoutBatches,
} from '../schema/referralEarnings.js';

/** A batch row as the services read it back. */
export type ReferralPayoutBatchRow = typeof referralPayoutBatches.$inferSelect;

/** A batch item row as the services read it back. */
export type ReferralPayoutBatchItemRow = typeof referralPayoutBatchItems.$inferSelect;

/**
 * The literal `created_by` a batch the construction LOOP opened carries.
 *
 * Not an Oxy account id and not one anybody can hold, which is exactly what
 * makes `referral_payout_batches_four_eyes_check` real: a loop-built batch can
 * be approved by any operator, and a HAND-built one cannot be approved by the
 * person who built it.
 */
export const REFERRAL_PAYOUT_SYSTEM_ACTOR = 'system';

/**
 * The deterministic idempotency key a rail sees — derived from the batch's own
 * id and therefore byte-identical across every attempt.
 *
 * ADR 0001 D11's rule, one domain over: a retry after a lost response must
 * present the SAME key or the provider treats it as a second payout. A key
 * derived from the attempt, the clock or the amount would differ between two
 * racers and defeat the property it exists for.
 */
export function referralPayoutIdempotencyKey(batchId: string): string {
  return `refpay:${batchId}`;
}

/** Everything a batch is born with. Status is always `draft`. */
export interface OpenPayoutBatchInput {
  batchId: string;
  partnerId: string;
  programId: string;
  currency: CurrencyCode;
  grossEligibleMinor: number;
  withholdingMinor: number;
  createdByOxyUserId: string;
}

/**
 * Open a batch, or refuse because one is already live for this partner and
 * currency.
 *
 * @returns `undefined` when the partial unique refused it. The caller reports
 *   the existing batch rather than retrying: two batches for one partner would
 *   each hold half their rewards and neither total would describe what is owed.
 */
export async function openPayoutBatch(
  db: DatabaseOrTransaction,
  input: OpenPayoutBatchInput,
): Promise<ReferralPayoutBatchRow | undefined> {
  const [row] = await db
    .insert(referralPayoutBatches)
    .values({
      id: input.batchId,
      partnerId: input.partnerId,
      programId: input.programId,
      currency: input.currency,
      status: 'draft',
      grossEligibleMinor: input.grossEligibleMinor,
      withholdingMinor: input.withholdingMinor,
      netPayoutMinor: input.grossEligibleMinor - input.withholdingMinor,
      idempotencyKey: referralPayoutIdempotencyKey(input.batchId),
      createdByOxyUserId: input.createdByOxyUserId,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/**
 * Claim one reward for a batch.
 *
 * @returns `undefined` when the reward is already claimed by a live batch. The
 *   builder skips it and lowers its own total accordingly — it does not retry,
 *   because whichever batch holds it is the one that will pay it.
 */
export async function claimRewardForBatch(
  db: DatabaseOrTransaction,
  input: { batchId: string; rewardId: string; netAmountMinor: number; currency: CurrencyCode },
): Promise<ReferralPayoutBatchItemRow | undefined> {
  const [row] = await db
    .insert(referralPayoutBatchItems)
    .values({
      batchId: input.batchId,
      rewardId: input.rewardId,
      netAmountMinor: input.netAmountMinor,
      currency: input.currency,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/**
 * Hand a cancelled batch's rewards back for a later one.
 *
 * The ONE mutation the item trigger permits, and only NULL → a value: a released
 * item stays in the table forever, so "which batch held this reward in March" is
 * still answerable after the batch that held it was cancelled.
 */
export async function releaseBatchItems(
  db: DatabaseOrTransaction,
  input: { batchId: string; at: Date },
): Promise<number> {
  const rows = await db
    .update(referralPayoutBatchItems)
    .set({ releasedAt: input.at })
    .where(
      and(
        eq(referralPayoutBatchItems.batchId, input.batchId),
        isNull(referralPayoutBatchItems.releasedAt),
      ),
    )
    .returning({ id: referralPayoutBatchItems.id });
  return rows.length;
}

export async function findPayoutBatchById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralPayoutBatchRow | undefined> {
  const [row] = await db
    .select()
    .from(referralPayoutBatches)
    .where(eq(referralPayoutBatches.id, id));
  return row;
}

/** The batch currently holding this partner's rewards in this currency, if any. */
export async function findOpenPayoutBatch(
  db: DatabaseOrTransaction,
  input: { partnerId: string; currency: CurrencyCode },
): Promise<ReferralPayoutBatchRow | undefined> {
  const [row] = await db
    .select()
    .from(referralPayoutBatches)
    .where(
      and(
        eq(referralPayoutBatches.partnerId, input.partnerId),
        eq(referralPayoutBatches.currency, input.currency),
        inArray(referralPayoutBatches.status, ['draft', 'approved', 'processing', 'failed']),
      ),
    );
  return row;
}

/** One batch's items, oldest first. Released ones are INCLUDED — history. */
export async function listPayoutBatchItems(
  db: DatabaseOrTransaction,
  batchId: string,
): Promise<ReferralPayoutBatchItemRow[]> {
  return await db
    .select()
    .from(referralPayoutBatchItems)
    .where(eq(referralPayoutBatchItems.batchId, batchId))
    .orderBy(asc(referralPayoutBatchItems.createdAt), asc(referralPayoutBatchItems.id));
}

/** The items a batch will actually settle — everything it has not released. */
export async function listLivePayoutBatchItems(
  db: DatabaseOrTransaction,
  batchId: string,
): Promise<ReferralPayoutBatchItemRow[]> {
  return await db
    .select()
    .from(referralPayoutBatchItems)
    .where(
      and(
        eq(referralPayoutBatchItems.batchId, batchId),
        isNull(referralPayoutBatchItems.releasedAt),
      ),
    )
    .orderBy(asc(referralPayoutBatchItems.createdAt), asc(referralPayoutBatchItems.id));
}

/** Whether a reward is held by a live batch item right now. */
export async function findLiveClaimForReward(
  db: DatabaseOrTransaction,
  rewardId: string,
): Promise<ReferralPayoutBatchItemRow | undefined> {
  const [row] = await db
    .select()
    .from(referralPayoutBatchItems)
    .where(
      and(
        eq(referralPayoutBatchItems.rewardId, rewardId),
        isNull(referralPayoutBatchItems.releasedAt),
      ),
    );
  return row;
}

/** The live claims over a set of rewards, in ONE statement — the builder's probe. */
export async function findLiveClaimedRewardIds(
  db: DatabaseOrTransaction,
  rewardIds: readonly string[],
): Promise<Set<string>> {
  if (rewardIds.length === 0) return new Set();
  const rows = await db
    .select({ rewardId: referralPayoutBatchItems.rewardId })
    .from(referralPayoutBatchItems)
    .where(
      and(
        inArray(referralPayoutBatchItems.rewardId, [...rewardIds]),
        isNull(referralPayoutBatchItems.releasedAt),
      ),
    );
  return new Set(rows.map((row) => row.rewardId));
}

/** What a batch's live items sum to, from the ITEMS rather than from the header. */
export async function sumLivePayoutBatchItems(
  db: DatabaseOrTransaction,
  batchId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${referralPayoutBatchItems.netAmountMinor}), 0)` })
    .from(referralPayoutBatchItems)
    .where(
      and(
        eq(referralPayoutBatchItems.batchId, batchId),
        isNull(referralPayoutBatchItems.releasedAt),
      ),
    );
  // `sum()` over an int8 column comes back as NUMERIC, which postgres.js hands
  // back as a STRING.
  return Number(row.total);
}

/** What a batch's totals move to. Every field the status it lands in needs. */
export interface PayoutBatchTransitionInput {
  batchId: string;
  expected: readonly ReferralPayoutBatchStatus[];
  to: ReferralPayoutBatchStatus;
  at: Date;
  approvedByOxyUserId?: string;
  cancelledByOxyUserId?: string;
  providerReference?: string;
  failureReason?: ReferralPayoutFailureReason;
  failureDetail?: string;
}

/**
 * Move a batch's status, or refuse.
 *
 * A compare-and-swap on the expected status, so a retry that arrives after
 * somebody else advanced the batch changes nothing and reads `undefined` —
 * rather than dragging a settled batch back to `processing`.
 *
 * The timestamps and the companion columns go in the SAME statement as the
 * status, because `referral_payout_batches_status_times_check` refuses a `paid`
 * row with no `paid_at` or no `provider_reference`. Writing them apart fails the
 * first half of the pair every time.
 *
 * There is deliberately NO parameter for the amounts. `mercaria_referral_payout_batch_guard`
 * freezes them, and a settlement that re-derived a smaller payable set FAILS
 * rather than shrinking (#59's "the set an operator approved is the set that
 * executes") — so a parameter for one would be dead code the database refuses,
 * which is worse than an absent one because it reads as a supported path.
 */
export async function transitionPayoutBatch(
  db: DatabaseOrTransaction,
  input: PayoutBatchTransitionInput,
): Promise<ReferralPayoutBatchRow | undefined> {
  const [row] = await db
    .update(referralPayoutBatches)
    .set({
      status: input.to,
      ...(input.to === 'approved'
        ? { approvedAt: input.at, approvedByOxyUserId: input.approvedByOxyUserId ?? null }
        : {}),
      ...(input.to === 'paid'
        ? { paidAt: input.at, providerReference: input.providerReference ?? null }
        : {}),
      ...(input.to === 'failed'
        ? {
            failedAt: input.at,
            failureReason: input.failureReason ?? null,
            failureDetail: input.failureDetail ?? null,
          }
        : {}),
      ...(input.to === 'cancelled'
        ? {
            cancelledAt: input.at,
            cancelledByOxyUserId: input.cancelledByOxyUserId ?? null,
            failureReason: 'operator_cancelled' as const,
            failureDetail: input.failureDetail ?? null,
          }
        : {}),
    })
    .where(
      and(
        eq(referralPayoutBatches.id, input.batchId),
        inArray(referralPayoutBatches.status, [...input.expected]),
      ),
    )
    .returning();
  return row;
}

/** One partner's batches, newest first — the partner and operator read. */
export async function listPayoutBatchesForPartner(
  db: DatabaseOrTransaction,
  input: { partnerId: string; limit: number },
): Promise<ReferralPayoutBatchRow[]> {
  return await db
    .select()
    .from(referralPayoutBatches)
    .where(eq(referralPayoutBatches.partnerId, input.partnerId))
    .orderBy(desc(referralPayoutBatches.createdAt), desc(referralPayoutBatches.id))
    .limit(input.limit);
}

/** Batches in a given set of statuses — the settlement loop's population. */
export async function listPayoutBatchesInStatus(
  db: DatabaseOrTransaction,
  input: {
    statuses: readonly ReferralPayoutBatchStatus[];
    limit: number;
    /** Only batches whose last attempt is at least this old — the retry backoff. */
    notAttemptedSince?: Date;
  },
): Promise<ReferralPayoutBatchRow[]> {
  if (input.statuses.length === 0) return [];
  return await db
    .select()
    .from(referralPayoutBatches)
    .where(
      and(
        inArray(referralPayoutBatches.status, [...input.statuses]),
        ...(input.notAttemptedSince
          ? [lt(referralPayoutBatches.updatedAt, input.notAttemptedSince)]
          : []),
      ),
    )
    .orderBy(asc(referralPayoutBatches.createdAt), asc(referralPayoutBatches.id))
    .limit(input.limit);
}

/** Paid batches, oldest first — the reconciliation sweep's resumable page. */
export async function listPaidPayoutBatches(
  db: DatabaseOrTransaction,
  input: { partnerId: string; limit: number },
): Promise<ReferralPayoutBatchRow[]> {
  return await db
    .select()
    .from(referralPayoutBatches)
    .where(
      and(
        eq(referralPayoutBatches.partnerId, input.partnerId),
        eq(referralPayoutBatches.status, 'paid'),
      ),
    )
    .orderBy(asc(referralPayoutBatches.paidAt), asc(referralPayoutBatches.id))
    .limit(input.limit);
}
