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

import { and, asc, desc, eq, gt, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  ReferralFundingSourceId,
  ReferralRewardRecoveryState,
  ReferralRewardReversalCause,
  ReferralRewardState,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { requireTransaction } from '../moderation/transactionGuard.js';
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
 * The two advisory-lock CLASSES this domain claims.
 *
 * Postgres's two-argument advisory locks live in a lock space that is entirely
 * separate from the one-argument `bigint` form, and every other advisory lock
 * in this repository is one-argument (the realdb suites' active-policy slot and
 * policy-teardown locks). So these cannot collide with anything already taken,
 * and the two classes cannot collide with each other however the keys hash.
 */
const PARTNER_CAP_LOCK_CLASS = 144_001;
const CAMPAIGN_CAP_LOCK_CLASS = 144_002;

/**
 * Serialize the cap window for one partner, until the caller's transaction ends.
 *
 * ## Why a lock and not a `FOR UPDATE`
 *
 * A cap is enforced by SUMMING existing rewards and then INSERTING one. Under
 * READ COMMITTED — which this backend runs at, with no isolation-level override
 * anywhere — two concurrent accruals for the same partner both read the other's
 * row as absent and both insert, and the cap is exceeded with no refusal
 * recorded. `SELECT … FOR UPDATE` cannot fix that: the row that would need
 * locking is the one that does not exist yet, and Postgres takes no predicate
 * locks below SERIALIZABLE.
 *
 * `referral_campaign_budgets` has the other shape of answer — a single
 * conditional `UPDATE` whose empty result IS the refusal — and it works there
 * because a budget IS a row. A partner cap is a property of a SET, so the
 * equivalent would be a running-total row per (partner, period), which is a
 * second representation of a fact the rewards already carry and which cannot
 * express a `lifetime` cap or survive a rule changing its period. The lock is
 * the honest version: it makes the read-then-write window exclusive without
 * inventing a counter that can disagree with the rows it counts.
 *
 * Transaction-scoped, so it is released by the commit or the rollback and never
 * by a caller remembering to. The currency is IN the key because the cap and
 * the sum are both currency-scoped, so two accruals in different currencies are
 * genuinely independent and should not contend.
 *
 * @throws {MissingTransactionError} When handed the root connection — a
 *   transaction-scoped lock taken outside a transaction is released the instant
 *   the implicit transaction commits, which serializes NOTHING and looks
 *   exactly like a lock that worked.
 */
export async function lockPartnerCapWindow(
  db: DatabaseOrTransaction,
  input: { partnerId: string; currency: CurrencyCode },
): Promise<void> {
  const tx = requireTransaction(db, 'lockPartnerCapWindow');
  await tx.execute(
    sql`select pg_advisory_xact_lock(${PARTNER_CAP_LOCK_CLASS}, hashtext(${`${input.partnerId}:${input.currency}`}))`,
  );
}

/**
 * Serialize the cap window for one campaign, until the caller's transaction
 * ends. Everything in {@link lockPartnerCapWindow}'s docblock applies.
 *
 * It needs a key of its own rather than riding the partner's: a campaign cap
 * spans partners, so two accruals under one campaign by two different partners
 * are exactly the race it exists to stop and share no partner key.
 */
export async function lockCampaignCapWindow(
  db: DatabaseOrTransaction,
  input: { campaignRef: string; currency: CurrencyCode },
): Promise<void> {
  const tx = requireTransaction(db, 'lockCampaignCapWindow');
  await tx.execute(
    sql`select pg_advisory_xact_lock(${CAMPAIGN_CAP_LOCK_CLASS}, hashtext(${`${input.campaignRef}:${input.currency}`}))`,
  );
}

/**
 * What one partner has accrued in one currency since an instant — the
 * per-partner period cap's input (#144 field 10).
 *
 * Sums the NET rather than the gross: a reward reduced by a refund has released
 * that much of the partner's allowance, which is the reading under which a cap
 * bounds what Mercaria actually owes. Voided rewards contribute nothing and are
 * excluded by their own zero net rather than by a filter.
 *
 * The figure is only a BOUND if the caller took {@link lockPartnerCapWindow}
 * first and holds it through the insert — this function reads, it does not
 * serialize.
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
 *
 * As above, a BOUND only under {@link lockCampaignCapWindow}.
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

/**
 * Move one reward from a known state to another, or refuse (#145).
 *
 * A compare-and-swap, never a read-then-write: two vesting sweeps, an operator
 * freezing a reward and a settlement can all reach one row at once, and the
 * predicate is what makes exactly one of them win. The empty result IS the
 * refusal — the caller reads `undefined` and records nothing, which is how a
 * repeat converges rather than writing a second transition.
 *
 * The companion timestamp is set in the SAME statement as the state, because
 * `referral_rewards_state_times_check` refuses a `vested` row with no
 * `vested_at` and a `paid` row with no `paid_at`. Writing them apart would fail
 * the first half of the pair on every transition.
 *
 * `frozen_from_state` is cleared on every move OUT of `frozen`, for the same
 * reason `appendRewardAdjustment` clears it when voiding: the CHECK is a
 * biconditional, so leaving it behind refuses the write with `23514` and the
 * thing that had to happen is the thing that fails.
 */
export async function setRewardState(
  db: DatabaseOrTransaction,
  input: {
    rewardId: string;
    expected: readonly ReferralRewardState[];
    to: ReferralRewardState;
    at: Date;
    /** Required when moving INTO `frozen`; ignored otherwise. */
    frozenFromState?: 'held' | 'vested';
    /**
     * The new hold deadline, when a freeze that stopped the clock is being
     * lifted (ADR 0005 D12: vesting needs N elapsed UNFROZEN days).
     *
     * `mercaria_referral_reward_frozen` pins this column against any move except
     * FORWARD — #145 widened it by `CREATE OR REPLACE` rather than adding a
     * second trigger, and the direction is what makes the widening safe: a
     * backwards move is what would vest a reward early.
     */
    holdUntilAt?: Date;
  },
): Promise<ReferralRewardRow | undefined> {
  const [row] = await db
    .update(referralRewards)
    .set({
      state: input.to,
      frozenFromState: input.to === 'frozen' ? (input.frozenFromState ?? null) : null,
      ...(input.holdUntilAt ? { holdUntilAt: input.holdUntilAt } : {}),
      ...(input.to === 'frozen' ? { frozenAt: input.at } : {}),
      ...(input.to === 'vested' ? { vestedAt: input.at } : {}),
      ...(input.to === 'paid' ? { paidAt: input.at } : {}),
      ...(input.to === 'voided' ? { voidedAt: input.at } : {}),
    })
    .where(
      and(
        eq(referralRewards.id, input.rewardId),
        inArray(referralRewards.state, [...input.expected]),
      ),
    )
    .returning();
  return row;
}

/**
 * Rewards whose hold has elapsed and which are still `held` — the vesting
 * sweep's page.
 *
 * Ordered by `hold_until_at` so the oldest obligation vests first, and keyset
 * paged on it rather than on the id: `@oxyhq/db`'s uuid v7 is not monotonic
 * within a millisecond, and a batch insert of several rewards shares an instant.
 *
 * `partnerId` NARROWS the page to one partner. The loop never passes it; the
 * operator surface does, because "this partner's holds elapsed and the loop is
 * off" is a real question with an idempotent answer — and because a sweep that
 * can only run over the whole fleet is one a realdb fixture cannot drive without
 * writing to a sibling file's rows.
 */
export async function listRewardsDueToVest(
  db: DatabaseOrTransaction,
  input: { at: Date; limit: number; afterHoldUntilAt?: Date; partnerId?: string },
): Promise<ReferralRewardRow[]> {
  return await db
    .select()
    .from(referralRewards)
    .where(
      and(
        eq(referralRewards.state, 'held'),
        lte(referralRewards.holdUntilAt, input.at),
        ...(input.afterHoldUntilAt ? [gt(referralRewards.holdUntilAt, input.afterHoldUntilAt)] : []),
        ...(input.partnerId ? [eq(referralRewards.partnerId, input.partnerId)] : []),
      ),
    )
    .orderBy(asc(referralRewards.holdUntilAt), asc(referralRewards.id))
    .limit(input.limit);
}

/**
 * One partner's rewards in one state and currency — the payout batch builder's
 * candidate set.
 *
 * Ordered oldest-accrual-first, so a batch that hits its page bound pays the
 * longest-waiting rewards rather than an arbitrary slice.
 */
export async function listRewardsInState(
  db: DatabaseOrTransaction,
  input: {
    partnerId: string;
    currency: CurrencyCode;
    states: readonly ReferralRewardState[];
    limit: number;
  },
): Promise<ReferralRewardRow[]> {
  if (input.states.length === 0) return [];
  return await db
    .select()
    .from(referralRewards)
    .where(
      and(
        eq(referralRewards.partnerId, input.partnerId),
        eq(referralRewards.currency, input.currency),
        inArray(referralRewards.state, [...input.states]),
      ),
    )
    .orderBy(asc(referralRewards.accruedAt), asc(referralRewards.id))
    .limit(input.limit);
}

/**
 * Every reward of one partner in a set of states, regardless of currency — the
 * freeze and unfreeze sweeps' population (ADR 0005 D18/R8).
 *
 * A suspension is a fact about the PARTNER, so it reaches every currency they
 * have earned in; the per-currency reads above exist because a payout is
 * per-currency and a balance is per-currency, which a freeze is not.
 */
export async function listPartnerRewardsInStates(
  db: DatabaseOrTransaction,
  input: { partnerId: string; states: readonly ReferralRewardState[]; limit: number },
): Promise<ReferralRewardRow[]> {
  if (input.states.length === 0) return [];
  return await db
    .select()
    .from(referralRewards)
    .where(
      and(
        eq(referralRewards.partnerId, input.partnerId),
        inArray(referralRewards.state, [...input.states]),
      ),
    )
    .orderBy(asc(referralRewards.accruedAt), asc(referralRewards.id))
    .limit(input.limit);
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
