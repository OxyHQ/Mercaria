/**
 * The digital retail price, from a private wholesale cost and a versioned policy
 * (#1016 Workstream 5, ADR 0011).
 *
 * ## Why this is not ADR 0004 D3's formula
 *
 * Physical Mercaria retail is COST-ONLY: it charges what it paid, and its pricing
 * module exists to prove the total is the exact sum of approved components with
 * no margin at all. Digital retail carries a margin by decision, so the two
 * differ in the one direction a shared implementation cannot absorb — one proves
 * margin is zero, the other bounds it between a floor and a ceiling.
 *
 * ## Margin is BPS OF RETAIL, not of cost, and that is the subtle part
 *
 * A margin quoted as a percentage of the selling price is what a retailer means
 * by margin, and it is what a ceiling has to be expressed in for the ceiling to
 * bound anything: markup on cost is unbounded above as cost approaches zero. So
 * `retail = (cost + fixed) / (1 - (marginBps + paymentCostBps) / 10000)`, and the
 * CHECK on the policy keeps the denominator positive by bounding both rates below
 * 10 000.
 *
 * ## Rounding happens LAST and only ever moves the price UP
 *
 * Rounding down through the margin floor would silently sell below the approved
 * margin, so the rounded price is re-checked against the floor and the refusal is
 * `margin_below_floor` rather than a quiet adjustment. A price nobody approved is
 * worse than no price: with no price there is no offer, which is the safe state.
 *
 * **The consequence, stated rather than discovered later: the CEILING bounds the
 * requested margin, not the realized one.** Rounding up adds at most one rounding
 * increment, so a price computed at exactly the ceiling can realize a basis point
 * or two above it — 900 at a 3 000 bps ceiling rounds 1 285.71 to 1 286, which is
 * 3 001 bps. Clamping the realized figure back down would mean rounding DOWN,
 * which is the one direction that can cross the floor. The band is a policy about
 * what markup is approved; a sub-minor-unit overshoot is arithmetic.
 */

import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import type {
  DigitalRetailPricingResult,
  DigitalRetailRoundingMode,
} from '@mercaria/shared-types';

/** The policy facts pricing reads. A row satisfies it; so does a fixture. */
export interface DigitalRetailPricingPolicyFacts {
  readonly currency: string;
  readonly marginFloorBps: number;
  readonly marginCeilingBps: number;
  readonly paymentCostBps: number;
  readonly paymentCostFixedMinor: number;
  readonly roundingMode: DigitalRetailRoundingMode;
  readonly priceCeilingMinor: number | null;
}

/** The cost being priced. */
export interface DigitalRetailCost {
  readonly amount: number;
  readonly currency: string;
}

const BPS = 10_000;

/** Round a minor-unit amount UP under the policy's mode. Never down. */
function roundUp(amount: number, mode: DigitalRetailRoundingMode): number {
  switch (mode) {
    case 'minor_unit':
      return Math.ceil(amount);
    case 'end_99': {
      // The next value ending in 99 minor units at or above `amount`.
      const major = Math.ceil((amount - 99) / 100);
      return Math.max(99, major * 100 + 99);
    }
    case 'nearest_major':
      return Math.ceil(amount / 100) * 100;
  }
}

/**
 * Price one offer, or refuse with a reason.
 *
 * `policy` is null when no ACTIVE policy covers this market and product class,
 * and that refuses rather than defaulting: a fallback policy would mean a market
 * launching with a margin nobody approved, which is the whole point of versioning
 * it.
 */
export function priceDigitalRetailOffer(
  cost: DigitalRetailCost,
  policy: DigitalRetailPricingPolicyFacts | null,
  targetMarginBps?: number,
): DigitalRetailPricingResult {
  if (!policy) return { priced: false, refusal: 'no_policy' };
  if (policy.currency !== cost.currency) return { priced: false, refusal: 'currency_mismatch' };
  if (!(cost.amount > 0)) return { priced: false, refusal: 'cost_not_positive' };
  if (policy.marginCeilingBps < policy.marginFloorBps) {
    return { priced: false, refusal: 'ceiling_below_floor' };
  }

  assertSafeMoneyAmount(cost.amount, 'digital retail cost');
  assertSafeMoneyAmount(policy.paymentCostFixedMinor, 'digital retail payment cost');

  // The target defaults to the FLOOR, not to the ceiling or to a midpoint: the
  // launch posture is the least margin the policy approves, and asking for more
  // is an explicit act by whoever set the target.
  const requested = targetMarginBps ?? policy.marginFloorBps;
  const marginBps = Math.min(Math.max(requested, policy.marginFloorBps), policy.marginCeilingBps);

  const denominator = BPS - marginBps - policy.paymentCostBps;
  if (denominator <= 0) return { priced: false, refusal: 'ceiling_below_floor' };

  const raw = ((cost.amount + policy.paymentCostFixedMinor) * BPS) / denominator;
  let retailAmount = roundUp(raw, policy.roundingMode);

  if (policy.priceCeilingMinor !== null && retailAmount > policy.priceCeilingMinor) {
    // A competitive ceiling is a real constraint, so the price drops to it — and
    // then has to survive the floor check below. If it cannot, there is no price:
    // this product is one Mercaria cannot sell at this cost, which is a fact worth
    // reporting rather than a margin worth quietly abandoning.
    retailAmount = policy.priceCeilingMinor;
  }

  const marginAmount = retailAmount - cost.amount - policy.paymentCostFixedMinor;
  const realizedBps = Math.floor((marginAmount * BPS) / retailAmount);
  if (realizedBps < policy.marginFloorBps) {
    return { priced: false, refusal: 'margin_below_floor' };
  }

  assertSafeMoneyAmount(retailAmount, 'digital retail price');
  return {
    priced: true,
    retailAmount,
    currency: policy.currency,
    marginAmount,
    marginBps: realizedBps,
  };
}
