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
const storeFind = vi.fn();
const sellerProfileFind = vi.fn();
const getProfilesMock = vi.fn();

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

vi.mock('../../models/store.js', () => ({
  Store: {
    find: (...args: unknown[]) => storeFind(...args),
  },
}));

vi.mock('../../models/seller-profile.js', () => ({
  SellerProfile: {
    find: (...args: unknown[]) => sellerProfileFind(...args),
  },
}));

vi.mock('../oxy-user.service.js', () => ({
  getProfiles: (...args: unknown[]) => getProfilesMock(...args),
}));

vi.mock('../catalog-hydration.service.js', () => ({
  resolveMedia: (value: string) => `resolved:${value}`,
}));

// The cart is displayed in the buyer's presentment currency; these fixtures use FAIR.
vi.mock('../user-preference.service.js', () => ({
  resolvePresentmentCurrency: () => Promise.resolve('FAIR'),
}));

import { addItem, revalidate, getCart } from '../cart.service.js';
import type { ICart } from '../../models/cart.js';

const USER = 'user-1';
const LISTING_ID = '000000000000000000000001';
const VARIANT_ID = '000000000000000000000002';
const CART_ID = '000000000000000000000003';
const STORE_ID = '0000000000000000000000a1';

/** Build a `.lean()`-able query stub resolving to `value`. */
function leanOf<T>(value: T) {
  return { lean: () => Promise.resolve(value) };
}

function listingDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: LISTING_ID,
    title: 'Cool Thing',
    status: 'active',
    ownerType: 'store',
    storeId: STORE_ID,
    images: [{ fileId: 'img-1', position: 0 }],
    ...overrides,
  };
}

/** A store document fixture for the cart's vendor-grouping lookups. */
function storeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: STORE_ID,
    handle: 'cool-store',
    name: 'Cool Store',
    brandColor: '#1D4ED8',
    logoFileId: 'logo-1',
    rating: 4.5,
    reviewCount: 12,
    ...overrides,
  };
}

function variantDoc(overrides: { available?: number; tracked?: boolean; currency?: string; amount?: number } = {}) {
  return {
    _id: VARIANT_ID,
    listingId: LISTING_ID,
    title: 'Default Title',
    price: { amount: overrides.amount ?? 1500, currency: overrides.currency ?? 'FAIR' },
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
function mockCartDoc(items: MockCartItem[], currency = 'FAIR') {
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
  storeFind.mockReset();
  sellerProfileFind.mockReset();
  getProfilesMock.mockReset();

  // Defaults for the vendor-grouping batch loads: one store, no P2P sellers.
  // Individual tests override `storeFind`/`getProfilesMock` as needed.
  storeFind.mockReturnValue(leanOf([storeDoc()]));
  sellerProfileFind.mockReturnValue(leanOf([]));
  getProfilesMock.mockResolvedValue(new Map());
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

  it('accepts a variant in a different native currency (multi-currency cart, no rejection)', async () => {
    listingFindById.mockReturnValueOnce(leanOf(listingDoc()));
    variantFindById.mockReturnValueOnce(leanOf(variantDoc({ currency: 'EUR' })));

    const existing = mockCartDoc([
      { listingId: LISTING_ID, variantId: '00000000000000000000aaaa', quantity: 1, addedAt: new Date() },
    ]);
    cartFindOne
      .mockResolvedValueOnce(existing) // addItem: mutable doc
      .mockReturnValueOnce(leanOf({ ...existing, items: existing.items })); // getCart: loadCart (lean)

    // getCart hydration lookups (the EUR line converts to the FAIR presentment).
    variantFind.mockReturnValueOnce(leanOf([variantDoc({ currency: 'EUR' })]));
    listingFind.mockReturnValueOnce(leanOf([listingDoc()]));

    await addItem(USER, { listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 1 });

    // The differing-currency line is pushed (no cross-currency rejection) and saved.
    expect(existing.items).toHaveLength(2);
    expect(existing.save).toHaveBeenCalled();
  });
});

describe('cart.service.revalidate', () => {
  it('flags a line as stale when available < quantity and computes subtotal as the sum of line totals', async () => {
    const cart: ICart = {
      _id: CART_ID,
      oxyUserId: USER,
      currency: 'FAIR',
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
    expect(dto.items[0].unitPrice).toEqual({ amount: 1500, currency: 'FAIR' });
    expect(dto.items[0].lineTotal).toEqual({ amount: 7500, currency: 'FAIR' });
    // subtotal = sum of line totals = 1500 * 5 = 7500.
    expect(dto.subtotal).toEqual({ amount: 7500, currency: 'FAIR' });
  });

  it('subtotal sums multiple line totals at live prices', async () => {
    const VARIANT_2 = '0000000000000000000000b2';
    const LISTING_2 = '0000000000000000000000c2';
    const cart: ICart = {
      _id: CART_ID,
      oxyUserId: USER,
      currency: 'FAIR',
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
    expect(dto.subtotal).toEqual({ amount: 4500, currency: 'FAIR' });
    expect(dto.items.every((i) => i.stale === undefined)).toBe(true);
  });
});

describe('cart.service groups', () => {
  it('groups lines by store vendor with a per-group subtotal', async () => {
    const cart: ICart = {
      _id: CART_ID,
      oxyUserId: USER,
      currency: 'FAIR',
      items: [{ listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 2, addedAt: new Date() }],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ICart;

    variantFind.mockReturnValueOnce(leanOf([variantDoc({ amount: 1500, available: 10 })]));
    listingFind.mockReturnValueOnce(leanOf([listingDoc()]));
    storeFind.mockReturnValueOnce(leanOf([storeDoc()]));

    const dto = await revalidate(cart);

    expect(dto.groups).toHaveLength(1);
    const group = dto.groups[0];
    expect(group.vendor).toMatchObject({
      kind: 'store',
      id: STORE_ID,
      handle: 'cool-store',
      name: 'Cool Store',
      brandColor: '#1D4ED8',
      logoUrl: 'resolved:logo-1',
      rating: 4.5,
      reviewCount: 12,
    });
    expect(group.items).toHaveLength(1);
    expect(group.subtotal).toEqual({ amount: 3000, currency: 'FAIR' });
  });

  it('groups a P2P (user-owned) line under a seller vendor from the Oxy profile', async () => {
    const SELLER_USER = 'seller-9';
    const P2P_LISTING = '0000000000000000000000d2';
    const P2P_VARIANT = '0000000000000000000000e2';
    const cart: ICart = {
      _id: CART_ID,
      oxyUserId: USER,
      currency: 'FAIR',
      items: [{ listingId: P2P_LISTING, variantId: P2P_VARIANT, quantity: 1, addedAt: new Date() }],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ICart;

    variantFind.mockReturnValueOnce(
      leanOf([{ ...variantDoc({ amount: 4000, available: 5 }), _id: P2P_VARIANT, listingId: P2P_LISTING }]),
    );
    listingFind.mockReturnValueOnce(
      leanOf([
        listingDoc({ _id: P2P_LISTING, ownerType: 'user', storeId: undefined, oxyUserId: SELLER_USER }),
      ]),
    );
    // No store; this seller has no SellerProfile (so no rating) but a resolvable Oxy profile.
    storeFind.mockReturnValueOnce(leanOf([]));
    sellerProfileFind.mockReturnValueOnce(leanOf([]));
    getProfilesMock.mockResolvedValueOnce(
      new Map([[SELLER_USER, { id: SELLER_USER, username: 'jane', displayName: 'Jane Doe', avatar: 'av-1' }]]),
    );

    const dto = await revalidate(cart);

    expect(dto.groups).toHaveLength(1);
    expect(dto.groups[0].vendor).toEqual({
      kind: 'user',
      id: SELLER_USER,
      username: 'jane',
      name: 'Jane Doe',
      logoUrl: 'resolved:av-1',
    });
    expect(dto.groups[0].subtotal).toEqual({ amount: 4000, currency: 'FAIR' });
  });
});

describe('cart.service.getCart', () => {
  it('returns an empty FAIR cart when the buyer has no cart document', async () => {
    cartFindOne.mockReturnValueOnce(leanOf(null));
    const dto = await getCart(USER);
    expect(dto.items).toEqual([]);
    expect(dto.subtotal).toEqual({ amount: 0, currency: 'FAIR' });
  });
});
