/**
 * The aggregates a pilot report and a threshold evaluation are DERIVED from
 * (#149 "Pilot metrics", "Unit economics").
 *
 * Two statements, both bounded to one cohort's programme and its published
 * window. They are the whole of what this repository can compute today, and the
 * report says so rather than reporting zero for everything else — a sweep
 * computing only what it can reach and calling the rest "no breaches" is the
 * vacuous monitor `unmeasured` exists to expose (#125's finding, one domain
 * over).
 *
 * ## Why every figure here comes out of the REFERRAL tables
 *
 * ADR 0005 fact 1: Mercaria's commission exists nowhere except the ledger, and
 * #144's accrual reads it there and RECORDS what it read on
 * `referral_rewards.funding_amount_minor`. So the realized base of a pilot is
 * available as an immutable observation on the reward row, taken at accrual by
 * the one adapter allowed to compute it — which is a better source than a
 * second derivation over `ledger_entries` would be, because two derivations of
 * one figure can disagree and only one of them is what the partner was paid on.
 *
 * The cost is stated in `native_revenue_generated`'s own attribution limit: a
 * conversion whose accrual was refused (`zero_base`, `budget_exhausted`,
 * `cap_reached`) has no reward row and contributes no revenue here, even where
 * the order genuinely produced commission.
 */

import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { referralAttributions, referralConversions } from '../schema/referrals.js';
import { referralRewards } from '../schema/referralRewards.js';

/** What one cohort's window produced, as the report reads it. */
export interface ReferralPilotAggregates {
  /** Attributions created inside the window for the cohort's programme. */
  readonly attributions: number;
  /** Distinct referred subjects behind them. */
  readonly distinctSubjects: number;
  /** Conversions recorded against those attributions. */
  readonly conversions: number;
  /** Of those, the ones a verification confirmed. */
  readonly verifiedConversions: number;
  /** Rewards accrued against those conversions. */
  readonly rewards: number;
  /**
   * The sum of the realized bases those rewards were computed from — ADR 0005's
   * `connected_marketplace` commission, as the accrual observed it.
   */
  readonly realizedBaseMinor: number;
  /** The sum of every accrued reward's CURRENT net, whatever its state. */
  readonly accruedNetMinor: number;
  /** The net of rewards still held or frozen. */
  readonly heldNetMinor: number;
  /** The net of rewards vested and not yet paid. */
  readonly vestedNetMinor: number;
}

const ZERO: ReferralPilotAggregates = {
  attributions: 0,
  distinctSubjects: 0,
  conversions: 0,
  verifiedConversions: 0,
  rewards: 0,
  realizedBaseMinor: 0,
  accruedNetMinor: 0,
  heldNetMinor: 0,
  vestedNetMinor: 0,
};

/**
 * Read one cohort's aggregates.
 *
 * `to` is EXCLUSIVE and `from` inclusive, so two adjacent windows partition the
 * pilot exactly and a conversion cannot be counted in both.
 *
 * Every sum is coerced with `Number(...)`: postgres.js decodes `bigint`/`int8`
 * as a STRING, including `sum()`, while drizzle types it `number` — so a bare
 * addition would be string concatenation.
 */
export async function readReferralPilotAggregates(
  input: { programId: string; from: Date; to: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralPilotAggregates> {
  const window = and(
    eq(referralAttributions.programId, input.programId),
    gte(referralAttributions.createdAt, input.from),
    lt(referralAttributions.createdAt, input.to),
  );

  const [subjects] = await db
    .select({
      attributions: sql<string>`count(*)`,
      distinctSubjects: sql<string>`count(distinct ${referralAttributions.subjectRef})`,
    })
    .from(referralAttributions)
    .where(window);

  const [conversions] = await db
    .select({
      conversions: sql<string>`count(*)`,
      verified: sql<string>`count(*) filter (where ${referralConversions.state} = 'eligible'
                                               and ${referralConversions.verifiedAt} is not null)`,
    })
    .from(referralConversions)
    .innerJoin(referralAttributions, eq(referralConversions.attributionId, referralAttributions.id))
    .where(window);

  const [rewards] = await db
    .select({
      rewards: sql<string>`count(*)`,
      realizedBase: sql<string>`coalesce(sum(${referralRewards.fundingAmountMinor}), 0)`,
      accruedNet: sql<string>`coalesce(sum(${referralRewards.netAmountMinor}), 0)`,
      heldNet: sql<string>`coalesce(sum(${referralRewards.netAmountMinor})
                                   filter (where ${referralRewards.state} in ('held', 'frozen')), 0)`,
      vestedNet: sql<string>`coalesce(sum(${referralRewards.netAmountMinor})
                                     filter (where ${referralRewards.state} = 'vested'), 0)`,
    })
    .from(referralRewards)
    .innerJoin(referralAttributions, eq(referralRewards.attributionId, referralAttributions.id))
    .where(window);

  return {
    attributions: Number(subjects?.attributions ?? 0),
    distinctSubjects: Number(subjects?.distinctSubjects ?? 0),
    conversions: Number(conversions?.conversions ?? 0),
    verifiedConversions: Number(conversions?.verified ?? 0),
    rewards: Number(rewards?.rewards ?? 0),
    realizedBaseMinor: Number(rewards?.realizedBase ?? 0),
    accruedNetMinor: Number(rewards?.accruedNet ?? 0),
    heldNetMinor: Number(rewards?.heldNet ?? 0),
    vestedNetMinor: Number(rewards?.vestedNet ?? 0),
  };
}

/**
 * The zero aggregates, for a cohort that does not exist.
 *
 * Note what this is NOT: a report over an empty cohort renders every derived
 * measure as a real ZERO, because zero attributions is a fact about the pilot.
 * A measure with no PRODUCER renders `unmeasured` instead, and the two must not
 * be told apart by their value — which is why the report carries a status per
 * measure rather than a number and a convention.
 */
export const EMPTY_REFERRAL_PILOT_AGGREGATES = ZERO;
