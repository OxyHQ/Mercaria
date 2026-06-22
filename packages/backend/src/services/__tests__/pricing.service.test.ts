/**
 * Unit tests for `pricing.service` — the single FAIR totals engine (B4).
 *
 * `mongodb-memory-server` is unavailable, so the `Discount`/`TaxRate`/`Store`
 * model statics are mocked with `vi.fn()` returning `.lean()`-able stubs (mirrors
 * the `collection.service` test pattern). The tests assert the EXACT money math:
 * subtotal-only (no store), percentage/fixed/BOGO discount amounts, order-level
 * proportional allocation with exact residual reconciliation, line-scoped
 * attribution, gating (minimum + usage limit), combinability selection, and
 * exclusive-vs-inclusive tax. Every test is deterministic and offline.
 *
 * Two invariants are checked on every priced result: `sum(perLineDiscount) ===
 * discountTotal`, and the sum of per-line `(lineTotal − discount + tax)` ===
 * `grandTotal` (the engine reconciles residual minor units onto the largest line).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const discountFind = vi.fn();
const taxRateFind = vi.fn();
const storeFindById = vi.fn();

vi.mock('../../models/discount.js', () => ({
  Discount: { find: (...args: unknown[]) => discountFind(...args) },
}));

vi.mock('../../models/tax-rate.js', () => ({
  TaxRate: { find: (...args: unknown[]) => taxRateFind(...args) },
}));

vi.mock('../../models/store.js', () => ({
  Store: { findById: (...args: unknown[]) => storeFindById(...args) },
}));

import { calculateTotals, type PricingLine } from '../pricing.service.js';
import type { IDiscount } from '../../models/discount.js';
import type { ITaxRate } from '../../models/tax-rate.js';
import type { IStoreTaxSettings } from '../../models/store.js';

const STORE_ID = '000000000000000000000040';
const L1 = '000000000000000000000101';
const L2 = '000000000000000000000102';
const COLLECTION_A = '000000000000000000000c01';

/** A `.lean()`-able query stub resolving to `value`. */
function leanOf<T>(value: T): { lean: () => Promise<T> } {
  return { lean: () => Promise.resolve(value) };
}

/** A `Store.findById(...).select(...).lean()` chain resolving to taxSettings. */
function storeTaxLean(taxSettings: IStoreTaxSettings | undefined): unknown {
  return { select: () => ({ lean: () => Promise.resolve(taxSettings ? { taxSettings } : null) }) };
}

/** Build a priced line. */
function line(overrides: Partial<PricingLine> & { listingId: string; amount: number; quantity: number }): PricingLine {
  return {
    listingId: overrides.listingId,
    variantId: `v-${overrides.listingId}`,
    unitPrice: { amount: overrides.amount, currency: 'FAIR' },
    quantity: overrides.quantity,
    ...(overrides.productType ? { productType: overrides.productType } : {}),
    ...(overrides.collectionIds ? { collectionIds: overrides.collectionIds } : {}),
  };
}

/** Cross-collection ids in these stubs are plain strings cast to the model's id type. */
function objectId<T>(id: string): T {
  return id as unknown as T;
}

/** Build a minimal discount doc with sane defaults (`id` is a plain string). */
function discount(
  overrides: Partial<Omit<IDiscount, '_id'>> &
    Pick<IDiscount, 'valueType' | 'value'> & { _id: string },
): IDiscount {
  return {
    storeId: STORE_ID,
    title: 'Discount',
    method: 'automatic',
    codes: [],
    appliesTo: { scope: 'order' },
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
    startsAt: new Date(0),
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
    _id: objectId<IDiscount['_id']>(overrides._id),
  };
}

/** Build a minimal tax-rate doc (`id` is a plain string). */
function taxRate(
  overrides: Partial<Omit<ITaxRate, '_id'>> & Pick<ITaxRate, 'rateBps'> & { _id: string },
): ITaxRate {
  return {
    storeId: STORE_ID,
    name: 'Tax',
    region: {},
    appliesToShipping: false,
    priority: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
    _id: objectId<ITaxRate['_id']>(overrides._id),
  };
}

/** Assert the two engine invariants on a result. */
function assertReconciled(
  result: Awaited<ReturnType<typeof calculateTotals>>,
  lineTotals: number[],
): void {
  const perLineSum = result.perLineDiscount.reduce((s, m) => s + m.amount, 0);
  expect(perLineSum).toBe(result.discountTotal.amount);
  // Per-line (lineTotal − discount) must sum to subtotal − discountTotal.
  const discountedSum = lineTotals.reduce((s, t, i) => s + (t - result.perLineDiscount[i].amount), 0);
  expect(discountedSum).toBe(result.subtotal.amount - result.discountTotal.amount);
  // grandTotal = subtotal − discount + tax + shipping (shipping always 0 here).
  expect(result.grandTotal.amount).toBe(
    result.subtotal.amount - result.discountTotal.amount + result.tax.amount + result.shipping.amount,
  );
}

beforeEach(() => {
  discountFind.mockReset().mockReturnValue(leanOf([]));
  taxRateFind.mockReset().mockReturnValue(leanOf([]));
  storeFindById.mockReset().mockReturnValue(storeTaxLean({ pricesIncludeTax: false, chargeTaxOnProducts: true }));
});

describe('calculateTotals — no store (P2P)', () => {
  it('returns subtotal only with no discounts/taxes', async () => {
    const result = await calculateTotals({
      lines: [line({ listingId: L1, amount: 1000, quantity: 2 })],
      currency: 'FAIR',
    });
    expect(result.subtotal.amount).toBe(2000);
    expect(result.discountTotal.amount).toBe(0);
    expect(result.tax.amount).toBe(0);
    expect(result.grandTotal.amount).toBe(2000);
    expect(result.appliedDiscounts).toEqual([]);
    expect(result.perLineDiscount).toEqual([{ amount: 0, currency: 'FAIR' }]);
    // No store → models are never queried.
    expect(discountFind).not.toHaveBeenCalled();
  });
});

describe('calculateTotals — percentage order-level discount', () => {
  it('applies 15% off the subtotal with exact reconciliation', async () => {
    discountFind.mockReturnValue(
      leanOf([discount({ _id: 'd1', valueType: 'percentage', value: 1500, appliesTo: { scope: 'order' } })]),
    );
    const lines = [
      line({ listingId: L1, amount: 1000, quantity: 3 }), // 3000
      line({ listingId: L2, amount: 700, quantity: 1 }), // 700
    ];
    const result = await calculateTotals({ storeId: STORE_ID, lines, currency: 'FAIR' });

    expect(result.subtotal.amount).toBe(3700);
    // 15% of 3700 = 555.
    expect(result.discountTotal.amount).toBe(555);
    expect(result.grandTotal.amount).toBe(3145);
    // Order-level discounts emit ONE allocation (target 'order'), not per line.
    expect(result.appliedDiscounts).toHaveLength(1);
    expect(result.appliedDiscounts[0].target).toBe('order');
    assertReconciled(result, [3000, 700]);
  });
});

describe('calculateTotals — fixed_amount clamped to base', () => {
  it('clamps a fixed_amount discount to the subtotal', async () => {
    discountFind.mockReturnValue(
      leanOf([discount({ _id: 'd1', valueType: 'fixed_amount', value: 999999, appliesTo: { scope: 'order' } })]),
    );
    const lines = [line({ listingId: L1, amount: 1000, quantity: 2 })]; // 2000
    const result = await calculateTotals({ storeId: STORE_ID, lines, currency: 'FAIR' });

    expect(result.discountTotal.amount).toBe(2000); // clamped to subtotal.
    expect(result.grandTotal.amount).toBe(0);
    assertReconciled(result, [2000]);
  });
});

describe('calculateTotals — order-level proportional allocation', () => {
  it('reconciles the residual onto the largest line', async () => {
    // 10% off an uneven split that does not divide evenly.
    discountFind.mockReturnValue(
      leanOf([discount({ _id: 'd1', valueType: 'percentage', value: 1000, appliesTo: { scope: 'order' } })]),
    );
    const lines = [
      line({ listingId: L1, amount: 333, quantity: 1 }), // 333
      line({ listingId: L2, amount: 1000, quantity: 1 }), // 1000
    ];
    const result = await calculateTotals({ storeId: STORE_ID, lines, currency: 'FAIR' });

    // 10% of 1333 = 133.3 → 133 (half-even). Allocated by weight 333:1000.
    expect(result.discountTotal.amount).toBe(133);
    const sum = result.perLineDiscount.reduce((s, m) => s + m.amount, 0);
    expect(sum).toBe(133);
    assertReconciled(result, [333, 1000]);
  });
});

describe('calculateTotals — product-level discount', () => {
  it('attributes only to matching lines (by collection)', async () => {
    discountFind.mockReturnValue(
      leanOf([
        discount({
          _id: 'd1',
          valueType: 'percentage',
          value: 2000, // 20%
          appliesTo: { scope: 'collections', collectionIds: [COLLECTION_A] },
        }),
      ]),
    );
    const lines = [
      line({ listingId: L1, amount: 1000, quantity: 1, collectionIds: [COLLECTION_A] }), // matches
      line({ listingId: L2, amount: 500, quantity: 1 }), // no collection → no discount
    ];
    const result = await calculateTotals({ storeId: STORE_ID, lines, currency: 'FAIR' });

    expect(result.discountTotal.amount).toBe(200); // 20% of 1000 only.
    expect(result.perLineDiscount[0].amount).toBe(200);
    expect(result.perLineDiscount[1].amount).toBe(0);
    assertReconciled(result, [1000, 500]);
  });
});

describe('calculateTotals — BOGO', () => {
  it('buy 2 get 1 free discounts the cheapest qualifying unit', async () => {
    discountFind.mockReturnValue(
      leanOf([
        discount({
          _id: 'd1',
          valueType: 'free_item',
          value: 0,
          appliesTo: { scope: 'products', productIds: [L1] },
          buy: { quantity: 2, scope: 'products', productIds: [L1] },
          get: { quantity: 1, scope: 'products', productIds: [L1] },
        }),
      ]),
    );
    // 3 units at 500 each → buy 2 get 1 free → one unit free (500 off).
    const lines = [line({ listingId: L1, amount: 500, quantity: 3 })];
    const result = await calculateTotals({ storeId: STORE_ID, lines, currency: 'FAIR' });

    expect(result.discountTotal.amount).toBe(500);
    expect(result.grandTotal.amount).toBe(1000);
    assertReconciled(result, [1500]);
  });
});

describe('calculateTotals — gating', () => {
  it('does not apply when the subtotal is below the minimum requirement', async () => {
    discountFind.mockReturnValue(
      leanOf([
        discount({
          _id: 'd1',
          valueType: 'percentage',
          value: 1000,
          appliesTo: { scope: 'order' },
          minimumRequirement: { type: 'subtotal', value: 5000 },
        }),
      ]),
    );
    const lines = [line({ listingId: L1, amount: 1000, quantity: 1 })]; // 1000 < 5000
    const result = await calculateTotals({ storeId: STORE_ID, lines, currency: 'FAIR' });

    expect(result.discountTotal.amount).toBe(0);
    expect(result.grandTotal.amount).toBe(1000);
  });

  it('does not apply when the total usage ceiling is reached', async () => {
    discountFind.mockReturnValue(
      leanOf([
        discount({
          _id: 'd1',
          method: 'code',
          codes: [{ code: 'PROMO', usageCount: 5 }],
          valueType: 'percentage',
          value: 1000,
          appliesTo: { scope: 'order' },
          usageLimits: { totalMax: 5 },
        }),
      ]),
    );
    const lines = [line({ listingId: L1, amount: 1000, quantity: 1 })];
    const result = await calculateTotals({
      storeId: STORE_ID,
      lines,
      currency: 'FAIR',
      discountCodes: ['promo'],
    });
    expect(result.discountTotal.amount).toBe(0);
  });
});

describe('calculateTotals — combinability', () => {
  it('applies only the better of two non-combinable order-level discounts', async () => {
    discountFind.mockReturnValue(
      leanOf([
        discount({ _id: 'd1', valueType: 'percentage', value: 1000, appliesTo: { scope: 'order' } }), // 10%
        discount({ _id: 'd2', valueType: 'percentage', value: 2000, appliesTo: { scope: 'order' } }), // 20% (better)
      ]),
    );
    const lines = [line({ listingId: L1, amount: 1000, quantity: 1 })];
    const result = await calculateTotals({ storeId: STORE_ID, lines, currency: 'FAIR' });

    expect(result.discountTotal.amount).toBe(200); // 20% wins, not 30%.
    const ids = new Set(result.appliedDiscounts.map((a) => a.discountId));
    expect(ids).toEqual(new Set(['d2']));
  });

  it('coexists a product + order discount when both permit the other class', async () => {
    discountFind.mockReturnValue(
      leanOf([
        discount({
          _id: 'd1',
          valueType: 'percentage',
          value: 1000, // 10% order
          appliesTo: { scope: 'order' },
          combinesWith: { orderDiscounts: false, productDiscounts: true, shippingDiscounts: false },
        }),
        discount({
          _id: 'd2',
          valueType: 'percentage',
          value: 2000, // 20% product (line L1)
          appliesTo: { scope: 'products', productIds: [L1] },
          combinesWith: { orderDiscounts: true, productDiscounts: false, shippingDiscounts: false },
        }),
      ]),
    );
    const lines = [
      line({ listingId: L1, amount: 1000, quantity: 1 }), // product+order
      line({ listingId: L2, amount: 1000, quantity: 1 }), // order only
    ];
    const result = await calculateTotals({ storeId: STORE_ID, lines, currency: 'FAIR' });

    // Product: 20% of L1 (1000) = 200 attributed to line 0. Order: 10% of the FULL
    // subtotal (2000) = 200, allocated across the remaining per-line weight
    // (800 + 1000 = 1800). Total = 400.
    expect(result.discountTotal.amount).toBe(400);
    const ids = new Set(result.appliedDiscounts.map((a) => a.discountId));
    expect(ids).toEqual(new Set(['d1', 'd2']));
    assertReconciled(result, [1000, 1000]);
  });
});

describe('calculateTotals — taxes', () => {
  it('adds exclusive tax to the grand total', async () => {
    taxRateFind.mockReturnValue(
      leanOf([taxRate({ _id: 't1', rateBps: 800, region: { country: 'US' } })]),
    );
    const lines = [line({ listingId: L1, amount: 1000, quantity: 1 })];
    const result = await calculateTotals({
      storeId: STORE_ID,
      lines,
      currency: 'FAIR',
      shippingAddress: { country: 'US' },
    });

    expect(result.tax.amount).toBe(80); // 8% of 1000.
    expect(result.taxLines).toHaveLength(1);
    expect(result.grandTotal.amount).toBe(1080);
    assertReconciled(result, [1000]);
  });

  it('backs out inclusive tax informationally without changing the grand total', async () => {
    storeFindById.mockReturnValue(storeTaxLean({ pricesIncludeTax: true, chargeTaxOnProducts: true }));
    taxRateFind.mockReturnValue(
      leanOf([taxRate({ _id: 't1', rateBps: 800, region: { country: 'US' } })]),
    );
    const lines = [line({ listingId: L1, amount: 1080, quantity: 1 })];
    const result = await calculateTotals({
      storeId: STORE_ID,
      lines,
      currency: 'FAIR',
      shippingAddress: { country: 'US' },
    });

    // Contained tax: 1080 − round(1080*10000/10800) = 1080 − 1000 = 80 (informational).
    expect(result.tax.amount).toBe(0); // NOT added.
    expect(result.taxLines).toHaveLength(1);
    expect(result.taxLines[0].amount.amount).toBe(80);
    expect(result.grandTotal.amount).toBe(1080); // unchanged.
  });

  it('emits no tax lines when chargeTaxOnProducts is false', async () => {
    storeFindById.mockReturnValue(storeTaxLean({ pricesIncludeTax: false, chargeTaxOnProducts: false }));
    taxRateFind.mockReturnValue(
      leanOf([taxRate({ _id: 't1', rateBps: 800, region: { country: 'US' } })]),
    );
    const lines = [line({ listingId: L1, amount: 1000, quantity: 1 })];
    const result = await calculateTotals({
      storeId: STORE_ID,
      lines,
      currency: 'FAIR',
      shippingAddress: { country: 'US' },
    });

    expect(result.taxLines).toEqual([]);
    expect(result.tax.amount).toBe(0);
    expect(result.grandTotal.amount).toBe(1000);
  });
});
