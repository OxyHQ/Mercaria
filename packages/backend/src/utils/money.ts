/**
 * Money helpers.
 *
 * `Money` amounts are integer minor units (cents) — never floats. These helpers
 * operate purely on integers and throw on currency mismatch rather than
 * silently coercing, so totals can never mix currencies undetected.
 */

import { CURRENCY_PRECISION, type CurrencyCode, type Money } from '@mercaria/shared-types';

/** Basis-point denominator: 10_000 bps = 100%. */
const BASIS_POINTS_DENOMINATOR = 10_000;
/** Decimal radix used to derive minor units from a currency's precision. */
const DECIMAL_RADIX = 10;

/** Thrown when an operation mixes two different currencies. */
export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Currency mismatch: cannot combine ${a} with ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

/** A zero-valued `Money` in the given currency. */
export function zeroMoney(currency: CurrencyCode): Money {
  return { amount: 0, currency };
}

/** Add two `Money` values. Throws `CurrencyMismatchError` if they differ. */
export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
  return { amount: a.amount + b.amount, currency: a.currency };
}

/**
 * Multiply a `Money` value by an integer quantity. Throws if `quantity` is not
 * a non-negative integer (quantities are whole units).
 */
export function multiplyMoney(m: Money, quantity: number): Money {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error(`Quantity must be a non-negative integer, received ${quantity}`);
  }
  return { amount: m.amount * quantity, currency: m.currency };
}

/**
 * Sum a list of `Money` values, all of which must be `currency`. An empty list
 * yields zero in `currency`. Throws `CurrencyMismatchError` on the first item
 * whose currency differs.
 */
export function sumMoney(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce<Money>((acc, item) => addMoney(acc, item), zeroMoney(currency));
}

/**
 * The number of minor units in one major unit of `currency`, derived from the
 * shared `CURRENCY_PRECISION` map (FAIR → 1e8, USD/EUR/GBP → 100). Use this
 * instead of hardcoding `100` so formatters, migrations and seeds stay
 * precision-aware as currencies are added.
 */
export function minorUnitsPerMajor(currency: CurrencyCode): number {
  return DECIMAL_RADIX ** CURRENCY_PRECISION[currency];
}

/**
 * Subtract `b` from `a`. Throws `CurrencyMismatchError` if the currencies
 * differ. Does NOT clamp negative results — the difference may be negative and
 * the caller decides whether that is valid (e.g. a discount larger than the
 * subtotal). Inputs are integer minor units, so the result is an integer.
 */
export function subtractMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
  return { amount: a.amount - b.amount, currency: a.currency };
}

/**
 * Round a possibly-fractional minor-unit `value` to an integer using banker's
 * rounding (round-half-to-even). Half-even avoids the upward bias of
 * round-half-up across many rounding operations (e.g. percent math on many
 * lines). For already-integer inputs this is a no-op.
 *
 * Examples: `0.5 → 0`, `1.5 → 2`, `2.5 → 2`, `2.6 → 3`, `-0.5 → 0`, `-1.5 → -2`.
 */
export function roundMinorUnits(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  const half = 0.5;
  if (diff < half) {
    return floor;
  }
  if (diff > half) {
    return floor + 1;
  }
  // Exactly halfway: round to the even neighbour.
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Normalize a `Money` whose `amount` may be fractional to one with an integer
 * minor-unit `amount`, using half-even rounding (`roundMinorUnits`). A no-op for
 * an already-integer amount. Currency is preserved.
 */
export function roundMoney(money: Money): Money {
  return { amount: roundMinorUnits(money.amount), currency: money.currency };
}

/**
 * Compute `bps` basis points of `money` (1500 bps = 15%), returning a `Money` in
 * the same currency with an integer minor-unit amount. The intermediate
 * `amount * bps / 10000` can be fractional and is rounded half-even via
 * `roundMinorUnits`. `bps` MUST be a non-negative integer (basis points are
 * whole) — throws otherwise.
 */
export function percentOf(money: Money, bps: number): Money {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new Error(`Basis points must be a non-negative integer, received ${bps}`);
  }
  const raw = (money.amount * bps) / BASIS_POINTS_DENOMINATOR;
  return { amount: roundMinorUnits(raw), currency: money.currency };
}

/**
 * Distribute `total` across `weights` so the parts sum EXACTLY to `total.amount`
 * (no minor units lost or created), using the largest-remainder (Hamilton)
 * method: each part is `floor(total.amount * weight / sumWeights)`, then the
 * leftover units are handed out one-by-one to the entries with the largest
 * fractional remainders.
 *
 * Tie-break: when two entries have equal remainders, the lower index wins (units
 * are distributed in ascending-index order over a remainder-descending sort).
 *
 * Zero-weight behaviour: when `sumWeights === 0` (empty after the empty-array
 * guard means all weights are zero), the entire `total.amount` is reconciled
 * onto index 0 and the rest are zero — there is no proportional basis, so the
 * residual lands on the first entry.
 *
 * Edge cases (no throw): empty `weights` → `[]`. Invalid input (throws): any
 * negative weight.
 *
 * Returns a `Money[]` the same length as `weights`, all in `total.currency`,
 * each with an integer minor-unit amount.
 */
export function allocateProportionally(total: Money, weights: number[]): Money[] {
  if (weights.length === 0) {
    return [];
  }
  for (const weight of weights) {
    if (weight < 0) {
      throw new Error(`Weights must be non-negative, received ${weight}`);
    }
  }

  const sumWeights = weights.reduce((acc, w) => acc + w, 0);

  // All-zero weights: no proportional basis — put the whole residual on index 0.
  if (sumWeights === 0) {
    return weights.map((_, index) => ({
      amount: index === 0 ? total.amount : 0,
      currency: total.currency,
    }));
  }

  // Floor each share and track its fractional remainder for largest-remainder.
  const floored = weights.map((weight) => {
    const exact = (total.amount * weight) / sumWeights;
    const base = Math.floor(exact);
    return { base, remainder: exact - base };
  });

  const distributed = floored.reduce((acc, part) => acc + part.base, 0);
  let leftover = total.amount - distributed;

  // Hand out leftover units to the largest remainders; ties → lowest index.
  const order = floored
    .map((part, index) => ({ index, remainder: part.remainder }))
    .sort((a, b) => (b.remainder - a.remainder) || (a.index - b.index));

  const amounts = floored.map((part) => part.base);
  for (const entry of order) {
    if (leftover <= 0) {
      break;
    }
    amounts[entry.index] += 1;
    leftover -= 1;
  }

  return amounts.map((amount) => ({ amount, currency: total.currency }));
}
