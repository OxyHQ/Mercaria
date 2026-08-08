/**
 * Unit tests for `checkout.service`.
 *
 * The catalogue lives in Postgres now, so the listing/variant REPOSITORIES are
 * what this file mocks on that side — `findListingsByIds` / `findListingChildren`
 * and `findVariantsByIds` / `findVariantOptionValues` — as plain async functions
 * returning FLAT rows. Checkout resolves each cart line into a `ResolvedLine`
 * carrying `{cartItem, listing, variant, images, collectionIds, optionValues}`,
 * and the last three come from those two batched child reads rather than off the
 * documents, so the fixtures supply them separately from the rows.
 *
 * The order side is a repository too now — `insertOrder` takes the whole
 * aggregate (order + items + status history + allocations + tax lines) and
 * `nextOrderNumber` comes from a sequence rather than a counter document, so the
 * assertions read `insertOrder`'s input instead of a Mongo create document.
 * `redeemDiscountCode` replaces the guarded `$inc`: the ceiling check lives in
 * the repository, so what this file checks is that it is called EXACTLY once per
 * redeemed code on a fresh checkout and never on a replay.
 *
 * Everything else is mocked as before: the cart/inventory services, the still
 * Mongoose `Address` model, the store repository, the order-hydration
 * summarizer, the media chokepoint, the pricing engine and Redis.
 *
 * Tests assert the F4 checkout contract: multi-seller split (one order per
 * seller, shared `checkoutGroupId`), reservation rollback on a later
 * out-of-stock line, idempotent replay via Redis, the B4 totals shape
 * (subtotal/discountTotal/shipping/tax/grandTotal) with the line snapshot's
 * thumbnail and option values, that a redeemed discount's usage increments
 * EXACTLY once on a fresh checkout (never on replay), and that a variant with NO
 * price is REFUSED rather than snapshotted onto an order as free.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import type { PricingResult } from '../pricing.service.js';
import type { DualMoney, Money } from '@mercaria/shared-types';
import type {
  ListingChildren,
  ListingImageRecord,
  ListingRecord,
} from '../../db/catalog/listingRepository.js';
import type {
  VariantOptionValueRecord,
  VariantRecord,
} from '../../db/catalog/variantRepository.js';

const getCart = vi.fn();
const clearCart = vi.fn();
const removeCartLines = vi.fn();
const reserve = vi.fn();
const release = vi.fn();
const findListingsByIds = vi.fn();
const findListingChildren = vi.fn();
const findVariantsByIds = vi.fn();
const findVariantOptionValues = vi.fn();
const findStoresByIds = vi.fn();
const findAddress = vi.fn();
const insertOrder = vi.fn();
const findOrdersByCheckoutGroup = vi.fn();
const nextOrderNumber = vi.fn();
const summarizeOrders = vi.fn();
const getRedisClient = vi.fn();
const enqueueOrderEvent = vi.fn();
const calculateTotals = vi.fn();
const redeemDiscountCode = vi.fn();

vi.mock('../cart.service.js', () => ({
  getCart: (...args: unknown[]) => getCart(...args),
  clearCart: (...args: unknown[]) => clearCart(...args),
  removeCartLines: (...args: unknown[]) => removeCartLines(...args),
}));

vi.mock('../inventory.service.js', () => ({
  reserve: (...args: unknown[]) => reserve(...args),
  release: (...args: unknown[]) => release(...args),
}));

vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingsByIds: (...args: unknown[]) => findListingsByIds(...args),
  findListingChildren: (...args: unknown[]) => findListingChildren(...args),
}));

vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantsByIds: (...args: unknown[]) => findVariantsByIds(...args),
  findVariantOptionValues: (...args: unknown[]) => findVariantOptionValues(...args),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoresByIds: (...args: unknown[]) => findStoresByIds(...args),
}));

vi.mock('../../db/buyers/addressRepository.js', () => ({
  findAddress: (...args: unknown[]) => findAddress(...args),
}));

vi.mock('../../db/orders/orderRepository.js', () => ({
  insertOrder: (...args: unknown[]) => insertOrder(...args),
  findOrdersByCheckoutGroup: (...args: unknown[]) => findOrdersByCheckoutGroup(...args),
  findOrderByIdempotencyKey: vi.fn(),
  nextOrderNumber: (...args: unknown[]) => nextOrderNumber(...args),
}));

vi.mock('../../db/merchandising/discountRepository.js', () => ({
  redeemDiscountCode: (...args: unknown[]) => redeemDiscountCode(...args),
}));

vi.mock('../order-hydration.service.js', () => ({
  summarizeOrders: (...args: unknown[]) => summarizeOrders(...args),
}));

vi.mock('../catalog-hydration.service.js', () => ({
  resolveMedia: (value: string) => `resolved:${value}`,
}));

vi.mock('../pricing.service.js', () => ({
  calculateTotals: (...args: unknown[]) => calculateTotals(...args),
}));

vi.mock('../../queue/producers.js', () => ({
  enqueueOrderEvent: (...args: unknown[]) => enqueueOrderEvent(...args),
}));

vi.mock('../../lib/redis.js', () => ({
  getRedisClient: () => getRedisClient(),
  withRedisTimeout: (p: Promise<unknown>) => p,
}));

import { checkout } from '../checkout.service.js';
import { isMercariaError, outOfStock } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

/** A `DualMoney` in FAIR where shop == presentment (a same-currency checkout). */
function fairDual(amount: number): DualMoney {
  const money: Money = { amount, currency: 'FAIR' };
  return { shop: { ...money }, presentment: { ...money } };
}

/**
 * A deterministic pricing result for a group: subtotal = sum of line totals,
 * zero discount/tax by default, grandTotal = subtotal (checkout adds shipping
 * afterward). `perLineDiscount` mirrors the group's line count. Totals are
 * `DualMoney` (shop == presentment in these FAIR fixtures).
 */
function pricingResultFor(lineCount: number, subtotal: number): PricingResult {
  return {
    subtotal: fairDual(subtotal),
    discountTotal: fairDual(0),
    tax: fairDual(0),
    shipping: fairDual(0),
    grandTotal: fairDual(subtotal),
    appliedDiscounts: [],
    taxLines: [],
    perLineDiscount: Array.from({ length: lineCount }, () => fairDual(0)),
  };
}

const USER = 'buyer-1';
const ADDRESS_ID = uuidv7();

/** Every row fixture carries the same timestamps; none of them is asserted on. */
const AT = new Date('2026-01-01T00:00:00.000Z');

/** A cart item DTO as `getCart` returns it. */
function cartItem(overrides: { listingId: string; variantId: string; amount?: number; quantity?: number }) {
  return {
    listingId: overrides.listingId,
    variantId: overrides.variantId,
    title: 'Thing',
    variantTitle: 'Default Title',
    unitPrice: { amount: overrides.amount ?? 1000, currency: 'FAIR' as const },
    quantity: overrides.quantity ?? 1,
    available: 10,
    lineTotal: { amount: (overrides.amount ?? 1000) * (overrides.quantity ?? 1), currency: 'FAIR' as const },
  };
}

/**
 * A `listings` ROW (store- or user-owned) as the repository returns it: flat,
 * `id` not `_id`, and with NO `images` array — the gallery is a child table.
 *
 * The owner argument moves BOTH owner columns, since
 * `listings_owner_exclusivity_check` refuses a row carrying an `oxyUserId` and a
 * `storeId` at once.
 */
function listingRow(
  id: string,
  owner: { ownerType: 'store'; storeId: string } | { ownerType: 'user'; oxyUserId: string },
): ListingRecord {
  return {
    id,
    ownerType: owner.ownerType,
    oxyUserId: owner.ownerType === 'user' ? owner.oxyUserId : null,
    storeId: owner.ownerType === 'store' ? owner.storeId : null,
    title: 'Thing',
    description: 'A thing',
    condition: 'new',
    status: 'active',
    categoryId: null,
    categorySlugs: [],
    tags: [],
    priceRangeMinAmount: null,
    priceRangeMinCurrency: null,
    priceRangeMaxAmount: null,
    priceRangeMaxCurrency: null,
    hasInventory: true,
    variantCount: 1,
    longitude: null,
    latitude: null,
    geo: null,
    vendor: null,
    productType: null,
    handle: null,
    seoTitle: null,
    seoDescription: null,
    sourceConnectionId: null,
    sourceProvider: null,
    sourceExternalId: null,
    sourceExternalUpdatedAt: null,
    overriddenFields: [],
    rating: 0,
    reviewCount: 0,
    favoriteCount: 0,
    publishedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    searchVector: '',
  };
}

/**
 * A `product_variants` ROW. Its NATIVE `priceAmount`/`priceCurrency` drive
 * pricing and the order money (default ⊜1000); both columns are nullable and
 * absent TOGETHER, which is the `product_variants_price_paired_check` shape.
 */
function variantRow(
  id: string,
  listingId: string,
  amount: number | null = 1000,
): VariantRecord {
  return {
    id,
    listingId,
    title: 'Default Title',
    sku: null,
    barcode: null,
    priceAmount: amount,
    priceCurrency: amount === null ? null : 'FAIR',
    compareAtPriceAmount: null,
    compareAtPriceCurrency: null,
    inventoryTracked: true,
    inventoryAvailable: 10,
    inventoryCommitted: 0,
    sourceConnectionId: null,
    sourceProvider: null,
    sourceExternalVariantId: null,
    sourceExternalInventoryItemId: null,
    position: 0,
    createdAt: AT,
    updatedAt: AT,
  };
}

/** One `listing_images` row. */
function imageRow(listingId: string, fileId: string, position = 0): ListingImageRecord {
  return { id: uuidv7(), listingId, fileId, alt: null, position, createdAt: AT, updatedAt: AT };
}

/** One `product_variant_option_values` row. */
function optionValueRow(variantId: string, name: string, value: string): VariantOptionValueRecord {
  return { id: uuidv7(), variantId, name, value, position: 0, createdAt: AT, updatedAt: AT };
}

/**
 * The default `findListingChildren` batch: every listing asked for has a single
 * gallery image `img-1` and no options/collection memberships. This mirrors the
 * old fixture, where each listing document carried `images: [{fileId: 'img-1'}]`.
 */
function childrenWithOneImageEach(listingIds: readonly string[]): ListingChildren {
  return {
    images: new Map(listingIds.map((id) => [id, [imageRow(id, 'img-1')]])),
    options: new Map(),
    collectionIds: new Map(),
  };
}

/**
 * An `addresses` ROW as `findAddress` returns it: flat, `id` rather than `_id`,
 * and every optional field NULL rather than absent. `snapshotAddress` must leave
 * all four off the order's address snapshot — a snapshot carrying `line2: null`
 * prints a blank line on the shipping label.
 */
const addressRow = {
  id: ADDRESS_ID,
  oxyUserId: USER,
  label: null,
  recipientName: 'Buyer One',
  line1: '1 Main St',
  line2: null,
  city: 'Town',
  region: null,
  postalCode: '00001',
  country: 'US',
  phone: null,
  isDefault: true,
  createdAt: AT,
  updatedAt: AT,
};

beforeEach(() => {
  getCart.mockReset();
  clearCart.mockReset().mockResolvedValue(undefined);
  removeCartLines.mockReset().mockResolvedValue(undefined);
  reserve.mockReset().mockResolvedValue(undefined);
  release.mockReset().mockResolvedValue(undefined);
  findListingsByIds.mockReset();
  findVariantsByIds.mockReset();
  // The gallery and the variant option values are batched child reads now.
  findListingChildren.mockReset().mockImplementation((listingIds: readonly string[]) =>
    Promise.resolve(childrenWithOneImageEach(listingIds)),
  );
  findVariantOptionValues.mockReset().mockResolvedValue(new Map());
  // No store docs found → shop currency falls back to a line's native currency (FAIR).
  findStoresByIds.mockReset().mockResolvedValue([]);
  findAddress.mockReset();
  insertOrder.mockReset();
  findOrdersByCheckoutGroup.mockReset();
  nextOrderNumber.mockReset();
  summarizeOrders.mockReset();
  getRedisClient.mockReset().mockReturnValue(null);
  enqueueOrderEvent.mockReset().mockResolvedValue(undefined);
  redeemDiscountCode.mockReset().mockResolvedValue(true);
  // Default pricing: zero discount/tax, subtotal derived from the group's lines.
  calculateTotals.mockReset().mockImplementation((input: { lines: { unitPrice: { amount: number }; quantity: number }[] }) => {
    const subtotal = input.lines.reduce((s, l) => s + l.unitPrice.amount * l.quantity, 0);
    return Promise.resolve(pricingResultFor(input.lines.length, subtotal));
  });
});

describe('checkout.service.checkout — multi-seller split', () => {
  it('creates one order per seller, all sharing the same checkoutGroupId', async () => {
    const L1 = uuidv7();
    const L2 = uuidv7();
    const L3 = uuidv7();
    const V1 = uuidv7();
    const V2 = uuidv7();
    const V3 = uuidv7();

    getCart.mockResolvedValueOnce({
      id: 'cart-1',
      currency: 'FAIR',
      items: [
        cartItem({ listingId: L1, variantId: V1 }),
        cartItem({ listingId: L2, variantId: V2 }),
        cartItem({ listingId: L3, variantId: V3 }),
      ],
      subtotal: { amount: 3000, currency: 'FAIR' },
    });
    findAddress.mockResolvedValueOnce(addressRow);
    findListingsByIds.mockResolvedValueOnce([
      listingRow(L1, { ownerType: 'store', storeId: 'store-A' }),
      listingRow(L2, { ownerType: 'store', storeId: 'store-B' }),
      listingRow(L3, { ownerType: 'user', oxyUserId: 'seller-X' }),
    ]);
    findVariantsByIds.mockResolvedValueOnce([
      variantRow(V1, L1),
      variantRow(V2, L2),
      variantRow(V3, L3),
    ]);
    nextOrderNumber
      .mockResolvedValueOnce('MRC-000001')
      .mockResolvedValueOnce('MRC-000002')
      .mockResolvedValueOnce('MRC-000003');
    insertOrder.mockImplementation((input: Record<string, unknown>) =>
      Promise.resolve({ ...input, id: `order-${String(input.orderNumber)}` }),
    );
    summarizeOrders.mockImplementation((orders: unknown[]) =>
      Promise.resolve(orders.map((_, i) => ({ id: `o${i}`, orderNumber: `MRC-00000${i}`, status: 'pending_payment' }))),
    );

    const result = await checkout(USER, { addressId: ADDRESS_ID });

    expect(insertOrder).toHaveBeenCalledTimes(3);
    const groupIds = insertOrder.mock.calls.map((c) => (c[0] as { checkoutGroupId: string }).checkoutGroupId);
    expect(new Set(groupIds).size).toBe(1);
    expect(result.checkoutGroupId).toBe(groupIds[0]);
    expect(result.orders).toHaveLength(3);
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(clearCart).toHaveBeenCalledWith(USER);
  });
});

describe('checkout.service.checkout — a native non-FAIR checkout', () => {
  it('places a EUR order end to end and snapshots a complete EUR→EUR rate', async () => {
    // Everything about this sale is EUR: the listing's native price, the P2P
    // seller's accounting currency and the buyer's presentment currency. Nothing
    // is converted, so no cross-currency rate is consulted and the sale does not
    // depend on FAIR being quotable — the point of the case.
    const L1 = uuidv7();
    const V1 = uuidv7();
    const eur = (amount: number): Money => ({ amount, currency: 'EUR' });

    getCart.mockResolvedValueOnce({
      id: 'cart-eur',
      currency: 'EUR',
      items: [
        {
          ...cartItem({ listingId: L1, variantId: V1, amount: 4500 }),
          unitPrice: eur(4500),
          lineTotal: eur(4500),
        },
      ],
      subtotal: eur(4500),
    });
    findAddress.mockResolvedValueOnce(addressRow);
    findListingsByIds.mockResolvedValueOnce([
      listingRow(L1, { ownerType: 'user', oxyUserId: 'seller-X' }),
    ]);
    // The variant's NATIVE price columns are what make this a EUR sale end to
    // end — the seller's accounting currency falls back to the line's own
    // currency for a P2P group, so nothing here is FAIR.
    findVariantsByIds.mockResolvedValueOnce([
      { ...variantRow(V1, L1, 4500), priceCurrency: 'EUR' },
    ]);
    calculateTotals.mockImplementationOnce(() => {
      const dual = (amount: number): DualMoney => ({ shop: eur(amount), presentment: eur(amount) });
      return Promise.resolve({
        subtotal: dual(4500),
        discountTotal: dual(0),
        tax: dual(0),
        shipping: dual(0),
        grandTotal: dual(4500),
        appliedDiscounts: [],
        taxLines: [],
        perLineDiscount: [dual(0)],
      });
    });
    nextOrderNumber.mockResolvedValueOnce('MRC-000900');
    insertOrder.mockImplementation((input: Record<string, unknown>) =>
      Promise.resolve({ ...input, id: 'order-eur' }),
    );
    summarizeOrders.mockResolvedValueOnce([
      { id: 'order-eur', orderNumber: 'MRC-000900', status: 'pending_payment' },
    ]);

    await checkout(USER, { addressId: ADDRESS_ID });

    expect(insertOrder).toHaveBeenCalledTimes(1);
    const doc = insertOrder.mock.calls[0][0] as {
      totals: { grandTotal: DualMoney };
      fxRate: { from: string; to: string; rate: number; provider: string; asOf: string };
    };
    // The pricing engine was asked to price in EUR, and both money sides are EUR.
    expect(calculateTotals.mock.calls[0][0]).toMatchObject({
      currency: 'EUR',
      presentmentCurrency: 'EUR',
    });
    expect(doc.totals.grandTotal.shop.currency).toBe('EUR');
    expect(doc.totals.grandTotal.presentment.currency).toBe('EUR');
    // The snapshot is COMPLETE — a rate nobody can attribute is not reproducible.
    expect(doc.fxRate.from).toBe('EUR');
    expect(doc.fxRate.to).toBe('EUR');
    expect(doc.fxRate.rate).toBe(1);
    expect(doc.fxRate.provider).toEqual(expect.any(String));
    expect(doc.fxRate.provider.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(doc.fxRate.asOf))).toBe(false);
  });
});

describe('checkout.service.checkout — reservation rollback', () => {
  it('releases prior reservations and creates no order when a later line is out of stock', async () => {
    const L1 = uuidv7();
    const L2 = uuidv7();
    const V1 = uuidv7();
    const V2 = uuidv7();

    getCart.mockResolvedValueOnce({
      id: 'cart-1',
      currency: 'FAIR',
      items: [
        cartItem({ listingId: L1, variantId: V1, quantity: 2 }),
        cartItem({ listingId: L2, variantId: V2, quantity: 5 }),
      ],
      subtotal: { amount: 7000, currency: 'FAIR' },
    });
    findAddress.mockResolvedValueOnce(addressRow);
    findListingsByIds.mockResolvedValueOnce([
      listingRow(L1, { ownerType: 'user', oxyUserId: 'seller-X' }),
      listingRow(L2, { ownerType: 'store', storeId: 'store-A' }),
    ]);
    findVariantsByIds.mockResolvedValueOnce([variantRow(V1, L1), variantRow(V2, L2)]);

    // First reserve succeeds; second throws OUT_OF_STOCK.
    reserve
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(outOfStock('Insufficient stock to reserve'));

    await expect(checkout(USER, { addressId: ADDRESS_ID })).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.OUT_OF_STOCK,
    );

    // Only the first (succeeded) line is released; the failing line is not.
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(V1, 2);
    expect(release).not.toHaveBeenCalledWith(V2, 5);
    expect(insertOrder).not.toHaveBeenCalled();
  });
});

describe('checkout.service.checkout — idempotent replay', () => {
  it('returns the original orders without reserving or creating again', async () => {
    const storedGroupId = 'group-prior-1';
    const redis = {
      set: vi.fn().mockResolvedValue(null), // claim lost → already exists
      get: vi.fn().mockResolvedValue(storedGroupId),
    };
    getRedisClient.mockReturnValue(redis);

    const priorOrders = [{ id: 'o1', checkoutGroupId: storedGroupId }];
    findOrdersByCheckoutGroup.mockResolvedValueOnce(priorOrders);
    summarizeOrders.mockResolvedValueOnce([{ id: 'o1', orderNumber: 'MRC-000001', status: 'paid' }]);

    const result = await checkout(USER, { addressId: ADDRESS_ID }, 'idem-key-1');

    expect(result.checkoutGroupId).toBe(storedGroupId);
    expect(reserve).not.toHaveBeenCalled();
    expect(insertOrder).not.toHaveBeenCalled();
    expect(getCart).not.toHaveBeenCalled();
  });
});

describe('checkout.service.checkout — totals', () => {
  it('sets grandTotal = pricing.grandTotal + standard shipping (B4 shape)', async () => {
    const L1 = uuidv7();
    const V1 = uuidv7();

    getCart.mockResolvedValueOnce({
      id: 'cart-1',
      currency: 'FAIR',
      items: [cartItem({ listingId: L1, variantId: V1, amount: 2500, quantity: 2 })], // line 5000
      subtotal: { amount: 5000, currency: 'FAIR' },
    });
    findAddress.mockResolvedValueOnce(addressRow);
    findListingsByIds.mockResolvedValueOnce([listingRow(L1, { ownerType: 'store', storeId: 'store-A' })]);
    // Native variant price ⊜2500 × 2 = the ⊜5000 line the mock pricing sums.
    findVariantsByIds.mockResolvedValueOnce([variantRow(V1, L1, 2500)]);
    // The snapshotted option values come from the variant's CHILD table.
    findVariantOptionValues.mockResolvedValueOnce(
      new Map([[V1, [optionValueRow(V1, 'Size', 'M')]]]),
    );
    nextOrderNumber.mockResolvedValueOnce('MRC-000010');
    insertOrder.mockImplementation((input: Record<string, unknown>) =>
      Promise.resolve({ ...input, id: 'order-1' }),
    );
    summarizeOrders.mockResolvedValueOnce([{ id: 'o1', orderNumber: 'MRC-000010', status: 'pending_payment' }]);

    await checkout(USER, { addressId: ADDRESS_ID });

    const doc = insertOrder.mock.calls[0][0] as {
      items: {
        imageUrl?: string;
        optionValues: { name: string; value: string }[];
      }[];
      totals: {
        subtotal: { shop: { amount: number } };
        discountTotal: { shop: { amount: number } };
        shipping: { shop: { amount: number } };
        tax: { shop: { amount: number } };
        grandTotal: { shop: { amount: number }; presentment: { amount: number } };
      };
    };
    // subtotal 5000, no discount/tax + standard shipping 500 = 5500 (shop side).
    expect(doc.totals.subtotal.shop.amount).toBe(5000);
    expect(doc.totals.discountTotal.shop.amount).toBe(0);
    expect(doc.totals.shipping.shop.amount).toBe(500);
    expect(doc.totals.tax.shop.amount).toBe(0);
    expect(doc.totals.grandTotal.shop.amount).toBe(5500);
    // FAIR shop == FAIR presentment, so the presentment grand total matches.
    expect(doc.totals.grandTotal.presentment.amount).toBe(5500);
    // The immutable line snapshot still carries the thumbnail and the option
    // values, which now travel with the resolved line from the two child reads
    // rather than off the listing/variant documents.
    expect(doc.items[0].imageUrl).toBe('resolved:img-1');
    expect(doc.items[0].optionValues).toEqual([{ name: 'Size', value: 'M' }]);
  });
});

describe('checkout.service.checkout — unpriced variant', () => {
  it('refuses the checkout with CONFLICT rather than snapshotting a free line', async () => {
    const L1 = uuidv7();
    const V1 = uuidv7();

    getCart.mockResolvedValueOnce({
      id: 'cart-1',
      currency: 'FAIR',
      items: [cartItem({ listingId: L1, variantId: V1 })],
      subtotal: { amount: 1000, currency: 'FAIR' },
    });
    findAddress.mockResolvedValueOnce(addressRow);
    findListingsByIds.mockResolvedValueOnce([listingRow(L1, { ownerType: 'store', storeId: 'store-A' })]);
    // Both price columns NULL together — the shape the paired CHECK allows, and
    // the one the port made representable (Mongoose declared `price` required).
    findVariantsByIds.mockResolvedValueOnce([variantRow(V1, L1, null)]);

    await expect(checkout(USER, { addressId: ADDRESS_ID })).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );

    // Nothing is priced, ordered or taken out of the cart: a zero snapshotted
    // onto an order is a price the buyer would be held to.
    expect(calculateTotals).not.toHaveBeenCalled();
    expect(insertOrder).not.toHaveBeenCalled();
    expect(clearCart).not.toHaveBeenCalled();
    expect(removeCartLines).not.toHaveBeenCalled();
  });
});

describe('checkout.service.checkout — discounts', () => {
  /** Set up a single-store-group checkout whose pricing applies a code discount. */
  function arrangeDiscountedCheckout(): { L1: string; V1: string } {
    const L1 = uuidv7();
    const V1 = uuidv7();

    getCart.mockResolvedValueOnce({
      id: 'cart-1',
      currency: 'FAIR',
      items: [cartItem({ listingId: L1, variantId: V1, amount: 1000, quantity: 1 })],
      subtotal: { amount: 1000, currency: 'FAIR' },
      pendingDiscountCodes: ['WELCOME15'],
    });
    findAddress.mockResolvedValueOnce(addressRow);
    findListingsByIds.mockResolvedValueOnce([listingRow(L1, { ownerType: 'store', storeId: 'store-A' })]);
    findVariantsByIds.mockResolvedValueOnce([variantRow(V1, L1)]);
    nextOrderNumber.mockResolvedValue('MRC-000020');
    insertOrder.mockImplementation((input: Record<string, unknown>) =>
      Promise.resolve({ ...input, id: 'order-1' }),
    );
    summarizeOrders.mockResolvedValue([{ id: 'o1', orderNumber: 'MRC-000020', status: 'pending_payment' }]);

    // Pricing returns a 15% order discount on the 1000 line (shop == presentment).
    calculateTotals.mockReset().mockResolvedValue({
      subtotal: fairDual(1000),
      discountTotal: fairDual(150),
      tax: fairDual(0),
      shipping: fairDual(0),
      grandTotal: fairDual(850),
      appliedDiscounts: [
        {
          discountId: 'd1',
          code: 'WELCOME15',
          title: 'Welcome 15% off',
          valueType: 'percentage',
          amount: { amount: 150, currency: 'FAIR' },
          target: 'order',
        },
      ],
      taxLines: [],
      perLineDiscount: [fairDual(150)],
    } satisfies PricingResult);

    return { L1, V1 };
  }

  it('persists the discount on the order and increments usage exactly once', async () => {
    arrangeDiscountedCheckout();

    await checkout(USER, { addressId: ADDRESS_ID });

    const doc = insertOrder.mock.calls[0][0] as {
      totals: { discountTotal: { shop: { amount: number } }; grandTotal: { shop: { amount: number } } };
      appliedDiscounts: { code: string }[];
      items: { discountTotal?: { shop: { amount: number } } }[];
    };
    expect(doc.totals.discountTotal.shop.amount).toBe(150);
    // grandTotal = pricing.grandTotal (850) + standard shipping (500).
    expect(doc.totals.grandTotal.shop.amount).toBe(1350);
    expect(doc.appliedDiscounts).toHaveLength(1);
    expect(doc.appliedDiscounts[0].code).toBe('WELCOME15');
    expect(doc.items[0].discountTotal?.shop.amount).toBe(150);

    // Usage counted EXACTLY once for the redeemed code. The ceiling guard lives
    // in the repository (which serializes on the parent discount before
    // counting); what checkout owns is calling it once per applied code.
    expect(redeemDiscountCode).toHaveBeenCalledTimes(1);
    expect(redeemDiscountCode).toHaveBeenCalledWith('WELCOME15');
  });

  it('does NOT increment usage on an idempotent Redis replay', async () => {
    const storedGroupId = 'group-prior-2';
    const redis = {
      set: vi.fn().mockResolvedValue(null), // claim lost → already exists
      get: vi.fn().mockResolvedValue(storedGroupId),
    };
    getRedisClient.mockReturnValue(redis);

    findOrdersByCheckoutGroup.mockResolvedValueOnce([{ id: 'o1', checkoutGroupId: storedGroupId }]);
    summarizeOrders.mockResolvedValueOnce([{ id: 'o1', orderNumber: 'MRC-000020', status: 'paid' }]);

    await checkout(USER, { addressId: ADDRESS_ID, discountCodes: ['WELCOME15'] }, 'idem-key-2');

    // Replay returns the prior orders — no pricing, no creation, no usage increment.
    expect(insertOrder).not.toHaveBeenCalled();
    expect(redeemDiscountCode).not.toHaveBeenCalled();
  });
});

describe('checkout.service.checkout — per-seller (sellerKeys) subset', () => {
  const L1 = uuidv7();
  const L2 = uuidv7();
  const V1 = uuidv7();
  const V2 = uuidv7();

  /** A two-store cart (store-A line V1, store-B line V2) ready to check out. */
  function arrangeTwoStoreCart(): void {
    getCart.mockResolvedValueOnce({
      id: 'cart-1',
      currency: 'FAIR',
      items: [
        cartItem({ listingId: L1, variantId: V1 }),
        cartItem({ listingId: L2, variantId: V2 }),
      ],
      subtotal: { amount: 2000, currency: 'FAIR' },
    });
    findAddress.mockResolvedValueOnce(addressRow);
    findListingsByIds.mockResolvedValueOnce([
      listingRow(L1, { ownerType: 'store', storeId: 'store-A' }),
      listingRow(L2, { ownerType: 'store', storeId: 'store-B' }),
    ]);
    findVariantsByIds.mockResolvedValueOnce([variantRow(V1, L1), variantRow(V2, L2)]);
    nextOrderNumber.mockResolvedValue('MRC-000030');
    insertOrder.mockImplementation((input: Record<string, unknown>) =>
      Promise.resolve({ ...input, id: `order-${String(input.orderNumber)}` }),
    );
    summarizeOrders.mockResolvedValue([{ id: 'o1', orderNumber: 'MRC-000030', status: 'pending_payment' }]);
  }

  it('places only the requested seller group and removes just its lines (rest stays in cart)', async () => {
    arrangeTwoStoreCart();

    const result = await checkout(USER, { addressId: ADDRESS_ID, sellerKeys: ['store:store-A'] });

    // Only store-A's single line is reserved + ordered.
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(V1, 1);
    expect(insertOrder).toHaveBeenCalledTimes(1);
    expect((insertOrder.mock.calls[0][0] as { storeId: string }).storeId).toBe('store-A');
    expect(result.orders).toHaveLength(1);

    // Partial checkout: remove only the placed line, keep the rest — never clearCart.
    expect(removeCartLines).toHaveBeenCalledWith(USER, [V1]);
    expect(clearCart).not.toHaveBeenCalled();
  });

  it('rejects when no cart group matches sellerKeys, without touching stock or cart', async () => {
    arrangeTwoStoreCart();

    await expect(
      checkout(USER, { addressId: ADDRESS_ID, sellerKeys: ['store:store-ZZZ'] }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );

    expect(reserve).not.toHaveBeenCalled();
    expect(insertOrder).not.toHaveBeenCalled();
    expect(removeCartLines).not.toHaveBeenCalled();
    expect(clearCart).not.toHaveBeenCalled();
  });
});
