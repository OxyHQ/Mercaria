/**
 * Money helpers.
 *
 * `Money` amounts are integer minor units (cents) — never floats. These helpers
 * operate purely on integers and throw on currency mismatch rather than
 * silently coercing, so totals can never mix currencies undetected.
 */

import type { CurrencyCode, Money } from '@mercaria/shared-types';

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
