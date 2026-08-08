/**
 * Validation tests for the embedded `Money` sub-schema's amount guard.
 *
 * Persistence is the one boundary EVERY write passes through, so this guard is
 * what makes the amount-safety rule total rather than a property of the paths
 * that remember to assert. Mongoose validation runs without a DB connection
 * (same approach as `connector-models.test.ts`), so these are ordinary unit
 * tests.
 *
 * They validate through the REAL `Order` model rather than a purpose-built probe
 * schema: a probe would keep passing if the order totals were ever changed to a
 * bare `Number` that skips `MoneySchema` entirely, which is exactly the
 * regression worth catching.
 */

import { describe, it, expect } from 'vitest';
import { MAX_MONEY_MINOR_UNITS } from '@mercaria/shared-types';
import { Order } from '../order.js';

/** The validation error message at `path`, if the document produced one. */
async function errorAt(amount: number, path: string): Promise<string | undefined> {
  const doc = new Order({
    totals: {
      grandTotal: {
        shop: { amount, currency: 'USD' },
        presentment: { amount, currency: 'USD' },
      },
    },
  });
  // Other required fields are deliberately omitted — the document is invalid for
  // several reasons and only the money path is under test, so the assertion is
  // on that path's presence rather than on overall validity.
  try {
    await doc.validate();
    return undefined;
  } catch (err) {
    const errors = (err as { errors?: Record<string, { message?: string }> }).errors ?? {};
    return errors[path]?.message;
  }
}

describe('MoneySchema amount validation (via the real Order model)', () => {
  it('accepts an ordinary integer minor-unit amount', async () => {
    expect(await errorAt(1999, 'totals.grandTotal.shop.amount')).toBeUndefined();
  });

  it('accepts zero and exactly the representable maximum', async () => {
    expect(await errorAt(0, 'totals.grandTotal.shop.amount')).toBeUndefined();
    expect(await errorAt(MAX_MONEY_MINOR_UNITS, 'totals.grandTotal.shop.amount')).toBeUndefined();
  });

  it('REJECTS a fractional amount — minor units are whole', async () => {
    expect(await errorAt(19.99, 'totals.grandTotal.shop.amount')).toMatch(
      /integer count of minor units/,
    );
  });

  it('REJECTS an amount past the representable maximum, on EITHER side of the dual', async () => {
    const over = MAX_MONEY_MINOR_UNITS + 1;
    expect(await errorAt(over, 'totals.grandTotal.shop.amount')).toMatch(/within/);
    expect(await errorAt(over, 'totals.grandTotal.presentment.amount')).toMatch(/within/);
  });

  it('REJECTS a non-finite amount', async () => {
    expect(await errorAt(Number.POSITIVE_INFINITY, 'totals.grandTotal.shop.amount')).toBeDefined();
    expect(await errorAt(Number.NaN, 'totals.grandTotal.shop.amount')).toBeDefined();
  });

  it('permits a NEGATIVE amount within range — the bound is on magnitude', async () => {
    // A stored amount may legitimately be negative (a difference); it is the
    // MAGNITUDE that decides whether arithmetic on it stays exact.
    expect(await errorAt(-1999, 'totals.grandTotal.shop.amount')).toBeUndefined();
    expect(await errorAt(-MAX_MONEY_MINOR_UNITS - 1, 'totals.grandTotal.shop.amount')).toMatch(
      /within/,
    );
  });
});
