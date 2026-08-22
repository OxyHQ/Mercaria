/**
 * A v1 client still gets the right answer — asserted at the ENTRY POINT.
 *
 * Epic #367 line 74. `__tests__/v1-wire-contracts.ts` carries the population,
 * the measured mutation results and the positive control; this file is the
 * evidence that the read and query halves are still served, and it is what
 * `provenBy` in that registry points at.
 *
 * ## Why the entry point and not the projection
 *
 * `legacyBinaryConditionFor` was already pinned exhaustively over every
 * `ItemConditionKey` by `condition/__tests__/condition-taxonomy.test.ts`, and
 * `projectLegacyCondition` is a one-line wrapper over it. All of that stayed
 * green while `catalog-hydration.service.ts:576` served a hardcoded `'new'` for
 * every listing in the catalogue — 670 files and 10,500 tests, plus `tsc`.
 *
 * That is the green-and-inert shape `docs/house-invariants.md` names: a
 * mechanism can be perfectly correct and never called. A test of the mapping
 * measures the mapping. So every case here drives `hydrateListings` or
 * `toFilters` — the functions a request actually reaches — and asserts the value
 * a v1 client receives.
 *
 * ## The negative cases are not decoration
 *
 * `used_good` must project to `used` AND `new` must project to `new`. A test
 * that only asserted the second passes against the mutation that broke this
 * (`condition: 'new'`), because that mutation is right for exactly one of the
 * nine keys. Every case here therefore pairs a value with a value it must NOT
 * be, which is the difference between pinning a projection and pinning a
 * constant.
 *
 * The repositories, the Oxy batch loaders, the media chokepoint, config and the
 * logger are mocked — the `catalog-hydration.service.test.ts` harness, extended
 * with the condition columns these cases vary. What is REAL is the function
 * under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import {
  CONDITION_GROUPS,
  ITEM_CONDITION_KEYS,
  legacyBinaryConditionFor,
} from '@mercaria/shared-types';
import type { ItemConditionKey, ListingQuery } from '@mercaria/shared-types';
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
  findVariantImages: (...args: unknown[]) => findVariantImages(...args),
}));

vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingChildren: (...args: unknown[]) => findListingChildren(...args),
}));

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
  oxyClient: { getFileDownloadUrl: (id: string) => `media:${id}` },
}));

vi.mock('../../config/index.js', () => ({
  config: { feed: { storeCardThumbnails: 3 } },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { general: { warn: vi.fn(), error: vi.fn() } },
}));

import { hydrateListings } from '../catalog-hydration.service.js';
import { toFilters } from '../search.service.js';

/** The empty child batch, as `findListingChildren` returns it. */
function noChildren() {
  return { images: new Map(), options: new Map(), collectionIds: new Map() };
}

const STORE = {
  id: 'store-1',
  handle: 'acme',
  name: 'Acme',
  brandColor: '#111111',
  rating: 0,
  reviewCount: 0,
  textTone: 'light',
};

/**
 * A store-owned listing row.
 *
 * `condition` and `categorySlugs` are the two columns every case varies, so they
 * are parameters rather than fields a caller spreads over — a spread would let a
 * case silently keep the default and still read as if it had set one.
 */
function listingRow(
  condition: ItemConditionKey,
  categorySlugs: string[],
): ListingRecord {
  return {
    id: uuidv7(),
    ownerType: 'store',
    oxyUserId: null,
    storeId: 'store-1',
    productTypeDefinitionId: null,
    title: 'A listing',
    description: 'A thing',
    condition,
    conditionAssertion: 'seller_declared',
    conditionSourceLabel: null,
    conditionAcknowledgedAt: null,
    status: 'active',
    categoryId: null,
    categorySlugs,
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
    sourceConnectionId: null,
    sourceProvider: null,
    sourceExternalId: null,
    sourceExternalUpdatedAt: null,
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

describe('v1 contract — Listing.condition (read)', () => {
  it('serves the v1 binary condition derived from itemCondition.key', async () => {
    // Every key, through the real entry point, against the published mapping.
    // Driving all nine rather than a sample is what makes the assertion immune
    // to a constant: no single value satisfies the whole table.
    const rows = ITEM_CONDITION_KEYS.map((key) => listingRow(key, ['electronics']));
    const dtos = await hydrateListings(rows);

    expect(dtos).toHaveLength(ITEM_CONDITION_KEYS.length);
    for (const [index, key] of ITEM_CONDITION_KEYS.entries()) {
      expect(dtos[index].itemCondition.key, `itemCondition for ${key}`).toBe(key);
      expect(dtos[index].condition, `v1 projection of ${key}`).toBe(
        legacyBinaryConditionFor(key),
      );
    }

    // The vacuity floor for the loop above, and the mutation guard. A hardcoded
    // `'new'` satisfies every `new`-group case; a hardcoded `'used'` satisfies
    // every other. Asserting BOTH values are actually produced is what makes a
    // constant unable to pass — and the counts are asserted rather than the mere
    // presence of two distinct values, so a taxonomy change that collapsed the
    // groups shows up here rather than silently.
    const served = dtos.map((dto) => dto.condition);
    expect(served.filter((value) => value === 'new').length).toBeGreaterThanOrEqual(1);
    expect(served.filter((value) => value === 'used').length).toBeGreaterThanOrEqual(2);
  });

  it('coarsens every non-new segment to `used` rather than hiding it', async () => {
    // #90's honest coarsening. A v1 client cannot render `for_parts`, and telling
    // it `new` would put a salvage shell in a "brand new" filter — so the one
    // value that must never appear for these keys is `new`.
    const salvage = ITEM_CONDITION_KEYS.filter((key) => legacyBinaryConditionFor(key) === 'used');
    expect(salvage.length).toBeGreaterThanOrEqual(2);

    const dtos = await hydrateListings(salvage.map((key) => listingRow(key, ['electronics'])));
    for (const [index, key] of salvage.entries()) {
      expect(dtos[index].condition, `${key} must never read as new`).not.toBe('new');
    }
  });
});

describe('v1 contract — Listing.category (read)', () => {
  it('serves the v1 category slug as the LEAF of the materialized path', async () => {
    // Root-first, so the LEAF is the last element — the deepest category the
    // listing is filed under, not the root it descends from. A projection taking
    // `[0]` is wrong in a way that looks entirely plausible on a one-element
    // path, which is why the fixture is three deep.
    const [dto] = await hydrateListings([
      listingRow('new', ['electronics', 'phones', 'smartphones']),
    ]);

    expect(dto.category).toBe('smartphones');
    expect(dto.category).not.toBe('electronics');
  });

  it('serves the empty string for a listing filed under nothing, never `undefined`', async () => {
    // The field is REQUIRED on `Listing`, so a v1 client reading `.category`
    // must get a string. This is also the case that stops the test above being
    // satisfiable by returning `''` for everything.
    const [dto] = await hydrateListings([listingRow('new', [])]);

    expect(dto.category).toBe('');
  });
});

describe('v1 contract — ListingQuery (query)', () => {
  it('carries the v1 category slug through to the repository filter', () => {
    const query: ListingQuery = { category: 'smartphones' };

    expect(toFilters(query).categorySlug).toBe('smartphones');
    // A filter that dropped the slug narrows nothing, which reads to a v1 client
    // as a catalogue that suddenly contains everything.
    expect(toFilters({}).categorySlug).toBeUndefined();
  });

  it('widens a v1 `used` filter to every non-new condition GROUP', () => {
    // The load-bearing branch. A v1 client cannot name a segment and meant "not
    // factory-sealed", so `used` must select refurbished and for-parts too;
    // mapping it to a single key hides those listings from every shipped mobile
    // build, with no error anywhere.
    const groups = toFilters({ condition: 'used' }).conditionGroups ?? [];

    expect(groups).not.toContain('new');
    expect([...groups].sort()).toEqual(
      [...CONDITION_GROUPS].filter((group) => group !== 'new').sort(),
    );
    // The floor: the assertion above is satisfied by the empty array if
    // `CONDITION_GROUPS` ever collapsed to `['new']`, and an empty
    // `conditionGroups` selects EVERYTHING rather than nothing.
    expect(groups.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps a v1 `new` filter to the new group alone', () => {
    // The other direction, and the reason the widening cannot be "always return
    // every group": that would make `condition=new` select used stock.
    expect(toFilters({ condition: 'new' }).conditionGroups).toEqual(['new']);
  });

  it('leaves the condition filter absent when a v1 client sends none', () => {
    // The vacuity control for the three cases above: they all assert a value is
    // PRESENT, and a `toFilters` that unconditionally set `conditionGroups`
    // would satisfy two of them while silently narrowing every unfiltered feed.
    expect(toFilters({}).conditionGroups).toBeUndefined();
  });
});
