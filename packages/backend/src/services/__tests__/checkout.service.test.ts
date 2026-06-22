/**
 * Unit tests for `checkout.service`.
 *
 * `mongodb-memory-server` is not available, so the cart/inventory services, the
 * Listing/ProductVariant/Address/Order/Counter models, the order-hydration
 * summarizer, the media chokepoint, the pricing engine, the Discount model and
 * Redis are all mocked. Tests assert the F4 checkout contract: multi-seller split
 * (one order per seller, shared `checkoutGroupId`), reservation rollback on a
 * later out-of-stock line, idempotent replay via Redis, the B4 totals shape
 * (subtotal/discountTotal/shipping/tax/grandTotal), and that a redeemed discount's
 * usage increments EXACTLY once on a fresh checkout (never on replay).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PricingResult } from '../pricing.service.js';

const getCart = vi.fn();
const clearCart = vi.fn();
const reserve = vi.fn();
const release = vi.fn();
const listingFind = vi.fn();
const variantFind = vi.fn();
const addressFindOne = vi.fn();
const orderCreate = vi.fn();
const orderFind = vi.fn();
const nextOrderNumber = vi.fn();
const summarizeOrders = vi.fn();
const getRedisClient = vi.fn();
const enqueueOrderEvent = vi.fn();
const calculateTotals = vi.fn();
const discountUpdateOne = vi.fn();

vi.mock('../cart.service.js', () => ({
  getCart: (...args: unknown[]) => getCart(...args),
  clearCart: (...args: unknown[]) => clearCart(...args),
}));

vi.mock('../inventory.service.js', () => ({
  reserve: (...args: unknown[]) => reserve(...args),
  release: (...args: unknown[]) => release(...args),
}));

vi.mock('../../models/listing.js', () => ({
  Listing: { find: (...args: unknown[]) => listingFind(...args) },
}));

vi.mock('../../models/product-variant.js', () => ({
  ProductVariant: { find: (...args: unknown[]) => variantFind(...args) },
}));

vi.mock('../../models/address.js', () => ({
  Address: { findOne: (...args: unknown[]) => addressFindOne(...args) },
}));

vi.mock('../../models/order.js', () => ({
  Order: {
    create: (...args: unknown[]) => orderCreate(...args),
    find: (...args: unknown[]) => orderFind(...args),
  },
}));

vi.mock('../../models/counter.js', () => ({
  nextOrderNumber: (...args: unknown[]) => nextOrderNumber(...args),
}));

vi.mock('../../models/discount.js', () => ({
  Discount: { updateOne: (...args: unknown[]) => discountUpdateOne(...args) },
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

/**
 * A deterministic pricing result for a group: subtotal = sum of line totals,
 * zero discount/tax by default, grandTotal = subtotal (checkout adds shipping
 * afterward). `perLineDiscount` mirrors the group's line count.
 */
function pricingResultFor(lineCount: number, subtotal: number): PricingResult {
  const currency = 'FAIR' as const;
  return {
    subtotal: { amount: subtotal, currency },
    discountTotal: { amount: 0, currency },
    tax: { amount: 0, currency },
    shipping: { amount: 0, currency },
    grandTotal: { amount: subtotal, currency },
    appliedDiscounts: [],
    taxLines: [],
    perLineDiscount: Array.from({ length: lineCount }, () => ({ amount: 0, currency })),
  };
}

const USER = 'buyer-1';
const ADDRESS_ID = '000000000000000000000a01';

/** Build a `.lean()`-able query stub resolving to `value`. */
function leanOf<T>(value: T) {
  return { lean: () => Promise.resolve(value) };
}

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

/** A listing doc (store or user owned). */
function listingDoc(id: string, owner: { ownerType: 'store'; storeId: string } | { ownerType: 'user'; oxyUserId: string }) {
  return {
    _id: id,
    title: 'Thing',
    images: [{ fileId: 'img-1', position: 0 }],
    ...owner,
  };
}

/** A variant doc. */
function variantDoc(id: string, listingId: string) {
  return {
    _id: id,
    listingId,
    title: 'Default Title',
    optionValues: [],
    price: { amount: 1000, currency: 'FAIR' },
    inventory: { tracked: true, available: 10, committed: 0 },
  };
}

const addressDoc = {
  _id: ADDRESS_ID,
  oxyUserId: USER,
  recipientName: 'Buyer One',
  line1: '1 Main St',
  city: 'Town',
  postalCode: '00001',
  country: 'US',
};

beforeEach(() => {
  getCart.mockReset();
  clearCart.mockReset().mockResolvedValue(undefined);
  reserve.mockReset().mockResolvedValue(undefined);
  release.mockReset().mockResolvedValue(undefined);
  listingFind.mockReset();
  variantFind.mockReset();
  addressFindOne.mockReset();
  orderCreate.mockReset();
  orderFind.mockReset();
  nextOrderNumber.mockReset();
  summarizeOrders.mockReset();
  getRedisClient.mockReset().mockReturnValue(null);
  enqueueOrderEvent.mockReset().mockResolvedValue(undefined);
  discountUpdateOne.mockReset().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  // Default pricing: zero discount/tax, subtotal derived from the group's lines.
  calculateTotals.mockReset().mockImplementation((input: { lines: { unitPrice: { amount: number }; quantity: number }[] }) => {
    const subtotal = input.lines.reduce((s, l) => s + l.unitPrice.amount * l.quantity, 0);
    return Promise.resolve(pricingResultFor(input.lines.length, subtotal));
  });
});

describe('checkout.service.checkout — multi-seller split', () => {
  it('creates one order per seller, all sharing the same checkoutGroupId', async () => {
    const L1 = '000000000000000000000101';
    const L2 = '000000000000000000000102';
    const L3 = '000000000000000000000103';
    const V1 = '000000000000000000000201';
    const V2 = '000000000000000000000202';
    const V3 = '000000000000000000000203';

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
    addressFindOne.mockReturnValueOnce(leanOf(addressDoc));
    listingFind.mockReturnValueOnce(
      leanOf([
        listingDoc(L1, { ownerType: 'store', storeId: 'store-A' }),
        listingDoc(L2, { ownerType: 'store', storeId: 'store-B' }),
        listingDoc(L3, { ownerType: 'user', oxyUserId: 'seller-X' }),
      ]),
    );
    variantFind.mockReturnValueOnce(
      leanOf([variantDoc(V1, L1), variantDoc(V2, L2), variantDoc(V3, L3)]),
    );
    nextOrderNumber
      .mockResolvedValueOnce('MRC-000001')
      .mockResolvedValueOnce('MRC-000002')
      .mockResolvedValueOnce('MRC-000003');
    orderCreate.mockImplementation((doc: Record<string, unknown>) =>
      Promise.resolve({ toObject: () => ({ ...doc, _id: `order-${doc.orderNumber}` }) }),
    );
    summarizeOrders.mockImplementation((orders: unknown[]) =>
      Promise.resolve(orders.map((_, i) => ({ id: `o${i}`, orderNumber: `MRC-00000${i}`, status: 'pending_payment' }))),
    );

    const result = await checkout(USER, { addressId: ADDRESS_ID });

    expect(orderCreate).toHaveBeenCalledTimes(3);
    const groupIds = orderCreate.mock.calls.map((c) => (c[0] as { checkoutGroupId: string }).checkoutGroupId);
    expect(new Set(groupIds).size).toBe(1);
    expect(result.checkoutGroupId).toBe(groupIds[0]);
    expect(result.orders).toHaveLength(3);
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(clearCart).toHaveBeenCalledWith(USER);
  });
});

describe('checkout.service.checkout — reservation rollback', () => {
  it('releases prior reservations and creates no order when a later line is out of stock', async () => {
    const L1 = '000000000000000000000301';
    const L2 = '000000000000000000000302';
    const V1 = '000000000000000000000401';
    const V2 = '000000000000000000000402';

    getCart.mockResolvedValueOnce({
      id: 'cart-1',
      currency: 'FAIR',
      items: [
        cartItem({ listingId: L1, variantId: V1, quantity: 2 }),
        cartItem({ listingId: L2, variantId: V2, quantity: 5 }),
      ],
      subtotal: { amount: 7000, currency: 'FAIR' },
    });
    addressFindOne.mockReturnValueOnce(leanOf(addressDoc));
    listingFind.mockReturnValueOnce(
      leanOf([
        listingDoc(L1, { ownerType: 'user', oxyUserId: 'seller-X' }),
        listingDoc(L2, { ownerType: 'store', storeId: 'store-A' }),
      ]),
    );
    variantFind.mockReturnValueOnce(leanOf([variantDoc(V1, L1), variantDoc(V2, L2)]));

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
    expect(orderCreate).not.toHaveBeenCalled();
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

    const priorOrders = [{ _id: 'o1', checkoutGroupId: storedGroupId }];
    orderFind.mockReturnValueOnce(leanOf(priorOrders));
    summarizeOrders.mockResolvedValueOnce([{ id: 'o1', orderNumber: 'MRC-000001', status: 'paid' }]);

    const result = await checkout(USER, { addressId: ADDRESS_ID }, 'idem-key-1');

    expect(result.checkoutGroupId).toBe(storedGroupId);
    expect(reserve).not.toHaveBeenCalled();
    expect(orderCreate).not.toHaveBeenCalled();
    expect(getCart).not.toHaveBeenCalled();
  });
});

describe('checkout.service.checkout — totals', () => {
  it('sets grandTotal = pricing.grandTotal + standard shipping (B4 shape)', async () => {
    const L1 = '000000000000000000000501';
    const V1 = '000000000000000000000601';

    getCart.mockResolvedValueOnce({
      id: 'cart-1',
      currency: 'FAIR',
      items: [cartItem({ listingId: L1, variantId: V1, amount: 2500, quantity: 2 })], // line 5000
      subtotal: { amount: 5000, currency: 'FAIR' },
    });
    addressFindOne.mockReturnValueOnce(leanOf(addressDoc));
    listingFind.mockReturnValueOnce(leanOf([listingDoc(L1, { ownerType: 'store', storeId: 'store-A' })]));
    variantFind.mockReturnValueOnce(leanOf([variantDoc(V1, L1)]));
    nextOrderNumber.mockResolvedValueOnce('MRC-000010');
    orderCreate.mockImplementation((doc: Record<string, unknown>) =>
      Promise.resolve({ toObject: () => ({ ...doc, _id: 'order-1' }) }),
    );
    summarizeOrders.mockResolvedValueOnce([{ id: 'o1', orderNumber: 'MRC-000010', status: 'pending_payment' }]);

    await checkout(USER, { addressId: ADDRESS_ID });

    const doc = orderCreate.mock.calls[0][0] as {
      totals: {
        subtotal: { amount: number };
        discountTotal: { amount: number };
        shipping: { amount: number };
        tax: { amount: number };
        grandTotal: { amount: number };
      };
    };
    // subtotal 5000, no discount/tax + standard shipping 500 = 5500.
    expect(doc.totals.subtotal.amount).toBe(5000);
    expect(doc.totals.discountTotal.amount).toBe(0);
    expect(doc.totals.shipping.amount).toBe(500);
    expect(doc.totals.tax.amount).toBe(0);
    expect(doc.totals.grandTotal.amount).toBe(5500);
  });
});

describe('checkout.service.checkout — discounts', () => {
  /** Set up a single-store-group checkout whose pricing applies a code discount. */
  function arrangeDiscountedCheckout(): { L1: string; V1: string } {
    const L1 = '000000000000000000000701';
    const V1 = '000000000000000000000801';

    getCart.mockResolvedValueOnce({
      id: 'cart-1',
      currency: 'FAIR',
      items: [cartItem({ listingId: L1, variantId: V1, amount: 1000, quantity: 1 })],
      subtotal: { amount: 1000, currency: 'FAIR' },
      pendingDiscountCodes: ['WELCOME15'],
    });
    addressFindOne.mockReturnValueOnce(leanOf(addressDoc));
    listingFind.mockReturnValueOnce(leanOf([listingDoc(L1, { ownerType: 'store', storeId: 'store-A' })]));
    variantFind.mockReturnValueOnce(leanOf([variantDoc(V1, L1)]));
    nextOrderNumber.mockResolvedValue('MRC-000020');
    orderCreate.mockImplementation((doc: Record<string, unknown>) =>
      Promise.resolve({ toObject: () => ({ ...doc, _id: 'order-1' }) }),
    );
    summarizeOrders.mockResolvedValue([{ id: 'o1', orderNumber: 'MRC-000020', status: 'pending_payment' }]);

    // Pricing returns a 15% order discount on the 1000 line.
    calculateTotals.mockReset().mockResolvedValue({
      subtotal: { amount: 1000, currency: 'FAIR' },
      discountTotal: { amount: 150, currency: 'FAIR' },
      tax: { amount: 0, currency: 'FAIR' },
      shipping: { amount: 0, currency: 'FAIR' },
      grandTotal: { amount: 850, currency: 'FAIR' },
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
      perLineDiscount: [{ amount: 150, currency: 'FAIR' }],
    } satisfies PricingResult);

    return { L1, V1 };
  }

  it('persists the discount on the order and increments usage exactly once', async () => {
    arrangeDiscountedCheckout();

    await checkout(USER, { addressId: ADDRESS_ID });

    const doc = orderCreate.mock.calls[0][0] as {
      totals: { discountTotal: { amount: number }; grandTotal: { amount: number } };
      appliedDiscounts: { code: string }[];
      items: { discountTotal?: { amount: number } }[];
    };
    expect(doc.totals.discountTotal.amount).toBe(150);
    // grandTotal = pricing.grandTotal (850) + standard shipping (500).
    expect(doc.totals.grandTotal.amount).toBe(1350);
    expect(doc.appliedDiscounts).toHaveLength(1);
    expect(doc.appliedDiscounts[0].code).toBe('WELCOME15');
    expect(doc.items[0].discountTotal?.amount).toBe(150);

    // Usage incremented EXACTLY once for the redeemed code, via a guarded $inc.
    expect(discountUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = discountUpdateOne.mock.calls[0];
    expect((filter as { 'codes.code': string })['codes.code']).toBe('WELCOME15');
    expect(update).toEqual({ $inc: { 'codes.$[c].usageCount': 1 } });
    expect(options).toEqual({ arrayFilters: [{ 'c.code': 'WELCOME15' }] });
  });

  it('does NOT increment usage on an idempotent Redis replay', async () => {
    const storedGroupId = 'group-prior-2';
    const redis = {
      set: vi.fn().mockResolvedValue(null), // claim lost → already exists
      get: vi.fn().mockResolvedValue(storedGroupId),
    };
    getRedisClient.mockReturnValue(redis);

    orderFind.mockReturnValueOnce(leanOf([{ _id: 'o1', checkoutGroupId: storedGroupId }]));
    summarizeOrders.mockResolvedValueOnce([{ id: 'o1', orderNumber: 'MRC-000020', status: 'paid' }]);

    await checkout(USER, { addressId: ADDRESS_ID, discountCodes: ['WELCOME15'] }, 'idem-key-2');

    // Replay returns the prior orders — no pricing, no creation, no usage increment.
    expect(orderCreate).not.toHaveBeenCalled();
    expect(discountUpdateOne).not.toHaveBeenCalled();
  });
});
