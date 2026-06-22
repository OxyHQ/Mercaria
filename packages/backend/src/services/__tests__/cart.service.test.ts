/**
 * Unit tests for `cart.service`.
 *
 * `mongodb-memory-server` is not available, so the `Cart`, `Listing` and
 * `ProductVariant` models — plus the media chokepoint (`resolveMedia`) — are
 * mocked. Tests cover the F3 cart contract: quantity clamps to `available`, a
 * second add of the same variant increments, cross-currency adds are rejected
 * (CONFLICT), `revalidate` flags an under-stocked line `stale`, and the subtotal
 * equals the sum of line totals (live prices).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const cartFindOne = vi.fn();
const cartCreate = vi.fn();
const cartUpdateOne = vi.fn();
const listingFindById = vi.fn();
const listingFind = vi.fn();
const variantFindById = vi.fn();
const variantFind = vi.fn();

vi.mock('../../models/cart.js', () => ({
  Cart: {
    findOne: (...args: unknown[]) => cartFindOne(...args),
    create: (...args: unknown[]) => cartCreate(...args),
    updateOne: (...args: unknown[]) => cartUpdateOne(...args),
  },
}));

vi.mock('../../models/listing.js', () => ({
  Listing: {
    findById: (...args: unknown[]) => listingFindById(...args),
    find: (...args: unknown[]) => listingFind(...args),
  },
}));

vi.mock('../../models/product-variant.js', () => ({
  ProductVariant: {
    findById: (...args: unknown[]) => variantFindById(...args),
    find: (...args: unknown[]) => variantFind(...args),
  },
}));

vi.mock('../catalog-hydration.service.js', () => ({
  resolveMedia: (value: string) => `resolved:${value}`,
}));

import { addItem, revalidate, getCart } from '../cart.service.js';
import type { ICart } from '../../models/cart.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const USER = 'user-1';
const LISTING_ID = '000000000000000000000001';
const VARIANT_ID = '000000000000000000000002';
const CART_ID = '000000000000000000000003';

/** Build a `.lean()`-able query stub resolving to `value`. */
function leanOf<T>(value: T) {
  return { lean: () => Promise.resolve(value) };
}

function listingDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: LISTING_ID,
    title: 'Cool Thing',
    status: 'active',
    images: [{ fileId: 'img-1', position: 0 }],
    ...overrides,
  };
}

function variantDoc(overrides: { available?: number; tracked?: boolean; currency?: string; amount?: number } = {}) {
  return {
    _id: VARIANT_ID,
    listingId: LISTING_ID,
    title: 'Default Title',
    price: { amount: overrides.amount ?? 1500, currency: overrides.currency ?? 'USD' },
    inventory: {
      tracked: overrides.tracked ?? true,
      available: overrides.available ?? 10,
      committed: 0,
    },
  };
}

/**
 * A cart line as supplied by tests — string ids the service coerces with
 * `String(...)` at read time (so the model's `ObjectId` typing doesn't apply to
 * these in-memory fixtures).
 */
interface MockCartItem {
  listingId: string;
  variantId: string;
  quantity: number;
  addedAt: Date;
}

/** A mock cart document whose `items` array is mutated in place by the service. */
function mockCartDoc(items: MockCartItem[], currency = 'USD') {
  const doc = {
    _id: CART_ID,
    oxyUserId: USER,
    currency,
    items,
    save: vi.fn().mockResolvedValue(undefined),
  };
  return doc;
}

beforeEach(() => {
  cartFindOne.mockReset();
  cartCreate.mockReset();
  cartUpdateOne.mockReset();
  listingFindById.mockReset();
  listingFind.mockReset();
  variantFindById.mockReset();
  variantFind.mockReset();
});

describe('cart.service.addItem', () => {
  it('clamps the added quantity to the variant available stock', async () => {
    listingFindById.mockReturnValueOnce(leanOf(listingDoc()));
    variantFindById.mockReturnValueOnce(leanOf(variantDoc({ available: 3 })));
    // No existing cart → create path.
    cartFindOne
      .mockResolvedValueOnce(null) // addItem: Cart.findOne(...) returns a doc (not lean) → null
      .mockReturnValueOnce(leanOf(mockCartDoc([{
        listingId: LISTING_ID,
        variantId: VARIANT_ID,
        quantity: 3,
        addedAt: new Date(),
      }]))); // getCart: loadCart
    cartCreate.mockResolvedValueOnce(undefined);
    // getCart hydration lookups
    variantFind.mockReturnValueOnce(leanOf([variantDoc({ available: 3 })]));
    listingFind.mockReturnValueOnce(leanOf([listingDoc()]));

    const cart = await addItem(USER, { listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 50 });

    // The created cart line was clamped to 3 (available).
    const created = cartCreate.mock.calls[0][0] as { items: { quantity: number }[] };
    expect(created.items[0].quantity).toBe(3);
    expect(cart.items[0].quantity).toBe(3);
  });

  it('increments quantity on a second add of the same variant', async () => {
    listingFindById.mockReturnValueOnce(leanOf(listingDoc()));
    variantFindById.mockReturnValueOnce(leanOf(variantDoc({ available: 10 })));

    const existing = mockCartDoc([{
      listingId: LISTING_ID,
      variantId: VARIANT_ID,
      quantity: 2,
      addedAt: new Date(),
    }]);
    cartFindOne
      .mockResolvedValueOnce(existing) // addItem: mutable doc
      .mockReturnValueOnce(leanOf({ ...existing, items: existing.items })); // getCart: loadCart (lean)

    variantFind.mockReturnValueOnce(leanOf([variantDoc({ available: 10 })]));
    listingFind.mockReturnValueOnce(leanOf([listingDoc()]));

    await addItem(USER, { listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 3 });

    // 2 (existing) + 3 (added) = 5, within available(10).
    expect(existing.items[0].quantity).toBe(5);
    expect(existing.save).toHaveBeenCalled();
  });

  it('rejects adding a variant in a different currency than the cart (CONFLICT)', async () => {
    listingFindById.mockReturnValueOnce(leanOf(listingDoc()));
    variantFindById.mockReturnValueOnce(leanOf(variantDoc({ currency: 'EUR' })));

    const existing = mockCartDoc(
      [{ listingId: LISTING_ID, variantId: '00000000000000000000aaaa', quantity: 1, addedAt: new Date() }],
      'USD',
    );
    cartFindOne.mockResolvedValueOnce(existing);

    await expect(
      addItem(USER, { listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 1 }),
    ).rejects.toSatisfy((err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT);
    expect(existing.save).not.toHaveBeenCalled();
  });
});

describe('cart.service.revalidate', () => {
  it('flags a line as stale when available < quantity and computes subtotal as the sum of line totals', async () => {
    const cart: ICart = {
      _id: CART_ID,
      oxyUserId: USER,
      currency: 'USD',
      items: [
        { listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 5, addedAt: new Date() },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ICart;

    // Live state: only 2 available (< 5 requested) → stale; price 1500.
    variantFind.mockReturnValueOnce(leanOf([variantDoc({ available: 2, amount: 1500 })]));
    listingFind.mockReturnValueOnce(leanOf([listingDoc()]));

    const dto = await revalidate(cart);

    expect(dto.items).toHaveLength(1);
    expect(dto.items[0].stale).toBe(true);
    expect(dto.items[0].unitPrice).toEqual({ amount: 1500, currency: 'USD' });
    expect(dto.items[0].lineTotal).toEqual({ amount: 7500, currency: 'USD' });
    // subtotal = sum of line totals = 1500 * 5 = 7500.
    expect(dto.subtotal).toEqual({ amount: 7500, currency: 'USD' });
  });

  it('subtotal sums multiple line totals at live prices', async () => {
    const VARIANT_2 = '0000000000000000000000b2';
    const LISTING_2 = '0000000000000000000000c2';
    const cart: ICart = {
      _id: CART_ID,
      oxyUserId: USER,
      currency: 'USD',
      items: [
        { listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 2, addedAt: new Date() },
        { listingId: LISTING_2, variantId: VARIANT_2, quantity: 1, addedAt: new Date() },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ICart;

    variantFind.mockReturnValueOnce(
      leanOf([
        variantDoc({ amount: 1000, available: 10 }),
        { ...variantDoc({ amount: 2500, available: 10 }), _id: VARIANT_2, listingId: LISTING_2 },
      ]),
    );
    listingFind.mockReturnValueOnce(
      leanOf([listingDoc(), { ...listingDoc(), _id: LISTING_2 }]),
    );

    const dto = await revalidate(cart);

    // line totals: 1000*2 + 2500*1 = 4500.
    expect(dto.subtotal).toEqual({ amount: 4500, currency: 'USD' });
    expect(dto.items.every((i) => i.stale === undefined)).toBe(true);
  });
});

describe('cart.service.getCart', () => {
  it('returns an empty USD cart when the buyer has no cart document', async () => {
    cartFindOne.mockReturnValueOnce(leanOf(null));
    const dto = await getCart(USER);
    expect(dto.items).toEqual([]);
    expect(dto.subtotal).toEqual({ amount: 0, currency: 'USD' });
  });
});
