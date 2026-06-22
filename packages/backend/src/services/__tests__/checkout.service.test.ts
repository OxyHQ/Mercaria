/**
 * Unit tests for `checkout.service`.
 *
 * `mongodb-memory-server` is not available, so the cart/inventory services, the
 * Listing/ProductVariant/Address/Order/Counter models, the order-hydration
 * summarizer, the media chokepoint and Redis are all mocked. Tests assert the F4
 * checkout contract: multi-seller split (one order per seller, shared
 * `checkoutGroupId`), reservation rollback on a later out-of-stock line,
 * idempotent replay via Redis, and that totals = subtotal + shipping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../order-hydration.service.js', () => ({
  summarizeOrders: (...args: unknown[]) => summarizeOrders(...args),
}));

vi.mock('../catalog-hydration.service.js', () => ({
  resolveMedia: (value: string) => `resolved:${value}`,
}));

vi.mock('../../lib/redis.js', () => ({
  getRedisClient: () => getRedisClient(),
  withRedisTimeout: (p: Promise<unknown>) => p,
}));

import { checkout } from '../checkout.service.js';
import { isMercariaError, outOfStock } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

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
    unitPrice: { amount: overrides.amount ?? 1000, currency: 'USD' as const },
    quantity: overrides.quantity ?? 1,
    available: 10,
    lineTotal: { amount: (overrides.amount ?? 1000) * (overrides.quantity ?? 1), currency: 'USD' as const },
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
    price: { amount: 1000, currency: 'USD' },
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
      currency: 'USD',
      items: [
        cartItem({ listingId: L1, variantId: V1 }),
        cartItem({ listingId: L2, variantId: V2 }),
        cartItem({ listingId: L3, variantId: V3 }),
      ],
      subtotal: { amount: 3000, currency: 'USD' },
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
      currency: 'USD',
      items: [
        cartItem({ listingId: L1, variantId: V1, quantity: 2 }),
        cartItem({ listingId: L2, variantId: V2, quantity: 5 }),
      ],
      subtotal: { amount: 7000, currency: 'USD' },
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
  it('sets grandTotal = subtotal + standard shipping', async () => {
    const L1 = '000000000000000000000501';
    const V1 = '000000000000000000000601';

    getCart.mockResolvedValueOnce({
      id: 'cart-1',
      currency: 'USD',
      items: [cartItem({ listingId: L1, variantId: V1, amount: 2500, quantity: 2 })], // line 5000
      subtotal: { amount: 5000, currency: 'USD' },
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
      totals: { subtotal: { amount: number }; shipping: { amount: number }; grandTotal: { amount: number } };
    };
    // subtotal 5000 + standard shipping 500 = 5500.
    expect(doc.totals.subtotal.amount).toBe(5000);
    expect(doc.totals.shipping.amount).toBe(500);
    expect(doc.totals.grandTotal.amount).toBe(5500);
  });
});
