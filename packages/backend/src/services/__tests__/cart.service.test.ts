/**
 * Unit tests for `cart.service`.
 *
 * The catalogue lives in Postgres now, so what this file mocks on that side are
 * the listing and variant REPOSITORIES — `findListingById` / `findListingsByIds`
 * / `findListingChildren` and `findVariantById` / `findVariantsByIds` — as plain
 * async functions returning FLAT rows. There is no `.find().lean()` chain left
 * there, and the gallery is no longer an array on the listing: it is a child
 * table the cart reads ONCE for all its lines, which is why `firstImageUrl` is
 * fed image ROWS rather than a listing.
 *
 * `Cart`, `Store` and `SellerProfile` are still Mongoose and are still mocked as
 * query builders, as are the media chokepoint (`resolveMedia`) and the buyer's
 * presentment currency.
 *
 * Tests cover the F3 cart contract: quantity clamps to `available`, a second add
 * of the same variant increments, a differing NATIVE currency is accepted
 * (multi-currency cart), `revalidate` flags an under-stocked line `stale` and
 * resolves its thumbnail from the child gallery, the subtotal is the sum of the
 * live line totals, lines group per vendor, and a variant with NO price is a
 * stale line the buyer must remove rather than a free one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import type {
  ListingChildren,
  ListingImageRecord,
  ListingRecord,
} from '../../db/catalog/listingRepository.js';
import type { VariantRecord } from '../../db/catalog/variantRepository.js';

const cartFindOne = vi.fn();
const cartCreate = vi.fn();
const cartUpdateOne = vi.fn();
const findListingById = vi.fn();
const findListingsByIds = vi.fn();
const findListingChildren = vi.fn();
const findVariantById = vi.fn();
const findVariantsByIds = vi.fn();
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

vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingById: (...args: unknown[]) => findListingById(...args),
  findListingsByIds: (...args: unknown[]) => findListingsByIds(...args),
  findListingChildren: (...args: unknown[]) => findListingChildren(...args),
}));

vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantById: (...args: unknown[]) => findVariantById(...args),
  findVariantsByIds: (...args: unknown[]) => findVariantsByIds(...args),
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
const LISTING_ID = uuidv7();
const VARIANT_ID = uuidv7();
const CART_ID = uuidv7();
const STORE_ID = uuidv7();

/** Every row fixture carries the same timestamps; none of them is asserted on. */
const AT = new Date('2026-01-01T00:00:00.000Z');

/** Build a `.lean()`-able query stub resolving to `value` — the Mongoose side. */
function leanOf<T>(value: T) {
  return { lean: () => Promise.resolve(value) };
}

/**
 * A `listings` ROW as the repository returns it: flat, `id` not `_id`, and with
 * NO `images` / `collectionIds` — those are child tables now (see
 * {@link childrenWithOneImageEach}).
 */
function listingRow(overrides: Partial<ListingRecord> = {}): ListingRecord {
  return {
    id: LISTING_ID,
    ownerType: 'store',
    oxyUserId: null,
    storeId: STORE_ID,
    title: 'Cool Thing',
    description: 'A cool thing',
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
    ...overrides,
  };
}

/**
 * A P2P listing row — `ownerType: 'user'` moves BOTH owner columns, since
 * `listings_owner_exclusivity_check` refuses a row carrying an oxyUserId and a
 * storeId at once.
 */
function p2pListingRow(id: string, sellerOxyUserId: string): ListingRecord {
  return listingRow({ id, ownerType: 'user', oxyUserId: sellerOxyUserId, storeId: null });
}

/** A store document fixture for the cart's vendor-grouping lookups (still Mongoose). */
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

/**
 * A `product_variants` ROW: flat `priceAmount`/`priceCurrency` (NULLABLE and
 * absent together) and flat `inventory*` columns.
 */
function variantRow(overrides: Partial<VariantRecord> = {}): VariantRecord {
  return {
    id: VARIANT_ID,
    listingId: LISTING_ID,
    title: 'Default Title',
    sku: null,
    barcode: null,
    priceAmount: 1500,
    priceCurrency: 'FAIR',
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
    ...overrides,
  };
}

/** One `listing_images` row. */
function imageRow(listingId: string, fileId: string, position = 0): ListingImageRecord {
  return { id: uuidv7(), listingId, fileId, alt: null, position, createdAt: AT, updatedAt: AT };
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

/** A stored cart, as `revalidate` receives it straight from the collection. */
function storedCart(items: MockCartItem[]): ICart {
  return {
    _id: CART_ID,
    oxyUserId: USER,
    currency: 'FAIR',
    items,
    createdAt: AT,
    updatedAt: AT,
  } as unknown as ICart;
}

beforeEach(() => {
  cartFindOne.mockReset();
  cartCreate.mockReset();
  cartUpdateOne.mockReset();
  findListingById.mockReset();
  findListingsByIds.mockReset();
  findListingChildren.mockReset();
  findVariantById.mockReset();
  findVariantsByIds.mockReset();
  storeFind.mockReset();
  sellerProfileFind.mockReset();
  getProfilesMock.mockReset();

  // The gallery is a batched child read now; by default every requested listing
  // has one image. Tests that care about the thumbnail assert on it directly.
  findListingChildren.mockImplementation((listingIds: readonly string[]) =>
    Promise.resolve(childrenWithOneImageEach(listingIds)),
  );

  // Defaults for the vendor-grouping batch loads: one store, no P2P sellers.
  // Individual tests override `storeFind`/`getProfilesMock` as needed.
  storeFind.mockReturnValue(leanOf([storeDoc()]));
  sellerProfileFind.mockReturnValue(leanOf([]));
  getProfilesMock.mockResolvedValue(new Map());
});

describe('cart.service.addItem', () => {
  it('clamps the added quantity to the variant available stock', async () => {
    findListingById.mockResolvedValueOnce(listingRow());
    findVariantById.mockResolvedValueOnce(variantRow({ inventoryAvailable: 3 }));
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
    findVariantsByIds.mockResolvedValueOnce([variantRow({ inventoryAvailable: 3 })]);
    findListingsByIds.mockResolvedValueOnce([listingRow()]);

    const cart = await addItem(USER, { listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 50 });

    // The created cart line was clamped to 3 (available).
    const created = cartCreate.mock.calls[0][0] as { items: { quantity: number }[] };
    expect(created.items[0].quantity).toBe(3);
    expect(cart.items[0].quantity).toBe(3);
  });

  it('increments quantity on a second add of the same variant', async () => {
    findListingById.mockResolvedValueOnce(listingRow());
    findVariantById.mockResolvedValueOnce(variantRow({ inventoryAvailable: 10 }));

    const existing = mockCartDoc([{
      listingId: LISTING_ID,
      variantId: VARIANT_ID,
      quantity: 2,
      addedAt: new Date(),
    }]);
    cartFindOne
      .mockResolvedValueOnce(existing) // addItem: mutable doc
      .mockReturnValueOnce(leanOf({ ...existing, items: existing.items })); // getCart: loadCart (lean)

    findVariantsByIds.mockResolvedValueOnce([variantRow({ inventoryAvailable: 10 })]);
    findListingsByIds.mockResolvedValueOnce([listingRow()]);

    await addItem(USER, { listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 3 });

    // 2 (existing) + 3 (added) = 5, within available(10).
    expect(existing.items[0].quantity).toBe(5);
    expect(existing.save).toHaveBeenCalled();
  });

  it('accepts a variant in a different native currency (multi-currency cart, no rejection)', async () => {
    findListingById.mockResolvedValueOnce(listingRow());
    findVariantById.mockResolvedValueOnce(variantRow({ priceCurrency: 'EUR' }));

    const existing = mockCartDoc([
      { listingId: LISTING_ID, variantId: uuidv7(), quantity: 1, addedAt: new Date() },
    ]);
    cartFindOne
      .mockResolvedValueOnce(existing) // addItem: mutable doc
      .mockReturnValueOnce(leanOf({ ...existing, items: existing.items })); // getCart: loadCart (lean)

    // getCart hydration lookups (the EUR line converts to the FAIR presentment).
    findVariantsByIds.mockResolvedValueOnce([variantRow({ priceCurrency: 'EUR' })]);
    findListingsByIds.mockResolvedValueOnce([listingRow()]);

    await addItem(USER, { listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 1 });

    // The differing-currency line is pushed (no cross-currency rejection) and saved.
    expect(existing.items).toHaveLength(2);
    expect(existing.save).toHaveBeenCalled();
  });
});

describe('cart.service.revalidate', () => {
  it('flags a line as stale when available < quantity and computes subtotal as the sum of line totals', async () => {
    const cart = storedCart([
      { listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 5, addedAt: new Date() },
    ]);

    // Live state: only 2 available (< 5 requested) → stale; price 1500.
    findVariantsByIds.mockResolvedValueOnce([
      variantRow({ inventoryAvailable: 2, priceAmount: 1500 }),
    ]);
    findListingsByIds.mockResolvedValueOnce([listingRow()]);

    const dto = await revalidate(cart);

    expect(dto.items).toHaveLength(1);
    expect(dto.items[0].stale).toBe(true);
    expect(dto.items[0].unitPrice).toEqual({ amount: 1500, currency: 'FAIR' });
    expect(dto.items[0].lineTotal).toEqual({ amount: 7500, currency: 'FAIR' });
    // The thumbnail comes from the batched `findListingChildren` gallery rows —
    // the listing row itself no longer carries an `images` array.
    expect(dto.items[0].imageUrl).toBe('resolved:img-1');
    // subtotal = sum of line totals = 1500 * 5 = 7500.
    expect(dto.subtotal).toEqual({ amount: 7500, currency: 'FAIR' });
  });

  it('subtotal sums multiple line totals at live prices', async () => {
    const VARIANT_2 = uuidv7();
    const LISTING_2 = uuidv7();
    const cart = storedCart([
      { listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 2, addedAt: new Date() },
      { listingId: LISTING_2, variantId: VARIANT_2, quantity: 1, addedAt: new Date() },
    ]);

    findVariantsByIds.mockResolvedValueOnce([
      variantRow({ priceAmount: 1000, inventoryAvailable: 10 }),
      variantRow({
        id: VARIANT_2,
        listingId: LISTING_2,
        priceAmount: 2500,
        inventoryAvailable: 10,
      }),
    ]);
    findListingsByIds.mockResolvedValueOnce([listingRow(), listingRow({ id: LISTING_2 })]);

    const dto = await revalidate(cart);

    // line totals: 1000*2 + 2500*1 = 4500.
    expect(dto.subtotal).toEqual({ amount: 4500, currency: 'FAIR' });
    expect(dto.items.every((i) => i.stale === undefined)).toBe(true);
  });

  it('marks a line whose variant has NO price as stale and zero-priced, never free', async () => {
    const cart = storedCart([
      { listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 2, addedAt: new Date() },
    ]);

    // Both price columns are NULL together — the shape the paired CHECK allows.
    findVariantsByIds.mockResolvedValueOnce([
      variantRow({ priceAmount: null, priceCurrency: null }),
    ]);
    findListingsByIds.mockResolvedValueOnce([listingRow()]);

    const dto = await revalidate(cart);

    // Same treatment as a vanished variant: a line the buyer must remove, priced
    // at zero and flagged, rather than a ⊜0 item they could actually buy.
    expect(dto.items[0].stale).toBe(true);
    expect(dto.items[0].unitPrice).toEqual({ amount: 0, currency: 'FAIR' });
    expect(dto.items[0].lineTotal).toEqual({ amount: 0, currency: 'FAIR' });
    expect(dto.items[0].available).toBe(0);
    expect(dto.subtotal).toEqual({ amount: 0, currency: 'FAIR' });
  });
});

describe('cart.service groups', () => {
  it('groups lines by store vendor with a per-group subtotal', async () => {
    const cart = storedCart([
      { listingId: LISTING_ID, variantId: VARIANT_ID, quantity: 2, addedAt: new Date() },
    ]);

    findVariantsByIds.mockResolvedValueOnce([
      variantRow({ priceAmount: 1500, inventoryAvailable: 10 }),
    ]);
    findListingsByIds.mockResolvedValueOnce([listingRow()]);
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
    const P2P_LISTING = uuidv7();
    const P2P_VARIANT = uuidv7();
    const cart = storedCart([
      { listingId: P2P_LISTING, variantId: P2P_VARIANT, quantity: 1, addedAt: new Date() },
    ]);

    findVariantsByIds.mockResolvedValueOnce([
      variantRow({
        id: P2P_VARIANT,
        listingId: P2P_LISTING,
        priceAmount: 4000,
        inventoryAvailable: 5,
      }),
    ]);
    findListingsByIds.mockResolvedValueOnce([p2pListingRow(P2P_LISTING, SELLER_USER)]);
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
