/**
 * Which representation a hydration read serves a listing's options FROM
 * (#367 line 324, ADR 0007 D6).
 *
 * The clause asks that `listing_options` and `product_variant_option_values`
 * become "a migration compatibility projection/fallback, not the new source of
 * truth". That is a question about a READ, and until this landed no serving
 * path read `native_listing_variant_axes` at all — so the answer was "legacy,
 * for every listing", and no listing's own state could have said otherwise.
 *
 * These cases drive `hydrateListings` itself, through all three modes, because
 * the property is about what reaches the DTO. The projection's own arithmetic
 * is pinned separately and purely in
 * `services/variant-axes/__tests__/variant-axis-projection.test.ts`.
 *
 * ## The fixture constructs the typed rows, deliberately
 *
 * No listing in this catalogue has typed axes today — the whole production
 * catalogue is one connector import and the backfill has not run — so a case
 * resting on an existing listing having them would be a case that measures
 * nothing and goes on passing after the feature is deleted. Every typed row
 * here is built by the test.
 *
 * ## The legacy and typed spellings are DIFFERENT on purpose
 *
 * The legacy option is `Colour` and the registry label is `Color`. Every
 * assertion below names one and asserts the ABSENCE of the other, so no case
 * can pass by serving the wrong table and happening to look right — which is
 * exactly what would happen if both spellings agreed, and is the shape a
 * production fixture would have had.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import type { ListingRecord } from '../../db/catalog/listingRepository.js';

const findVariantsByListingIds = vi.fn();
const findVariantOptionValues = vi.fn();
const findVariantImages = vi.fn();
const findListingChildren = vi.fn();
const listVariantAxesForListings = vi.fn();
const listVariantAxisAssignments = vi.fn();

/**
 * Mutable, so one file can drive all three modes without re-importing.
 *
 * `vi.hoisted` because a `vi.mock` factory is hoisted above every `const` in
 * the file and this one is DEREFERENCED at factory time rather than inside a
 * lazy arrow like the `vi.fn()` handles above it.
 */
const { variantAxesConfig } = vi.hoisted(() => ({
  variantAxesConfig: { reads: 'off' } as { reads: 'off' | 'shadow' | 'on' },
}));

vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantsByListingIds: (...args: unknown[]) => findVariantsByListingIds(...args),
  findVariantOptionValues: (...args: unknown[]) => findVariantOptionValues(...args),
  findVariantImages: (...args: unknown[]) => findVariantImages(...args),
}));

vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingChildren: (...args: unknown[]) => findListingChildren(...args),
}));

vi.mock('../../db/variantAxes/variantAxisRepository.js', () => ({
  listVariantAxesForListings: (...args: unknown[]) => listVariantAxesForListings(...args),
  listVariantAxisAssignments: (...args: unknown[]) => listVariantAxisAssignments(...args),
}));

// `getDb()` is only ever passed INTO the two mocked reads above, so a handle
// that is never dereferenced is the honest stub — a fake with methods would
// suggest this suite reaches a database, and it does not.
vi.mock('../../db/postgres.js', () => ({ getDb: () => ({}) }));

vi.mock('../../db/condition/conditionRepository.js', () => ({
  findConditionDetailsForListings: vi.fn(async () => []),
  findConditionPhotosForListings: vi.fn(async () => []),
}));

// #123's retail binding read, reached because these fixtures HAVE variants —
// the sibling hydration suite never touches it because its listings have none.
// Empty is the right answer for a P2P listing: none of these is retail.
vi.mock('../../db/retailCheckout/retailCheckoutRepository.js', () => ({
  findLiveRetailBindingsForVariants: vi.fn(async () => new Map()),
}));

vi.mock('../../db/buyers/sellerProfileRepository.js', () => ({
  findSellerProfilesByUserIds: vi.fn(async () => []),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoresByIds: vi.fn(async () => []),
}));

vi.mock('../oxy-user.service.js', () => ({ getProfiles: vi.fn(async () => new Map()) }));

vi.mock('../favorite.service.js', () => ({
  getFavoritedListingIds: vi.fn(async () => new Set()),
}));

vi.mock('../../middleware/auth.js', () => ({
  oxyClient: { getFileDownloadUrl: (id: string) => `media:${id}` },
}));

vi.mock('../../config/index.js', () => ({
  config: { feed: { storeCardThumbnails: 3 }, variantAxes: variantAxesConfig },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { general: { warn: vi.fn(), error: vi.fn() } },
}));

import { hydrateListings } from '../catalog-hydration.service.js';
import {
  readVariantAxisShadowCounters,
  resetVariantAxisShadowCounters,
} from '../variant-axes/projection.js';

const LISTING_ID = uuidv7();
const VARIANT_A = uuidv7();
const VARIANT_B = uuidv7();

/** The seller's own word, as `listing_options` stores it. */
const LEGACY_NAME = 'Colour';
/** The registry's label, as `attribute_definitions.label` stores it. */
const REGISTRY_LABEL = 'Color';

function listingRow(): ListingRecord {
  return {
    id: LISTING_ID,
    ownerType: 'user',
    oxyUserId: 'seller-1',
    storeId: null,
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
    variantCount: 2,
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
  } as ListingRecord;
}

function variantRow(id: string, title: string) {
  return {
    id,
    listingId: LISTING_ID,
    title,
    position: 0,
    sku: null,
    barcode: null,
    priceAmount: 1000,
    priceCurrency: 'FAIR',
    compareAtPriceAmount: null,
    compareAtPriceCurrency: null,
    inventoryTracked: false,
    inventoryAvailable: 5,
  };
}

/** The typed axis, carrying the registry label AND the legacy word as provenance. */
function typedAxis() {
  return {
    id: 'axis-1',
    listingId: LISTING_ID,
    attributeKey: 'color',
    attributeDefinitionId: 'def-color',
    attributeDefinitionVersion: 1,
    label: REGISTRY_LABEL,
    legacyOptionName: LEGACY_NAME,
    position: 0,
  };
}

function typedAssignment(variantId: string, displayValue: string) {
  return {
    id: `asg-${variantId}`,
    variantId,
    axisId: 'axis-1',
    attributeDefinitionId: 'def-color',
    attributeKey: 'color',
    displayValue,
    normalizedValue: displayValue.toLowerCase(),
    enumValueId: null,
    normalizedNumber: null,
    normalizedUnit: null,
    sourceClaimId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

beforeEach(() => {
  variantAxesConfig.reads = 'off';
  resetVariantAxisShadowCounters();
  findVariantsByListingIds
    .mockReset()
    .mockResolvedValue([variantRow(VARIANT_A, 'Ice'), variantRow(VARIANT_B, 'Dawn')]);
  findVariantOptionValues.mockReset().mockResolvedValue(
    new Map([
      [VARIANT_A, [{ name: LEGACY_NAME, value: 'Ice', position: 0 }]],
      [VARIANT_B, [{ name: LEGACY_NAME, value: 'Dawn', position: 0 }]],
    ]),
  );
  findVariantImages.mockReset().mockResolvedValue(new Map());
  findListingChildren.mockReset().mockResolvedValue({
    images: new Map(),
    options: new Map([[LISTING_ID, [{ name: LEGACY_NAME, values: ['Ice', 'Dawn'], position: 0 }]]]),
    collectionIds: new Map(),
  });
  listVariantAxesForListings.mockReset().mockResolvedValue([typedAxis()]);
  listVariantAxisAssignments
    .mockReset()
    .mockResolvedValue([typedAssignment(VARIANT_A, 'Ice'), typedAssignment(VARIANT_B, 'Dawn')]);
});

describe('VARIANT_AXIS_READS=off', () => {
  it('serves the legacy option tables and does not read the typed axes AT ALL', async () => {
    const [dto] = await hydrateListings([listingRow()]);

    expect(dto.options).toEqual([{ name: LEGACY_NAME, values: ['Ice', 'Dawn'] }]);
    expect(dto.variants[0].optionValues).toEqual([{ name: LEGACY_NAME, value: 'Ice' }]);
    // The default must cost nothing. Two extra statements per page on every
    // listing read is not a free rollout lever, and "off" that still queries is
    // how a lever nobody turned on shows up in a latency graph.
    expect(listVariantAxesForListings).not.toHaveBeenCalled();
    expect(listVariantAxisAssignments).not.toHaveBeenCalled();
  });
});

describe('VARIANT_AXIS_READS=on', () => {
  it('serves the REGISTRY label and the typed display values, not the seller word', async () => {
    variantAxesConfig.reads = 'on';

    const [dto] = await hydrateListings([listingRow()]);

    expect(dto.options).toEqual([{ name: REGISTRY_LABEL, values: ['Ice', 'Dawn'] }]);
    expect(dto.variants[0].optionValues).toEqual([{ name: REGISTRY_LABEL, value: 'Ice' }]);
    expect(dto.variants[1].optionValues).toEqual([{ name: REGISTRY_LABEL, value: 'Dawn' }]);
    // The whole DTO, not just the fields above: the legacy spelling must not
    // survive anywhere in the response.
    expect(JSON.stringify(dto)).not.toContain(LEGACY_NAME);
  });

  it('FALLS BACK to legacy for a listing that declares no typed axis', async () => {
    // The compatibility fallback line 324 asks for, and the ordinary case: an
    // un-migrated listing is not a failure, it is most of the catalogue.
    variantAxesConfig.reads = 'on';
    listVariantAxesForListings.mockResolvedValue([]);
    listVariantAxisAssignments.mockResolvedValue([]);

    const [dto] = await hydrateListings([listingRow()]);

    expect(dto.options).toEqual([{ name: LEGACY_NAME, values: ['Ice', 'Dawn'] }]);
    expect(dto.variants[0].optionValues).toEqual([{ name: LEGACY_NAME, value: 'Ice' }]);
  });

  it('serves the STALE typed value when a variant edit moved the legacy one', async () => {
    // Stated rather than hidden: this is the cost of `on` before the write path
    // converges. `updateVariant` replaces `product_variant_option_values` and
    // touches no typed axis, so a connector re-sync or a merchant edit leaves
    // the typed side behind — and under `on` that is what a shopper reads. The
    // case exists so the trade-off is a test somebody has to delete rather than
    // a paragraph somebody can miss.
    variantAxesConfig.reads = 'on';
    findVariantOptionValues.mockResolvedValue(
      new Map([
        [VARIANT_A, [{ name: LEGACY_NAME, value: 'Powder', position: 0 }]],
        [VARIANT_B, [{ name: LEGACY_NAME, value: 'Dawn', position: 0 }]],
      ]),
    );

    const [dto] = await hydrateListings([listingRow()]);

    expect(dto.variants[0].optionValues).toEqual([{ name: REGISTRY_LABEL, value: 'Ice' }]);
  });
});

describe('VARIANT_AXIS_READS=shadow', () => {
  it('serves EXACTLY what off serves, byte for byte', async () => {
    const [before] = await hydrateListings([listingRow()]);
    variantAxesConfig.reads = 'shadow';
    const [after] = await hydrateListings([listingRow()]);

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('counts a listing whose two representations AGREE', async () => {
    variantAxesConfig.reads = 'shadow';

    await hydrateListings([listingRow()]);

    expect(readVariantAxisShadowCounters()).toMatchObject({
      listings: 1,
      agreed: 1,
      diverged: 0,
      typedAbsent: 0,
    });
  });

  it('counts the DIVERGENCE a variant edit creates, without serving it', async () => {
    // The measurement the lever exists for. Under `shadow` the shopper still
    // reads `Powder` — the value the merchant last wrote — and the disagreement
    // becomes a number an operator can act on before anything depends on it.
    variantAxesConfig.reads = 'shadow';
    findVariantOptionValues.mockResolvedValue(
      new Map([
        [VARIANT_A, [{ name: LEGACY_NAME, value: 'Powder', position: 0 }]],
        [VARIANT_B, [{ name: LEGACY_NAME, value: 'Dawn', position: 0 }]],
      ]),
    );

    const [dto] = await hydrateListings([listingRow()]);

    expect(dto.variants[0].optionValues).toEqual([{ name: LEGACY_NAME, value: 'Powder' }]);
    expect(readVariantAxisShadowCounters()).toMatchObject({ listings: 1, diverged: 1, agreed: 0 });
  });

  it('counts an un-migrated listing as typed_absent — the migration backlog, measured on real traffic', async () => {
    variantAxesConfig.reads = 'shadow';
    listVariantAxesForListings.mockResolvedValue([]);
    listVariantAxisAssignments.mockResolvedValue([]);

    await hydrateListings([listingRow()]);

    expect(readVariantAxisShadowCounters()).toMatchObject({ listings: 1, typedAbsent: 1 });
  });
});
