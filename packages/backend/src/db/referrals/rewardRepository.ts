/**
 * Reads and writes for `referral_rewards` and `referral_reward_adjustments`
 * (#144).
 *
 * Two idempotency guarantees live here and both are the DATABASE's, not a
 * check:
 *
 *  - **A conversion pays at most one reward.** The insert is
 *    `ON CONFLICT DO NOTHING` on `UNIQUE(conversion_id)` plus a re-read, so a
 *    retried conversion converges on the row it already made. A read-then-write
 *    would satisfy the words of "idempotent duplicate conversion" and fail the
 *    two cases that happen: a double dispatch and a retry after a timeout the
 *    caller never saw.
 *  - **A reversal applies at most once.** The adjustment's idempotency key is
 *    deterministic from `(reward, cause, source)` and the insert is the same
 *    shape. The empty `RETURNING` set IS the "already applied" answer, so a
 *    dropped connection still propagates instead of reading as a duplicate.
 *
 * The net is recomputed from the base and WRITTEN, never incremented: an
 * accumulating net drifts, while `net = f(base)` computed afresh reconciles
 * exactly every time and makes `Σ deltas + gross == net` an identity rather
 * than a hope.
 */

import { and, asc, desc, eq, gte, ne, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  ReferralFundingSourceId,
  ReferralRewardRecoveryState,
  ReferralRewardReversalCause,
  ReferralRewardState,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  referralRewardAdjustments,
  referralRewardRules,
  referralRewards,
} from '../schema/referralRewards.js';

/** A reward row as the services read it back. */
export type ReferralRewardRow = typeof referralRewards.$inferSelect;

/** An adjustment row as the services read it back. */
export type ReferralRewardAdjustmentRow = typeof referralRewardAdjustments.$inferSelect;

/**
 * The deterministic idempotency key of one reversal — stated ONCE, here, so
 * every deriver and every test computes the same spelling.
 *
 * The cause is IN the key: a partial refund and a later fraud finding against
 * the same order are two different reversals of one reward and must both be
 * recordable, exactly as `moderation_enforcements` puts the action in its key
 * so a correction's `restore` is not swallowed by the removal it supersedes.
 */
export function rewardAdjustmentIdempotencyKey(input: {
  rewardId: string;
  cause: ReferralRewardReversalCause;
  sourceRef: string;
}): string {
  return `refrewrev:${input.rewardId}:${input.cause}:${input.sourceRef}`;
}

/** Everything a reward is born with. `state` is always `held`. */
export interface CreateRewardInput {
  conversionId: string;
  attributionId: string;
  partnerId: string;
  programVersionId: string;
  ruleVersionId: string;
  fundingSourceId: ReferralFundingSourceId;
  fundingRecordRef: string;
  fundingRecordVersion: string;
  fundingAmountMinor: number;
  fundingObservedAt: Date;
  campaignBudgetId?: string;
  grossAmountMinor: number;
  currency: CurrencyCode;
  accruedAt: Date;
  holdUntilAt: Date;
}

/**
 * Accrue a reward, converging on the row a replay already made.
 *
 * The arbiter is named (`conversion_id`) because this table carries exactly one
 * unique index over the fact — unlike `referral_conversions`, whose two indexes
 * over one fact forced an arbiter-less `DO NOTHING`.
 */
export async function insertReward(
  db: DatabaseOrTransaction,
  input: CreateRewardInput,
): Promise<{ row: ReferralRewardRow; created: boolean }> {
  const [inserted] = await db
    .insert(referralRewards)
    .values({
      conversionId: input.conversionId,
      attributionId: input.attributionId,
      partnerId: input.partnerId,
      programVersionId: input.programVersionId,
      ruleVersionId: input.ruleVersionId,
      fundingSourceId: input.fundingSourceId,
      fundingRecordRef: input.fundingRecordRef,
      fundingRecordVersion: input.fundingRecordVersion,
      fundingAmountMinor: input.fundingAmountMinor,
      fundingObservedAt: input.fundingObservedAt,
      campaignBudgetId: input.campaignBudgetId ?? null,
      grossAmountMinor: input.grossAmountMinor,
      netAmountMinor: input.grossAmountMinor,
      currency: input.currency,
      state: 'held',
      accruedAt: input.accruedAt,
      holdUntilAt: input.holdUntilAt,
    })
    .onConflictDoNothing({ target: referralRewards.conversionId })
    .returning();
  if (inserted) return { row: inserted, created: true };

  const existing = await findRewardByConversion(db, input.conversionId);
  if (!existing) {
    throw new Error(
      `referral_rewards insert for conversion ${input.conversionId} conflicted with a row ` +
        'that then could not be read back.',
    );
  }
  return { row: existing, created: false };
}

export async function findRewardById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralRewardRow | undefined> {
  const [row] = await db.select().from(referralRewards).where(eq(referralRewards.id, id));
  return row;
}

export async function findRewardByConversion(
  db: DatabaseOrTransaction,
  conversionId: string,
): Promise<ReferralRewardRow | undefined> {
  const [row] = await db
    .select()
    .from(referralRewards)
    .where(eq(referralRewards.conversionId, conversionId));
  return row;
}

/**
 * Every reward drawn from one funding record — the reversal path's entry point.
 *
 * A refund names a payment, not a reward, so the handler asks "what did this
 * payment's commission fund" rather than being told. Voided rewards are
 * excluded: there is nothing left to reverse.
 */
export async function listRewardsForFundingRecord(
  db: DatabaseOrTransaction,
  input: { fundingSourceId: ReferralFundingSourceId; fundingRecordRef: string },
): Promise<ReferralRewardRow[]> {
  return await db
    .select()
    .from(referralRewards)
    .where(
      and(
        eq(referralRewards.fundingSourceId, input.fundingSourceId),
        eq(referralRewards.fundingRecordRef, input.fundingRecordRef),
        ne(referralRewards.state, 'voided'),
      ),
    )
    .orderBy(asc(referralRewards.accruedAt));
}

/** One partner's rewards, newest first — the partner-safe projection's source. */
export async function listRewardsByPartner(
  db: DatabaseOrTransaction,
  partnerId: string,
  limit = 50,
): Promise<ReferralRewardRow[]> {
  return await db
    .select()
    .from(referralRewards)
    .where(eq(referralRewards.partnerId, partnerId))
    .orderBy(desc(referralRewards.accruedAt))
    .limit(limit);
}

/**
 * What one partner has accrued in one currency since an instant — the
 * per-partner period cap's input (#144 field 10).
 *
 * Sums the NET rather than the gross: a reward reduced by a refund has released
 * that much of the partner's allowance, which is the reading under which a cap
 * bounds what Mercaria actually owes. Voided rewards contribute nothing and are
 * excluded by their own zero net rather than by a filter.
 */
export async function sumPartnerAccruals(
  db: DatabaseOrTransaction,
  input: { partnerId: string; currency: CurrencyCode; since?: Date },
): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${referralRewards.netAmountMinor}), 0)` })
    .from(referralRewards)
    .where(
      and(
        eq(referralRewards.partnerId, input.partnerId),
        eq(referralRewards.currency, input.currency),
        ...(input.since ? [gte(referralRewards.accruedAt, input.since)] : []),
      ),
    );
  return Number(row.total);
}

/**
 * What one campaign has accrued in one currency — the campaign cap's input.
 *
 * Joined to the RULE rather than read off a denormalized column on the reward:
 * a campaign spans several rule versions, and a copy of the campaign ref on
 * every reward would be a second representation of a fact the immutable rule
 * already carries.
 */
export async function sumCampaignAccruals(
  db: DatabaseOrTransaction,
  input: { campaignRef: string; currency: CurrencyCode },
): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${referralRewards.netAmountMinor}), 0)` })
    .from(referralRewards)
    .innerJoin(referralRewardRules, eq(referralRewardRules.id, referralRewards.ruleVersionId))
    .where(
      and(
        eq(referralRewardRules.campaignRef, input.campaignRef),
        eq(referralRewards.currency, input.currency),
      ),
    );
  return Number(row.total);
}

/**
 * Apply one reversal: append the adjustment and write the recomputed net.
 *
 * Both statements in the CALLER's transaction, deliberately — the amount and
 * the record of why it changed must commit together, or a crash between them
 * leaves a reward whose net nothing explains.
 *
 * @returns `created: false` when this exact reversal was already applied, in
 *   which case NOTHING is written: the reward's net is left exactly as the
 *   first application left it. Re-writing the same value would move
 *   `updated_at` and make a genuine no-op indistinguishable from a second
 *   reversal that happened to compute the same figure.
 */
export async function appendRewardAdjustment(
  db: DatabaseOrTransaction,
  input: {
    rewardId: string;
    cause: ReferralRewardReversalCause;
    sourceRef: string;
    deltaAmountMinor: number;
    resultingNetMinor: number;
    observedFundingAmountMinor: number;
    currency: CurrencyCode;
    recoveryState: ReferralRewardRecoveryState;
    liabilityAmountMinor: number;
    reason: string;
    occurredAt: Date;
    /** The state the reward takes on. `voided` when the net reached zero. */
    rewardState: ReferralRewardState;
    voidedAt?: Date;
  },
): Promise<{ adjustment: ReferralRewardAdjustmentRow; created: boolean }> {
  const idempotencyKey = rewardAdjustmentIdempotencyKey({
    rewardId: input.rewardId,
    cause: input.cause,
    sourceRef: input.sourceRef,
  });

  const [inserted] = await db
    .insert(referralRewardAdjustments)
    .values({
      rewardId: input.rewardId,
      cause: input.cause,
      sourceRef: input.sourceRef,
      idempotencyKey,
      deltaAmountMinor: input.deltaAmountMinor,
      resultingNetMinor: input.resultingNetMinor,
      observedFundingAmountMinor: input.observedFundingAmountMinor,
      currency: input.currency,
      recoveryState: input.recoveryState,
      liabilityAmountMinor: input.liabilityAmountMinor,
      reason: input.reason,
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing({ target: referralRewardAdjustments.idempotencyKey })
    .returning();

  if (!inserted) {
    const [existing] = await db
      .select()
      .from(referralRewardAdjustments)
      .where(eq(referralRewardAdjustments.idempotencyKey, idempotencyKey));
    if (!existing) {
      throw new Error(
        `referral_reward_adjustments insert for ${idempotencyKey} conflicted with a row that ` +
          'then could not be read back.',
      );
    }
    return { adjustment: existing, created: false };
  }

  await db
    .update(referralRewards)
    .set({
      netAmountMinor: input.resultingNetMinor,
      state: input.rewardState,
      // `frozen_from_state` is present exactly when the state is `frozen` (a
      // CHECK), so voiding a frozen reward must clear it in the SAME statement
      // — otherwise the write is refused with `23514` and the reversal, which
      // is the thing that had to happen, is the thing that fails.
      ...(input.rewardState === 'voided'
        ? { voidedAt: input.voidedAt ?? input.occurredAt, frozenFromState: null }
        : {}),
    })
    .where(eq(referralRewards.id, input.rewardId));

  return { adjustment: inserted, created: true };
}

/** One reward's adjustments, oldest first — the append-only trail as recorded. */
export async function listRewardAdjustments(
  db: DatabaseOrTransaction,
  rewardId: string,
): Promise<ReferralRewardAdjustmentRow[]> {
  return await db
    .select()
    .from(referralRewardAdjustments)
    .where(eq(referralRewardAdjustments.rewardId, rewardId))
    .orderBy(asc(referralRewardAdjustments.createdAt), asc(referralRewardAdjustments.id));
}
