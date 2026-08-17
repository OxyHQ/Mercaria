/**
 * The register cart's subtotal, executed (#469).
 *
 * ## Why this one is worth a test
 *
 * It is the only arithmetic in the POS that a cashier reads off a screen while
 * a customer is standing there, and every way it can be wrong produces a
 * PLAUSIBLE number rather than an error — a dropped line, a quantity ignored, a
 * currency taken from the wrong line. `tsc` types all four of those `Money`,
 * the money-formatting gate is satisfied by any `Money` at all, and the export
 * succeeds. Nothing in this repository was executing it.
 *
 * `computeCartSubtotal` is a DISPLAY estimate — the authoritative totals come
 * from the draft order the server recomputes through the pricing engine — which
 * is exactly why a silent drift here is not caught downstream by anything: the
 * two numbers are never compared.
 *
 * ## The module stays importable, and that is a property worth keeping
 *
 * `cart-totals.ts` imports `RegisterCartLine` with `import type`, so the zustand
 * store it lives in is erased and never loaded. A value import added there would
 * fail this file at import time, loudly, which is the signal that the module has
 * stopped being pure.
 */

import { describe, expect, it } from 'vitest';
import type { CurrencyCode, Money } from '@mercaria/shared-types';
import type { RegisterCartLine } from '../stores/register-cart';
import { computeCartSubtotal } from '../cart-totals';

/** One FAIR, in minor units — FAIR carries eight decimals. */
const ONE_FAIR = 100_000_000;

function line(
  overrides: Partial<RegisterCartLine> & { unitPrice: Money; quantity: number },
): RegisterCartLine {
  return {
    listingId: 'listing_1',
    variantId: 'variant_1',
    // Empty rather than prose: these are display fields this function never
    // reads, and the i18n gate scans this tree including its test files.
    title: '',
    variantTitle: '',
    available: 99,
    optionValues: [],
    ...overrides,
  };
}

function fair(amount: number, quantity: number): RegisterCartLine {
  return line({ unitPrice: { amount, currency: 'FAIR' }, quantity });
}

describe('an empty cart', () => {
  it('is zero FAIR, not an absent total', () => {
    expect(computeCartSubtotal([])).toEqual({ amount: 0, currency: 'FAIR' });
  });
});

describe('the subtotal sums every line at its own quantity', () => {
  it('multiplies one line by its quantity', () => {
    expect(computeCartSubtotal([fair(2_500_000_00, 3)])).toEqual({
      amount: 7_500_000_00,
      currency: 'FAIR',
    });
  });

  it('adds every line rather than reporting the first or the largest', () => {
    const subtotal = computeCartSubtotal([fair(ONE_FAIR, 1), fair(2 * ONE_FAIR, 2), fair(ONE_FAIR, 1)]);
    expect(subtotal.amount).toBe(6 * ONE_FAIR);
  });

  it('counts a quantity of zero as nothing, and keeps the line', () => {
    expect(computeCartSubtotal([fair(ONE_FAIR, 0), fair(ONE_FAIR, 2)]).amount).toBe(2 * ONE_FAIR);
  });

  it('stays exact over many eight-decimal amounts', () => {
    // The reason the function works in minor units at all. The same cart priced
    // in major units (0.1 + 0.2) does not land on a round number.
    const lines = Array.from({ length: 10 }, () => fair(10_000_000, 1));
    expect(computeCartSubtotal(lines).amount).toBe(ONE_FAIR);
    expect(Number.isInteger(computeCartSubtotal(lines).amount)).toBe(true);
  });

  it('does not round a large cart into imprecision', () => {
    const subtotal = computeCartSubtotal([fair(999_999 * ONE_FAIR, 7)]);
    expect(subtotal.amount).toBe(6_999_993 * ONE_FAIR);
    expect(Number.isSafeInteger(subtotal.amount)).toBe(true);
  });
});

describe('the currency', () => {
  it('is taken from the FIRST line', () => {
    const eur: CurrencyCode = 'EUR';
    expect(computeCartSubtotal([line({ unitPrice: { amount: 100, currency: eur }, quantity: 1 })])).toEqual(
      { amount: 100, currency: 'EUR' },
    );
  });

  it('is the FIRST line\'s, not the last one added', () => {
    // Pins WHICH line decides. This needs lines that DISAGREE: with a cart that
    // is all one currency, reading `lines[0]` and reading the last line are
    // indistinguishable, and an assertion over such a cart measures nothing.
    // Measured — mutating the module to `lines[lines.length - 1]` left an
    // all-EUR version of this case green.
    //
    // A mixed cart is out of contract (the register is single-currency and the
    // server recomputes the real totals), so this pins the tie-break rather than
    // endorsing the cart. The sum across currencies it also produces is the
    // reason the contract exists; see the residual note in the PR.
    const subtotal = computeCartSubtotal([
      line({ unitPrice: { amount: 100, currency: 'EUR' }, quantity: 1 }),
      line({ unitPrice: { amount: 100, currency: 'USD' }, quantity: 1 }),
    ]);
    expect(subtotal.currency).toBe('EUR');
  });

  it('falls back to FAIR only when there is no line to read it from', () => {
    expect(computeCartSubtotal([]).currency).toBe('FAIR');
    expect(computeCartSubtotal([fair(1, 1)]).currency).toBe('FAIR');
  });
});
