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
import { uuidv7 } from '@oxy.so/db';
import type { ListingImageRecord, ListingRecord } from '../../db/catalog/listingRepository.js';
import type { StoreRow } from '../../db/stores/storeRepository.js';

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
  oxyClient: {
    cloudURL: 'https://cloud.oxy.so',
    assets: {
      publicUrl: (id: string, variant?: string) => `media:${id}:${variant ?? 'full'}`,
    },
  },
}));

// #367 line 324: `off` is the default and today's behaviour, so every case in
// this file keeps reading the legacy option tables and none of them changes.
// The three modes are driven in `catalog-hydration-variant-axes.test.ts`.
vi.mock('../../config/index.js', () => ({
  config: { feed: { storeCardThumbnails: 3 }, variantAxes: { reads: 'off' } },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { general: { warn: vi.fn(), error: vi.fn() } },
}));

import { hydrateListings, resolveMedia, resolveStoredMediaUrl, toProductSummary, toStoreSummary } from '../catalog-hydration.service.js';
import { projectSeller } from '../public-api/projection.js';

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
  it.each(['seller-avatar-id', 'https://supplier.example/avatar.jpg', 'https://cloud.oxy.so/old-avatar'])('keeps seller avatar IDs separate from public API URLs: %s', async avatar => {
    getProfiles.mockResolvedValue(new Map([['person-1', { displayName: 'Seller', username: 'seller', avatar }]]));
    const [dto] = await hydrateListings([listingRow({ ownerType: 'user', oxyUserId: 'person-1', storeId: null })]);
    const expected = avatar === 'seller-avatar-id' ? avatar : null;
    expect(dto.seller?.avatar).toBe(expected);
    expect(projectSeller(dto, undefined, resolveMedia)).toMatchObject({
      kind: 'person', avatarUrl: expected ? `media:${expected}:full` : null,
    });
  });

  it('preserves file IDs so authoring can round-trip gallery selections', async () => {
    const listing = listingRow();
    const children = noChildren();
    children.images.set(listing.id, [imageRow(listing.id, 'oxy-gallery-file')]);
    findListingChildren.mockResolvedValue(children);
    const [dto] = await hydrateListings([listing]);
    expect(dto.images).toEqual([{ fileId: 'oxy-gallery-file', position: 0 }]);
    expect(dto.images[0]?.fileId).not.toContain('media:');
  });

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
    const [dto] = await hydrateListings([listingRow()], {
      includeSource: true,
    });

    expect(dto.source).toBeUndefined();
  });

  it('never emits Listing.source on the public path (includeSource unset)', async () => {
    const [dto] = await hydrateListings([listingRow(SYNCED_SOURCE)]);

    expect(dto.source).toBeUndefined();
  });
});

/**
 * An absent image must reach the client as an ABSENT FIELD.
 *
 * These previously emitted `''`, which is an absent value wearing the type of a
 * present one: `ProductSummary.imageUrl` was declared `string`, so
 * `<Image source={{ uri: product.imageUrl }} />` typechecked and every card
 * whose listing had no images rendered blank. The DTO now omits the key, which
 * is what makes the renderers' `imageUrl ? … : placeholder` branch reachable.
 *
 * Each case is paired with its opposite. An absence assertion on its own goes
 * vacuous the moment the builder stops emitting the field at all, so the
 * present-image case is what proves these tests can tell the two apart.
 */
/**
 * A full `listing_images` row. The partial object literal these tests used
 * first typechecked nowhere else in this file, because every other fixture
 * reaches the service through a mocked repository whose return type is never
 * compared against the real record.
 */
function imageRow(listingId: string, fileId: string): ListingImageRecord {
  return {
    id: uuidv7(),
    listingId,
    fileId,
    alt: null,
    position: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/** A full store row with explicit public presentation overrides. */
function storeRow(
  media: Partial<Pick<StoreRow, 'coverFileId' | 'logoFileId' | 'policiesRefundPolicy' | 'policiesPrivacyPolicy'>>,
): StoreRow {
  return {
    oxyAccountId: 'oxy-account-fixture',
    id: 'store-1',
    handle: 'acme',
    name: 'Acme',
    description: '',
    brandColor: '#111111',
    textTone: 'light',
    status: 'active',
    policiesReturnWindowDays: 30,
    policiesShippingNote: null,
    policiesRefundPolicy: null,
    coverFileId: null,
    logoFileId: null,
    policiesPrivacyPolicy: null,
    policiesTermsOfService: null,
    defaultCurrency: 'FAIR',
    taxSettingsPricesIncludeTax: false,
    taxSettingsTaxRegistrationId: null,
    taxSettingsChargeTaxOnProducts: true,
    notificationSettingsLowStockAlerts: true,
    notificationSettingsOrderEmails: true,
    notificationSettingsLowStockThreshold: null,
    rating: 0,
    reviewCount: 0,
    productCount: 0,
    salesCount: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...media,
  };
}

describe('catalog-hydration.service — an absent image is an absent field, never an empty string', () => {
  it('exposes only authored public policies on opted-in detail reads', () => {
    const store = storeRow({
      policiesRefundPolicy: 'Contact the store within 14 days.',
      policiesPrivacyPolicy: 'We use your details to fulfil your order.',
    });
    expect(toStoreSummary(store, [])).not.toHaveProperty('refundPolicy');
    expect(toStoreSummary(store, [])).not.toHaveProperty('privacyPolicy');
    expect(toStoreSummary(store, [], undefined, { includePolicies: true }).refundPolicy).toBe(
      store.policiesRefundPolicy,
    );
    expect(toStoreSummary(store, [], undefined, { includePolicies: true }).privacyPolicy).toBe(
      store.policiesPrivacyPolicy,
    );
    expect(
      toStoreSummary(storeRow({ policiesRefundPolicy: '  ' }), [], undefined, {
        includePolicies: true,
      }),
    ).not.toHaveProperty('refundPolicy');
    expect(
      toStoreSummary(storeRow({ policiesPrivacyPolicy: '  ' }), [], undefined, {
        includePolicies: true,
      }),
    ).not.toHaveProperty('privacyPolicy');
  });
  it('omits ProductSummary.imageUrl when the listing has no images', () => {
    const summary = toProductSummary(listingRow(), [], 'Acme', []);

    expect('imageUrl' in summary).toBe(false);
    expect(summary.imageUrl).toBeUndefined();
    expect(summary).not.toHaveProperty('imageFileId');
  });

  it('emits ProductSummary.imageUrl when the listing HAS one', () => {
    const listing = listingRow();
    const summary = toProductSummary(listing, [], 'Acme', [
      imageRow(listing.id, 'file-1'),
    ]);

    expect(summary.imageUrl).toBe('media:file-1:full');
    expect(summary.imageFileId).toBe('file-1');
  });

  it('omits StoreSummary.coverImageUrl when the store has no cover file', () => {
    const summary = toStoreSummary(storeRow({ coverFileId: null, logoFileId: null }), []);

    expect('coverImageUrl' in summary).toBe(false);
    expect(summary).not.toHaveProperty('coverFileId');
    expect(summary).not.toHaveProperty('logoFileId');
  });

  it('emits StoreSummary.coverImageUrl when the store HAS one', () => {
    const summary = toStoreSummary(
      storeRow({
        coverFileId: 'cover-1',
        logoFileId: 'logo-1',
      }),
      [],
    );

    expect(summary.logoFileId).toBe('logo-1');
    expect(summary.coverImageUrl).toBe('media:cover-1:full');
    expect(summary.coverFileId).toBe('cover-1');
  });

  it('omits imageUrl on a featured thumbnail whose listing has no images', () => {
    const listing = listingRow();
    const summary = toStoreSummary(storeRow({ coverFileId: null, logoFileId: null }), [listing]);

    expect(summary.products).toHaveLength(1);
    expect('imageUrl' in summary.products[0]).toBe(false);
    expect(summary.products[0]).not.toHaveProperty('imageFileId');
  });

  it('emits imageUrl on a featured thumbnail whose listing HAS one', () => {
    const listing = listingRow();
    const summary = toStoreSummary(
      storeRow({ coverFileId: null, logoFileId: null }),
      [listing],
      new Map([[listing.id, [imageRow(listing.id, 'thumb-1')]]]),
    );

    expect(summary.products[0].imageUrl).toBe('media:thumb-1:thumb');
    expect(summary.products[0].imageFileId).toBe('thumb-1');
  });

  it.each(['https://supplier.example/image.png', 'http://supplier.example/image.png', 'https://cloud.oxy.so/file-1', 'data:image/png;base64,abc', '/image.png', '', 'not an ID'])('does not resolve an unimported reference: %s', reference => {
    expect(resolveMedia(reference)).toBeUndefined();
  });

  it('resolves stored Oxy URLs only in explicitly URL-valued legacy fields', () => {
    expect(resolveStoredMediaUrl('https://cloud.oxy.so/file-1?variant=thumb')).toBe('media:file-1:thumb');
    expect(resolveStoredMediaUrl('https://cloud.oxy.so/file-1')).toBe('media:file-1:full');
  });

  it.each(['https://supplier.example/photo.jpg', 'https://cloud.oxy.so.evil.example/file-1', 'https://cloud.oxy.so@evil.example/file-1',
    'https://person:secret@cloud.oxy.so/file-1', 'http://cloud.oxy.so/file-1', '//cloud.oxy.so/file-1',
    'https://cloud.oxy.so/https%3A%2F%2Fsupplier.example%2Fphoto.jpg', 'https://cloud.oxy.so/file-1?url=https://supplier.example',
    'https://cloud.oxy.so/file-1?variant=thumb&variant=original', 'https://cloud.oxy.so/file-1#fragment'])('withholds untrusted stored media URL %s', reference => {
    expect(resolveStoredMediaUrl(reference)).toBeUndefined();
  });

  it('omits supplier artwork in product and store summaries, using the first imported gallery image', () => {
    const listing = listingRow();
    const external = imageRow(listing.id, 'https://supplier.example/image.png');
    expect(toProductSummary(listing, [], 'Acme', [external])).not.toHaveProperty('imageUrl');
    expect(toProductSummary(listing, [], 'Acme', [external])).not.toHaveProperty('imageFileId');
    expect(toProductSummary(listing, [], 'Acme', [external, imageRow(listing.id, 'imported')]).imageFileId).toBe('imported');
    expect(toProductSummary(listing, [], 'Acme', [external, imageRow(listing.id, 'imported')]).imageUrl).toBe('media:imported:full');
    const summary = toStoreSummary(storeRow({ coverFileId: external.fileId, logoFileId: external.fileId }), [listing], new Map([[listing.id, [external]]]));
    expect(summary).not.toHaveProperty('coverImageUrl');
    expect(summary).not.toHaveProperty('logoUrl');
    expect(summary).not.toHaveProperty('logoFileId');
    expect(summary).not.toHaveProperty('coverFileId');
    expect(summary.products[0]).not.toHaveProperty('imageFileId');
    expect(summary.products[0]).not.toHaveProperty('imageUrl');
  });
});
