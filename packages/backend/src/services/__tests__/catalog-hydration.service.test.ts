/**
 * Unit tests for `catalog-hydration.service` — connector-provenance emission.
 *
 * `mongodb-memory-server` is not available, so the ProductVariant/SellerProfile/
 * Store models, the Oxy profile + favorites batch loaders, the media chokepoint,
 * config and the logger are mocked. Tests assert the ONE behavior added for the
 * "Synced from …" badge: `Listing.source` is emitted ONLY on the admin path
 * (`includeSource: true`) — public storefront reads keep it hidden — and the
 * persisted `externalUpdatedAt` Date is serialized to an ISO string.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { IListing, IListingSource } from '../../models/listing.js';

const variantFind = vi.fn();
const sellerProfileFind = vi.fn();
const storeFind = vi.fn();
const getProfiles = vi.fn();
const getFavoritedListingIds = vi.fn();

vi.mock('../../models/product-variant.js', () => ({
  ProductVariant: { find: (...args: unknown[]) => variantFind(...args) },
}));

vi.mock('../../models/seller-profile.js', () => ({
  SellerProfile: { find: (...args: unknown[]) => sellerProfileFind(...args) },
}));

vi.mock('../../models/store.js', () => ({
  Store: { find: (...args: unknown[]) => storeFind(...args) },
}));

vi.mock('../oxy-user.service.js', () => ({
  getProfiles: (...args: unknown[]) => getProfiles(...args),
}));

vi.mock('../favorite.service.js', () => ({
  getFavoritedListingIds: (...args: unknown[]) => getFavoritedListingIds(...args),
}));

vi.mock('../../middleware/auth.js', () => ({
  oxyClient: { getFileDownloadUrl: (id: string, variant?: string) => `media:${id}:${variant ?? 'full'}` },
}));

vi.mock('../../config/index.js', () => ({
  config: { feed: { storeCardThumbnails: 3 } },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { general: { warn: vi.fn(), error: vi.fn() } },
}));

import { hydrateListings } from '../catalog-hydration.service.js';

/** A `.sort().lean()`-able query stub resolving to `value`. */
function sortLeanOf<T>(value: T) {
  return { sort: () => ({ lean: () => Promise.resolve(value) }) };
}

/** A `.lean()`-able query stub resolving to `value`. */
function leanOf<T>(value: T) {
  return { lean: () => Promise.resolve(value) };
}

/** The one store every fixture listing belongs to. */
const STORE = {
  _id: 'store-1',
  handle: 'acme',
  name: 'Acme',
  brandColor: '#111111',
  rating: 0,
  reviewCount: 0,
  textTone: 'light',
};

/** A store-owned listing doc (belongs to `STORE`); `source` is spread in per-test. */
function listingDoc(source?: IListingSource): IListing {
  return {
    _id: new mongoose.Types.ObjectId(),
    ownerType: 'store',
    storeId: 'store-1',
    title: 'A listing',
    description: 'A thing',
    condition: 'new',
    status: 'active',
    categorySlugs: ['electronics'],
    images: [{ fileId: 'img-1', position: 0 }],
    tags: [],
    options: [],
    priceRange: { min: { amount: 0, currency: 'FAIR' }, max: { amount: 0, currency: 'FAIR' } },
    hasInventory: true,
    variantCount: 0,
    collectionIds: [],
    externalRefs: [],
    overriddenFields: [],
    rating: 0,
    reviewCount: 0,
    favoriteCount: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...(source ? { source } : {}),
  };
}

const SYNCED_SOURCE: IListingSource = {
  connectionId: 'conn-1',
  provider: 'shopify',
  externalId: 'gid://shopify/Product/123',
  externalUpdatedAt: new Date('2026-01-05T12:00:00.000Z'),
};

beforeEach(() => {
  variantFind.mockReset().mockReturnValue(sortLeanOf([]));
  sellerProfileFind.mockReset().mockReturnValue(leanOf([]));
  storeFind.mockReset().mockReturnValue(leanOf([STORE]));
  getProfiles.mockReset().mockResolvedValue(new Map());
  getFavoritedListingIds.mockReset().mockResolvedValue(new Set());
});

describe('catalog-hydration.service.hydrateListings — connector provenance', () => {
  it('emits Listing.source on the admin path (includeSource) and serializes externalUpdatedAt to ISO', async () => {
    const [dto] = await hydrateListings([listingDoc(SYNCED_SOURCE)], {
      includeSource: true,
    });

    expect(dto.source).toEqual({
      connectionId: 'conn-1',
      provider: 'shopify',
      externalId: 'gid://shopify/Product/123',
      externalUpdatedAt: '2026-01-05T12:00:00.000Z',
    });
  });

  it('omits Listing.source for a native (non-synced) listing even with includeSource', async () => {
    const [dto] = await hydrateListings([listingDoc()], { includeSource: true });

    expect(dto.source).toBeUndefined();
  });

  it('never emits Listing.source on the public path (includeSource unset)', async () => {
    const [dto] = await hydrateListings([listingDoc(SYNCED_SOURCE)]);

    expect(dto.source).toBeUndefined();
  });
});
