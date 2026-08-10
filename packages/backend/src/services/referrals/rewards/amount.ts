/**
 * Reward arithmetic — rounding defined ONCE, and every clamp that can only ever
 * lower a figure (#144 calculation rules 2, 3 and 7).
 *
 * Pure. No database, no clock, no configuration. Everything in this file is a
 * function of its arguments, which is what lets the reversal path recompute a
 * reward from a moved base and get an answer that reconciles exactly against
 * the one accrual produced — `Σ deltas + gross == net` is an identity here
 * rather than an accumulated total that has to be trusted.
 *
 * ## Rounding is half-even, and it is stated in one place
 *
 * `roundHalfEven` is the only rounding in the domain. Half-even rather than
 * half-up because a reward is a repeated small percentage of many bases: half-up
 * biases every exact half in the same direction, which over a campaign is a
 * systematic transfer in whichever direction the tie happens to favour. It is
 * also what `pricing.service` and the retail FX conversion already use, so the
 * codebase has one tie-breaking rule rather than two.
 *
 * The arithmetic runs in `bigint` and comes back as a `number`. `base × bps`
 * exceeds `Number.MAX_SAFE_INTEGER` for a FAIR-denominated base long before the
 * base itself does — FAIR carries eight decimals, so a 1_000 ⊜ base is 10^11
 * minor units and multiplying by 10_000 bps is 10^15, inside the safe range but
 * within one order of magnitude of leaving it. Doing the multiply in `bigint`
 * removes the question entirely, and `assertSafeMoneyAmount` on the way out is
 * what keeps the result inside the ceiling every money boundary in this
 * codebase enforces.
 *
 * ## Every clamp lowers and none raises
 *
 * There is no function here that can increase an amount. That is the whole
 * shape of ADR 0005 D10: a reward is a bounded fraction of income actually
 * earned, and a floor that topped one up would be money from nowhere. A rule's
 * minimum is therefore a THRESHOLD ({@link isBelowMinimumAccrual}), never a
 * top-up, and it has no arithmetic form at all.
 */

import { assertSafeMoneyAmount } from '@mercaria/shared-types';

/** 100% in basis points. The structural ceiling ADR 0005 D10 puts on a rate. */
export const REWARD_RATE_BPS_DENOMINATOR = 10_000;

/**
 * `numerator / denominator`, rounded half to EVEN. Both must be non-negative
 * and the denominator positive — the only shape this domain produces, and
 * asserting it is cheaper than a sign convention nobody can keep in their head.
 */
function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError(
      `roundHalfEven expects a non-negative numerator and a positive denominator, got ` +
        `${numerator.toString()}/${denominator.toString()}. A negative reward is representable ` +
        'only as a reversal record, never as arithmetic.',
    );
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twiceRemainder = remainder * 2n;
  if (twiceRemainder > denominator) return quotient + 1n;
  if (twiceRemainder < denominator) return quotient;
  // Exactly half: go to the even neighbour.
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/**
 * `rateBps` basis points of `baseMinor`, in the base's own minor units.
 *
 * @param baseMinor The REALIZED eligible funding — never a gross basket value,
 *   never a customer amount. What may legitimately be passed here is decided by
 *   the funding adapters, not by this function.
 * @param rateBps `> 0` and `<= 10_000`; the rule's CHECK enforces the same
 *   bound at the row, so a rate outside it cannot reach here from a stored rule.
 */
export function percentageOfRealizedBase(baseMinor: number, rateBps: number): number {
  if (!Number.isInteger(baseMinor) || baseMinor < 0) {
    throw new RangeError(`A realized base must be a non-negative integer, got ${String(baseMinor)}`);
  }
  if (!Number.isInteger(rateBps) || rateBps <= 0 || rateBps > REWARD_RATE_BPS_DENOMINATOR) {
    throw new RangeError(
      `A reward rate must be an integer in (0, ${String(REWARD_RATE_BPS_DENOMINATOR)}] bps, got ` +
        String(rateBps),
    );
  }
  const amount = Number(
    roundHalfEven(BigInt(baseMinor) * BigInt(rateBps), BigInt(REWARD_RATE_BPS_DENOMINATOR)),
  );
  assertSafeMoneyAmount(amount, 'referral reward percentage of realized base');
  return amount;
}

/** The clamps a rule may impose, all of which can only ever lower an amount. */
export interface RewardCeilings {
  /** The realized funding itself — #144 rule 7's first half. */
  realizedFundingMinor: number;
  /** The rule's per-conversion cap, when it has one. */
  perConversionMinor?: number;
  /** What the per-partner period cap leaves — already net of prior accruals. */
  partnerHeadroomMinor?: number;
  /** What the campaign cap leaves — already net of prior accruals. */
  campaignHeadroomMinor?: number;
}

/** Which ceiling bound a reward, so a refusal or a receipt can say. */
export type RewardCeilingApplied =
  | 'none'
  | 'realized_funding'
  | 'per_conversion'
  | 'partner_period'
  | 'campaign';

/** The clamped amount and the ceiling that produced it. */
export interface ClampedReward {
  amountMinor: number;
  applied: RewardCeilingApplied;
}

/**
 * Lower `amountMinor` to the tightest ceiling that binds it.
 *
 * The order the ceilings are tried in decides only which NAME a clamp reports,
 * never the figure — `min` is commutative — and it runs funding-first because
 * that is the one bound whose breach means the reward would have been money
 * Mercaria never received, which is the fact worth surfacing when two ceilings
 * bind at once.
 *
 * A headroom of zero (or below, which a shrinking cap can produce) clamps to
 * zero; the caller turns that into `cap_reached` rather than accruing nothing
 * silently.
 */
export function clampReward(amountMinor: number, ceilings: RewardCeilings): ClampedReward {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new RangeError(`A reward amount must be a non-negative integer, got ${String(amountMinor)}`);
  }
  const candidates: { limit: number; applied: RewardCeilingApplied }[] = [
    { limit: ceilings.realizedFundingMinor, applied: 'realized_funding' },
  ];
  if (ceilings.perConversionMinor !== undefined) {
    candidates.push({ limit: ceilings.perConversionMinor, applied: 'per_conversion' });
  }
  if (ceilings.partnerHeadroomMinor !== undefined) {
    candidates.push({ limit: ceilings.partnerHeadroomMinor, applied: 'partner_period' });
  }
  if (ceilings.campaignHeadroomMinor !== undefined) {
    candidates.push({ limit: ceilings.campaignHeadroomMinor, applied: 'campaign' });
  }

  let amount = amountMinor;
  let applied: RewardCeilingApplied = 'none';
  for (const candidate of candidates) {
    const limit = Math.max(0, Math.trunc(candidate.limit));
    if (limit < amount) {
      amount = limit;
      applied = candidate.applied;
    }
  }
  assertSafeMoneyAmount(amount, 'referral reward after ceilings');
  return { amountMinor: amount, applied };
}

/**
 * Whether an amount falls under the rule's de-minimis threshold.
 *
 * A separate question from clamping, and deliberately not expressible as one:
 * a minimum that participated in the arithmetic would be a floor, and a floor
 * above the realized base is exactly the "money from nowhere" ADR 0005 D10
 * refuses. Below the minimum the accrual is REFUSED and the refusal recorded —
 * nothing is topped up and nothing is silently dropped.
 */
export function isBelowMinimumAccrual(amountMinor: number, minAccrualMinor?: number): boolean {
  if (minAccrualMinor === undefined || minAccrualMinor === null) return false;
  return amountMinor < minAccrualMinor;
}

/** The start of the window a per-partner cap is measured over, or `undefined` for `lifetime`. */
export function capPeriodStart(period: string, at: Date): Date | undefined {
  const start = new Date(at.getTime());
  switch (period) {
    case 'day':
      start.setUTCHours(0, 0, 0, 0);
      return start;
    case 'week': {
      start.setUTCHours(0, 0, 0, 0);
      // ISO weeks start on Monday; `getUTCDay()` makes Sunday 0.
      const isoWeekday = (start.getUTCDay() + 6) % 7;
      start.setUTCDate(start.getUTCDate() - isoWeekday);
      return start;
    }
    case 'month':
      return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    case 'lifetime':
      return undefined;
    default:
      throw new RangeError(`Unknown referral reward cap period: ${period}`);
  }
}
