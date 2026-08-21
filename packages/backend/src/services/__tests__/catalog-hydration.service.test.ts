/**
 * Unit tests for `catalog-hydration.service` — connector-provenance emission.
 *
 * The catalogue repositories, the seller-profile repository, the Oxy
 * profile + favorites batch loaders, the media chokepoint, config and the logger
 * are mocked. Tests assert the ONE behavior added for the "Synced from …" badge:
 * provenance is emitted ONLY on the admin path (`includeSource: true`) — public
 * storefront reads keep it hidden — and the persisted `externalUpdatedAt` is
 * serialized to an ISO string.
 *
 * The port made provenance FOUR flat columns rather than an embedded object, so
 * "a native listing" is now four NULLs rather than an absent field — which is the
 * shape the second test pins.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import type { ListingRecord } from '../../db/catalog/listingRepository.js';

const findVariantsByListingIds = vi.fn();
const findVariantOptionValues = vi.fn();
const findVariantImages = vi.fn();
const findListingChildren = vi.fn();
const sellerProfileFind = vi.fn();
const storeFind = vi.fn();
const getProfiles = vi.fn();
const getFavoritedListingIds = vi.fn();

vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantsByListingIds: (...args: unknown[]) => findVariantsByListingIds(...args),
  findVariantOptionValues: (...args: unknown[]) => findVariantOptionValues(...args),
  // #850: the variant gallery read. Default to an EMPTY map rather than leaving
  // it undefined, so every pre-existing case in this file exercises the
  // `listing_fallback` branch — which is what those listings actually do.
  findVariantImages: (...args: unknown[]) => findVariantImages(...args),
}));

vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingChildren: (...args: unknown[]) => findListingChildren(...args),
}));

// #90: the condition domain's reads. Mocked as empty rather than left to hit a
// mocked `getDb()` that has no `.select` — this suite mocks REPOSITORIES, and a
// repository is exactly what these are.
vi.mock('../../db/condition/conditionRepository.js', () => ({
  findConditionDetailsForListings: vi.fn(async () => []),
  findConditionPhotosForListings: vi.fn(async () => []),
}));

vi.mock('../../db/buyers/sellerProfileRepository.js', () => ({
  findSellerProfilesByUserIds: (...args: unknown[]) => sellerProfileFind(...args),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoresByIds: (...args: unknown[]) => storeFind(...args),
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

/** The empty batch `findListingChildren` returns for listings with no children. */
function noChildren() {
  return { images: new Map(), options: new Map(), collectionIds: new Map() };
}

/** The one store every fixture listing belongs to, as the repository returns it. */
const STORE = {
  id: 'store-1',
  handle: 'acme',
  name: 'Acme',
  brandColor: '#111111',
  rating: 0,
  reviewCount: 0,
  textTone: 'light',
};

/** The connector-provenance columns of a synced listing. */
const SYNCED_SOURCE = {
  sourceConnectionId: 'conn-1',
  sourceProvider: 'shopify',
  sourceExternalId: 'gid://shopify/Product/123',
  sourceExternalUpdatedAt: new Date('2026-01-05T12:00:00.000Z'),
} as const;

/** The same four columns on a listing authored HERE — NULL, not absent. */
const NATIVE_SOURCE = {
  sourceConnectionId: null,
  sourceProvider: null,
  sourceExternalId: null,
  sourceExternalUpdatedAt: null,
} as const;

/** A store-owned listing row (belongs to `STORE`); provenance is spread in per-test. */
function listingRow(source: Partial<ListingRecord> = NATIVE_SOURCE): ListingRecord {
  return {
    id: uuidv7(),
    ownerType: 'store',
    oxyUserId: null,
    storeId: 'store-1',
    productTypeDefinitionId: null,
    title: 'A listing',
    description: 'A thing',
    condition: 'new',
    conditionAssertion: 'seller_declared',
    conditionSourceLabel: null,
    conditionAcknowledgedAt: null,
    status: 'active',
    categoryId: null,
    categorySlugs: ['electronics'],
    tags: [],
    priceRangeMinAmount: 0,
    priceRangeMinCurrency: 'FAIR',
    priceRangeMaxAmount: 0,
    priceRangeMaxCurrency: 'FAIR',
    hasInventory: true,
    variantCount: 0,
    longitude: null,
    latitude: null,
    geo: null,
    vendor: null,
    productType: null,
    handle: null,
    seoTitle: null,
    seoDescription: null,
    overriddenFields: [],
    archivedBy: null,
    archivedFromStatus: null,
    rating: 0,
    reviewCount: 0,
    favoriteCount: 0,
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    searchVector: '',
    ...NATIVE_SOURCE,
    ...source,
  };
}

beforeEach(() => {
  findVariantsByListingIds.mockReset().mockResolvedValue([]);
  findVariantOptionValues.mockReset().mockResolvedValue(new Map());
  findVariantImages.mockReset().mockResolvedValue(new Map());
  findListingChildren.mockReset().mockResolvedValue(noChildren());
  sellerProfileFind.mockReset().mockResolvedValue([]);
  storeFind.mockReset().mockResolvedValue([STORE]);
  getProfiles.mockReset().mockResolvedValue(new Map());
  getFavoritedListingIds.mockReset().mockResolvedValue(new Set());
});

describe('catalog-hydration.service.hydrateListings — connector provenance', () => {
  it('emits Listing.source on the admin path (includeSource) and serializes externalUpdatedAt to ISO', async () => {
    const [dto] = await hydrateListings([listingRow(SYNCED_SOURCE)], {
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
    const [dto] = await hydrateListings([listingRow()], { includeSource: true });

    expect(dto.source).toBeUndefined();
  });

  it('never emits Listing.source on the public path (includeSource unset)', async () => {
    const [dto] = await hydrateListings([listingRow(SYNCED_SOURCE)]);

    expect(dto.source).toBeUndefined();
  });
});
