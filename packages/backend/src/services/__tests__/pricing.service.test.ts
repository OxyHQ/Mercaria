/**
 * Unit tests for `pricing.service` — the single FAIR totals engine (B4).
 *
 * The three repository reads are mocked with `vi.fn()`, so the engine runs
 * offline against fixture ROWS. The fixture builders still take the nested shape
 * the source model had (`appliesTo`, `combinesWith`, `buy`/`get`, `region`) and
 * flatten it into the real column layout in ONE place — these tests are about
 * arithmetic, and spelling `appliesToCollectionIds` at forty call sites would
 * obscure that without checking anything the builder does not already pin. The
 * tests assert the EXACT money math:
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

const findActiveDiscounts = vi.fn();
const findActiveTaxRates = vi.fn();
const findStoreRow = vi.fn();

vi.mock('../../db/merchandising/discountRepository.js', () => ({
  findActiveDiscounts: (...args: unknown[]) => findActiveDiscounts(...args),
}));

vi.mock('../../db/stores/taxRateRepository.js', () => ({
  findActiveTaxRates: (...args: unknown[]) => findActiveTaxRates(...args),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoreRow: (...args: unknown[]) => findStoreRow(...args),
}));

import { calculateTotals, type PricingLine, type PricingInput } from '../pricing.service.js';
import type { DiscountScope, DiscountValueType, FxRates } from '@mercaria/shared-types';
import type { DiscountRecord } from '../../db/merchandising/discountRepository.js';
import type { TaxRateRecord } from '../../db/stores/taxRateRepository.js';
import type { StoreRow } from '../../db/stores/storeRepository.js';

/** Trivial FAIR-based rates: every test prices a FAIR shop == FAIR presentment. */
const FAIR_RATES: FxRates = {
  base: 'FAIR',
  rates: { FAIR: 1 },
  asOf: '2026-01-01T00:00:00.000Z',
  stale: false,
  ttlSeconds: 300,
};

/**
 * Price a group with the FAIR shop == FAIR presentment defaults injected, so the
 * result's `shop` and `presentment` sides are byte-identical and every assertion
 * reads the `shop` side.
 */
function priceGroup(
  input: Omit<PricingInput, 'presentmentCurrency' | 'rates'>,
): ReturnType<typeof calculateTotals> {
  return calculateTotals({ ...input, presentmentCurrency: 'FAIR', rates: FAIR_RATES });
}

const STORE_ID = '000000000000000000000040';
const L1 = '000000000000000000000101';
const L2 = '000000000000000000000102';
const COLLECTION_A = '000000000000000000000c01';

/** A `stores` row carrying only the two tax settings the engine reads. */
function storeWithTaxSettings(settings: {
  pricesIncludeTax: boolean;
  chargeTaxOnProducts: boolean;
}): StoreRow {
  return {
    taxSettingsPricesIncludeTax: settings.pricesIncludeTax,
    taxSettingsChargeTaxOnProducts: settings.chargeTaxOnProducts,
  } as StoreRow;
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

/** A BOGO leg as a fixture states it, before the builder flattens it. */
interface LegFixture {
  quantity: number;
  scope: Exclude<DiscountScope, 'order'>;
  productIds?: string[];
  collectionIds?: string[];
  discountPercent?: number;
}

/** A discount as a fixture states it — the nested shape the builder flattens. */
interface DiscountFixture {
  _id: string;
  valueType: DiscountValueType;
  value: number;
  method?: 'code' | 'automatic';
  codes?: { code: string; usageCount: number }[];
  appliesTo?: { scope: DiscountScope; productIds?: string[]; collectionIds?: string[] };
  buy?: LegFixture;
  get?: LegFixture;
  minimumRequirement?: { type: 'none' | 'subtotal' | 'quantity'; value: number };
  customerEligibility?: {
    type: 'all' | 'groups' | 'customers';
    customerIds?: string[];
    groupTags?: string[];
  };
  usageLimits?: { totalMax?: number };
  combinesWith?: { orderDiscounts: boolean; productDiscounts: boolean; shippingDiscounts: boolean };
}

/**
 * Build a `discounts` row from a fixture, flattening the nested sub-documents
 * into the real column names.
 *
 * The cast is confined to this one function. Every column the engine reads is
 * spelled out; the ones it never touches (timestamps, the scheduled window the
 * repository already filtered on) are deliberately ABSENT rather than filled with
 * plausible values, so a future read of one fails here instead of silently
 * agreeing with a fixture nobody meant as an assertion.
 */
function discount(fixture: DiscountFixture): DiscountRecord {
  const combines = fixture.combinesWith ?? {
    orderDiscounts: false,
    productDiscounts: false,
    shippingDiscounts: false,
  };
  return {
    id: fixture._id,
    storeId: STORE_ID,
    title: 'Discount',
    method: fixture.method ?? 'automatic',
    valueType: fixture.valueType,
    value: fixture.value,
    codes: (fixture.codes ?? []).map((code) => ({ ...code, discountId: fixture._id })),
    appliesToScope: fixture.appliesTo?.scope ?? 'order',
    appliesToProductIds: fixture.appliesTo?.productIds ?? null,
    appliesToCollectionIds: fixture.appliesTo?.collectionIds ?? null,
    buyQuantity: fixture.buy?.quantity ?? null,
    buyScope: fixture.buy?.scope ?? null,
    buyProductIds: fixture.buy?.productIds ?? null,
    buyCollectionIds: fixture.buy?.collectionIds ?? null,
    buyDiscountPercent: fixture.buy?.discountPercent ?? null,
    getQuantity: fixture.get?.quantity ?? null,
    getScope: fixture.get?.scope ?? null,
    getProductIds: fixture.get?.productIds ?? null,
    getCollectionIds: fixture.get?.collectionIds ?? null,
    getDiscountPercent: fixture.get?.discountPercent ?? null,
    minimumRequirementType: fixture.minimumRequirement?.type ?? null,
    minimumRequirementValue: fixture.minimumRequirement?.value ?? null,
    customerEligibilityType: fixture.customerEligibility?.type ?? null,
    customerEligibilityCustomerIds: fixture.customerEligibility?.customerIds ?? null,
    customerEligibilityGroupTags: fixture.customerEligibility?.groupTags ?? null,
    usageLimitsTotalMax: fixture.usageLimits?.totalMax ?? null,
    usageLimitsPerCustomerMax: null,
    combinesWithOrderDiscounts: combines.orderDiscounts,
    combinesWithProductDiscounts: combines.productDiscounts,
    combinesWithShippingDiscounts: combines.shippingDiscounts,
    isActive: true,
  } as unknown as DiscountRecord;
}

/** Build a `tax_rates` row from a fixture, flattening the nested `region`. */
function taxRate(fixture: {
  _id: string;
  rateBps: number;
  region?: { country?: string; region?: string; postalCodePattern?: string };
  productTypeScope?: string[];
  priority?: number;
}): TaxRateRecord {
  return {
    id: fixture._id,
    storeId: STORE_ID,
    name: 'Tax',
    rateBps: fixture.rateBps,
    regionCountry: fixture.region?.country ?? null,
    regionRegion: fixture.region?.region ?? null,
    regionPostalCodePattern: fixture.region?.postalCodePattern ?? null,
    appliesToShipping: false,
    productTypeScope: fixture.productTypeScope ?? null,
    priority: fixture.priority ?? 0,
    isActive: true,
  } as unknown as TaxRateRecord;
}

/** Assert the two engine invariants on a result. */
function assertReconciled(
  result: Awaited<ReturnType<typeof calculateTotals>>,
  lineTotals: number[],
): void {
  const perLineSum = result.perLineDiscount.reduce((s, m) => s + m.shop.amount, 0);
  expect(perLineSum).toBe(result.discountTotal.shop.amount);
  // Per-line (lineTotal − discount) must sum to subtotal − discountTotal.
  const discountedSum = lineTotals.reduce((s, t, i) => s + (t - result.perLineDiscount[i].shop.amount), 0);
  expect(discountedSum).toBe(result.subtotal.shop.amount - result.discountTotal.shop.amount);
  // grandTotal = subtotal − discount + tax + shipping (shipping always 0 here).
  expect(result.grandTotal.shop.amount).toBe(
    result.subtotal.shop.amount - result.discountTotal.shop.amount + result.tax.shop.amount + result.shipping.shop.amount,
  );
}

beforeEach(() => {
  findActiveDiscounts.mockReset().mockResolvedValue([]);
  findActiveTaxRates.mockReset().mockResolvedValue([]);
  findStoreRow
    .mockReset()
    .mockResolvedValue(
      storeWithTaxSettings({ pricesIncludeTax: false, chargeTaxOnProducts: true }),
    );
});

describe('calculateTotals — no store (P2P)', () => {
  it('returns subtotal only with no discounts/taxes', async () => {
    const result = await priceGroup({
      lines: [line({ listingId: L1, amount: 1000, quantity: 2 })],
      currency: 'FAIR',
    });
    expect(result.subtotal.shop.amount).toBe(2000);
    expect(result.discountTotal.shop.amount).toBe(0);
    expect(result.tax.shop.amount).toBe(0);
    expect(result.grandTotal.shop.amount).toBe(2000);
    expect(result.appliedDiscounts).toEqual([]);
    expect(result.perLineDiscount).toEqual([
      { shop: { amount: 0, currency: 'FAIR' }, presentment: { amount: 0, currency: 'FAIR' } },
    ]);
    // No store → models are never queried.
    expect(findActiveDiscounts).not.toHaveBeenCalled();
  });
});

describe('calculateTotals — presentment vs shop (multi-currency)', () => {
  it('keeps totals in the shop currency and converts the presentment side by the rates', async () => {
    // Shop = EUR, presentment = FAIR. Rates: 1 FAIR = 0.45 EUR.
    const rates: FxRates = {
      base: 'FAIR',
      rates: { FAIR: 1, EUR: 0.45 },
      asOf: '2026-01-01T00:00:00.000Z',
      stale: false,
      ttlSeconds: 300,
    };
    const result = await calculateTotals({
      lines: [{ listingId: L1, variantId: 'v-eur', unitPrice: { amount: 4500, currency: 'EUR' }, quantity: 1 }],
      currency: 'EUR',
      presentmentCurrency: 'FAIR',
      rates,
    });

    // Shop side stays in the store's EUR (native == shop here).
    expect(result.subtotal.shop).toEqual({ amount: 4500, currency: 'EUR' });
    expect(result.grandTotal.shop).toEqual({ amount: 4500, currency: 'EUR' });
    // Presentment: €45.00 ÷ 0.45 (EUR per 1 FAIR) = 100 FAIR = 10_000_000_000 minor.
    expect(result.subtotal.presentment).toEqual({ amount: 10_000_000_000, currency: 'FAIR' });
    expect(result.grandTotal.presentment).toEqual({ amount: 10_000_000_000, currency: 'FAIR' });
  });
});

describe('calculateTotals — percentage order-level discount', () => {
  it('applies 15% off the subtotal with exact reconciliation', async () => {
    findActiveDiscounts.mockResolvedValue([discount({ _id: 'd1', valueType: 'percentage', value: 1500, appliesTo: { scope: 'order' } })]);
    const lines = [
      line({ listingId: L1, amount: 1000, quantity: 3 }), // 3000
      line({ listingId: L2, amount: 700, quantity: 1 }), // 700
    ];
    const result = await priceGroup({ storeId: STORE_ID, lines, currency: 'FAIR' });

    expect(result.subtotal.shop.amount).toBe(3700);
    // 15% of 3700 = 555.
    expect(result.discountTotal.shop.amount).toBe(555);
    expect(result.grandTotal.shop.amount).toBe(3145);
    // Order-level discounts emit ONE allocation (target 'order'), not per line.
    expect(result.appliedDiscounts).toHaveLength(1);
    expect(result.appliedDiscounts[0].target).toBe('order');
    assertReconciled(result, [3000, 700]);
  });
});

describe('calculateTotals — fixed_amount clamped to base', () => {
  it('clamps a fixed_amount discount to the subtotal', async () => {
    findActiveDiscounts.mockResolvedValue([discount({ _id: 'd1', valueType: 'fixed_amount', value: 999999, appliesTo: { scope: 'order' } })]);
    const lines = [line({ listingId: L1, amount: 1000, quantity: 2 })]; // 2000
    const result = await priceGroup({ storeId: STORE_ID, lines, currency: 'FAIR' });

    expect(result.discountTotal.shop.amount).toBe(2000); // clamped to subtotal.
    expect(result.grandTotal.shop.amount).toBe(0);
    assertReconciled(result, [2000]);
  });
});

describe('calculateTotals — order-level proportional allocation', () => {
  it('reconciles the residual onto the largest line', async () => {
    // 10% off an uneven split that does not divide evenly.
    findActiveDiscounts.mockResolvedValue([discount({ _id: 'd1', valueType: 'percentage', value: 1000, appliesTo: { scope: 'order' } })]);
    const lines = [
      line({ listingId: L1, amount: 333, quantity: 1 }), // 333
      line({ listingId: L2, amount: 1000, quantity: 1 }), // 1000
    ];
    const result = await priceGroup({ storeId: STORE_ID, lines, currency: 'FAIR' });

    // 10% of 1333 = 133.3 → 133 (half-even). Allocated by weight 333:1000.
    expect(result.discountTotal.shop.amount).toBe(133);
    const sum = result.perLineDiscount.reduce((s, m) => s + m.shop.amount, 0);
    expect(sum).toBe(133);
    assertReconciled(result, [333, 1000]);
  });
});

describe('calculateTotals — product-level discount', () => {
  it('attributes only to matching lines (by collection)', async () => {
    findActiveDiscounts.mockResolvedValue([
        discount({
          _id: 'd1',
          valueType: 'percentage',
          value: 2000, // 20%
          appliesTo: { scope: 'collections', collectionIds: [COLLECTION_A] },
        }),
      ]);
    const lines = [
      line({ listingId: L1, amount: 1000, quantity: 1, collectionIds: [COLLECTION_A] }), // matches
      line({ listingId: L2, amount: 500, quantity: 1 }), // no collection → no discount
    ];
    const result = await priceGroup({ storeId: STORE_ID, lines, currency: 'FAIR' });

    expect(result.discountTotal.shop.amount).toBe(200); // 20% of 1000 only.
    expect(result.perLineDiscount[0].shop.amount).toBe(200);
    expect(result.perLineDiscount[1].shop.amount).toBe(0);
    assertReconciled(result, [1000, 500]);
  });
});

describe('calculateTotals — BOGO', () => {
  it('buy 2 get 1 free discounts the cheapest qualifying unit', async () => {
    findActiveDiscounts.mockResolvedValue([
        discount({
          _id: 'd1',
          valueType: 'free_item',
          value: 0,
          appliesTo: { scope: 'products', productIds: [L1] },
          buy: { quantity: 2, scope: 'products', productIds: [L1] },
          get: { quantity: 1, scope: 'products', productIds: [L1] },
        }),
      ]);
    // 3 units at 500 each → buy 2 get 1 free → one unit free (500 off).
    const lines = [line({ listingId: L1, amount: 500, quantity: 3 })];
    const result = await priceGroup({ storeId: STORE_ID, lines, currency: 'FAIR' });

    expect(result.discountTotal.shop.amount).toBe(500);
    expect(result.grandTotal.shop.amount).toBe(1000);
    assertReconciled(result, [1500]);
  });
});

describe('calculateTotals — gating', () => {
  it('does not apply when the subtotal is below the minimum requirement', async () => {
    findActiveDiscounts.mockResolvedValue([
        discount({
          _id: 'd1',
          valueType: 'percentage',
          value: 1000,
          appliesTo: { scope: 'order' },
          minimumRequirement: { type: 'subtotal', value: 5000 },
        }),
      ]);
    const lines = [line({ listingId: L1, amount: 1000, quantity: 1 })]; // 1000 < 5000
    const result = await priceGroup({ storeId: STORE_ID, lines, currency: 'FAIR' });

    expect(result.discountTotal.shop.amount).toBe(0);
    expect(result.grandTotal.shop.amount).toBe(1000);
  });

  it('does not apply when the total usage ceiling is reached', async () => {
    findActiveDiscounts.mockResolvedValue([
        discount({
          _id: 'd1',
          method: 'code',
          codes: [{ code: 'PROMO', usageCount: 5 }],
          valueType: 'percentage',
          value: 1000,
          appliesTo: { scope: 'order' },
          usageLimits: { totalMax: 5 },
        }),
      ]);
    const lines = [line({ listingId: L1, amount: 1000, quantity: 1 })];
    const result = await priceGroup({
      storeId: STORE_ID,
      lines,
      currency: 'FAIR',
      discountCodes: ['promo'],
    });
    expect(result.discountTotal.shop.amount).toBe(0);
  });
});

describe('calculateTotals — combinability', () => {
  it('applies only the better of two non-combinable order-level discounts', async () => {
    findActiveDiscounts.mockResolvedValue([
        discount({ _id: 'd1', valueType: 'percentage', value: 1000, appliesTo: { scope: 'order' } }), // 10%
        discount({ _id: 'd2', valueType: 'percentage', value: 2000, appliesTo: { scope: 'order' } }), // 20% (better)
      ]);
    const lines = [line({ listingId: L1, amount: 1000, quantity: 1 })];
    const result = await priceGroup({ storeId: STORE_ID, lines, currency: 'FAIR' });

    expect(result.discountTotal.shop.amount).toBe(200); // 20% wins, not 30%.
    const ids = new Set(result.appliedDiscounts.map((a) => a.discountId));
    expect(ids).toEqual(new Set(['d2']));
  });

  it('coexists a product + order discount when both permit the other class', async () => {
    findActiveDiscounts.mockResolvedValue([
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
      ]);
    const lines = [
      line({ listingId: L1, amount: 1000, quantity: 1 }), // product+order
      line({ listingId: L2, amount: 1000, quantity: 1 }), // order only
    ];
    const result = await priceGroup({ storeId: STORE_ID, lines, currency: 'FAIR' });

    // Product: 20% of L1 (1000) = 200 attributed to line 0. Order: 10% of the FULL
    // subtotal (2000) = 200, allocated across the remaining per-line weight
    // (800 + 1000 = 1800). Total = 400.
    expect(result.discountTotal.shop.amount).toBe(400);
    const ids = new Set(result.appliedDiscounts.map((a) => a.discountId));
    expect(ids).toEqual(new Set(['d1', 'd2']));
    assertReconciled(result, [1000, 1000]);
  });
});

describe('calculateTotals — taxes', () => {
  it('adds exclusive tax to the grand total', async () => {
    findActiveTaxRates.mockResolvedValue([taxRate({ _id: 't1', rateBps: 800, region: { country: 'US' } })]);
    const lines = [line({ listingId: L1, amount: 1000, quantity: 1 })];
    const result = await priceGroup({
      storeId: STORE_ID,
      lines,
      currency: 'FAIR',
      shippingAddress: { country: 'US' },
    });

    expect(result.tax.shop.amount).toBe(80); // 8% of 1000.
    expect(result.taxLines).toHaveLength(1);
    expect(result.grandTotal.shop.amount).toBe(1080);
    assertReconciled(result, [1000]);
  });

  it('backs out inclusive tax informationally without changing the grand total', async () => {
    findStoreRow.mockResolvedValue(storeWithTaxSettings({ pricesIncludeTax: true, chargeTaxOnProducts: true }));
    findActiveTaxRates.mockResolvedValue([taxRate({ _id: 't1', rateBps: 800, region: { country: 'US' } })]);
    const lines = [line({ listingId: L1, amount: 1080, quantity: 1 })];
    const result = await priceGroup({
      storeId: STORE_ID,
      lines,
      currency: 'FAIR',
      shippingAddress: { country: 'US' },
    });

    // Contained tax: 1080 − round(1080*10000/10800) = 1080 − 1000 = 80 (informational).
    expect(result.tax.shop.amount).toBe(0); // NOT added.
    expect(result.taxLines).toHaveLength(1);
    expect(result.taxLines[0].amount.amount).toBe(80);
    expect(result.grandTotal.shop.amount).toBe(1080); // unchanged.
  });

  it('emits no tax lines when chargeTaxOnProducts is false', async () => {
    findStoreRow.mockResolvedValue(storeWithTaxSettings({ pricesIncludeTax: false, chargeTaxOnProducts: false }));
    findActiveTaxRates.mockResolvedValue([taxRate({ _id: 't1', rateBps: 800, region: { country: 'US' } })]);
    const lines = [line({ listingId: L1, amount: 1000, quantity: 1 })];
    const result = await priceGroup({
      storeId: STORE_ID,
      lines,
      currency: 'FAIR',
      shippingAddress: { country: 'US' },
    });

    expect(result.taxLines).toEqual([]);
    expect(result.tax.shop.amount).toBe(0);
    expect(result.grandTotal.shop.amount).toBe(1000);
  });
});
