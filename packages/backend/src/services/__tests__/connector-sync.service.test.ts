/**
 * Unit tests for `connector-sync.service.runBackfill`.
 *
 * No DB / no network. `Connection`/`SyncRun` are still Mongoose and are mocked as
 * models; the CATALOGUE moved to Postgres, so listings, variants, categories, the
 * push mirror and collection membership are mocked at the REPOSITORY boundary —
 * plain async functions returning rows, no `.find().sort().lean()` chains. The
 * catalog-write funnels, the inventory service, the crypto helper and the
 * provider registry are mocked too.
 *
 * The tests drive `runBackfill` with canned `NormalizedProduct`s (via a mocked
 * provider `fetchProducts`) and assert the create path, the override-respecting
 * merge, the all-pinned "skipped" path, the `connector_wins` policy, paging,
 * variant re-pricing and delete reconciliation.
 *
 * Two shapes changed with the storage, and both are visible in the assertions:
 *  - Provenance is FOUR FLAT COLUMNS written through `updateListingColumns`, not
 *    a `$set: { source: {...} }` sub-document — and `sourceExternalUpdatedAt` is
 *    written explicitly `null` when the platform sends none.
 *  - The archive is `findListingBySourceExternalId` + `setListingStatusIfIn`
 *    rather than one `updateOne` whose FILTER carried the provenance key, so
 *    both the import lookup and the archive lookup go through the SAME
 *    repository function and the stub answers per external id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ALL_LISTING_STATUSES } from '@mercaria/shared-types';
import type { NormalizedProduct } from '../../connectors/types.js';

const connectionFindOne = vi.fn();
const connectionUpdateOne = vi.fn();
const syncRunCreate = vi.fn();
const findListingById = vi.fn();
const findListingBySourceExternalId = vi.fn();
const findListingChildren = vi.fn();
const findListingsBySourceConnection = vi.fn();
const setListingStatusIfIn = vi.fn();
const updateListingColumns = vi.fn();
const findVariantBySourceInventoryItemId = vi.fn();
const findVariantOptionValues = vi.fn();
const findVariantsByListing = vi.fn();
const findVariantsBySourceConnection = vi.fn();
const updateVariantColumns = vi.fn();
const listingPushedToConnection = vi.fn();
const findExternalRefByListingAndConnection = vi.fn();
const upsertExternalRef = vi.fn();
const categorySlugExists = vi.fn();
const setListingAutomatedMemberships = vi.fn();
const findLocation = vi.fn();
const createStoreProduct = vi.fn();
const updateListing = vi.fn();
const updateVariant = vi.fn();
const resolveDefaultLocationId = vi.fn();
const setAvailable = vi.fn();
const decryptSecret = vi.fn();
const getConnectorProvider = vi.fn();
const fetchProducts = vi.fn();

vi.mock('../../models/connection.js', () => ({
  Connection: {
    findOne: (...args: unknown[]) => connectionFindOne(...args),
    updateOne: (...args: unknown[]) => connectionUpdateOne(...args),
  },
}));
vi.mock('../../models/sync-run.js', () => ({
  SyncRun: { create: (...args: unknown[]) => syncRunCreate(...args) },
}));
vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingById: (...args: unknown[]) => findListingById(...args),
  findListingBySourceExternalId: (...args: unknown[]) => findListingBySourceExternalId(...args),
  findListingChildren: (...args: unknown[]) => findListingChildren(...args),
  findListingsBySourceConnection: (...args: unknown[]) => findListingsBySourceConnection(...args),
  setListingStatusIfIn: (...args: unknown[]) => setListingStatusIfIn(...args),
  updateListingColumns: (...args: unknown[]) => updateListingColumns(...args),
}));
vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantBySourceInventoryItemId: (...args: unknown[]) =>
    findVariantBySourceInventoryItemId(...args),
  findVariantOptionValues: (...args: unknown[]) => findVariantOptionValues(...args),
  findVariantsByListing: (...args: unknown[]) => findVariantsByListing(...args),
  findVariantsBySourceConnection: (...args: unknown[]) => findVariantsBySourceConnection(...args),
  updateVariant: (...args: unknown[]) => updateVariantColumns(...args),
}));
vi.mock('../../db/catalog/listingExternalRefRepository.js', () => ({
  findExternalRefByListingAndConnection: (...args: unknown[]) =>
    findExternalRefByListingAndConnection(...args),
  listingPushedToConnection: (...args: unknown[]) => listingPushedToConnection(...args),
  upsertExternalRef: (...args: unknown[]) => upsertExternalRef(...args),
}));
vi.mock('../../db/catalog/categoryRepository.js', () => ({
  categorySlugExists: (...args: unknown[]) => categorySlugExists(...args),
}));
vi.mock('../../db/merchandising/collectionRepository.js', () => ({
  setListingAutomatedMemberships: (...args: unknown[]) => setListingAutomatedMemberships(...args),
}));
vi.mock('../../db/stores/locationRepository.js', () => ({
  findLocation: (...args: unknown[]) => findLocation(...args),
}));
vi.mock('../catalog-write.service.js', () => ({
  createStoreProduct: (...args: unknown[]) => createStoreProduct(...args),
  updateListing: (...args: unknown[]) => updateListing(...args),
  updateVariant: (...args: unknown[]) => updateVariant(...args),
  resolveDefaultLocationId: (...args: unknown[]) => resolveDefaultLocationId(...args),
}));
vi.mock('../inventory.service.js', () => ({
  setAvailable: (...args: unknown[]) => setAvailable(...args),
}));
vi.mock('../../lib/connector-crypto.js', () => ({
  encryptSecret: vi.fn(),
  decryptSecret: (...args: unknown[]) => decryptSecret(...args),
}));
vi.mock('../../connectors/registry.js', () => ({
  getConnectorProvider: (...args: unknown[]) => getConnectorProvider(...args),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { runBackfill } from '../connector-sync.service.js';

const STORE_ID = 'store-1';
const CONNECTION_ID = 'conn-1';

/** A mutable mock SyncRun doc (the service assigns counts/status and saves). */
function mockRun() {
  return {
    _id: 'run-1',
    connectionId: CONNECTION_ID,
    kind: 'backfill' as const,
    status: 'running' as const,
    counts: { created: 0, updated: 0, skipped: 0, failed: 0 },
    startedAt: new Date(),
    finishedAt: undefined as Date | undefined,
    error: undefined as string | undefined,
    save: vi.fn().mockResolvedValue(undefined),
  };
}

/** A connected Shopify pull connection with the given conflict policy. */
function mockConnection(conflictPolicy: 'respect_overrides' | 'connector_wins' = 'respect_overrides') {
  return {
    _id: CONNECTION_ID,
    storeId: STORE_ID,
    provider: 'shopify' as const,
    mode: 'pull' as const,
    status: 'connected' as const,
    credentials: { ciphertext: 'x', iv: 'y', tag: 'z' },
    shopDomain: 'acme.myshopify.com',
    shopCurrency: 'USD',
    syncSettings: {
      products: 'pull' as const,
      inventory: 'off' as const,
      orders: 'off' as const,
      autoPublish: true,
      conflictPolicy,
    },
  };
}

/** A canned normalized product. */
function product(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    externalId: 'shopify-1',
    externalUpdatedAt: new Date('2026-07-12T00:00:00Z'),
    title: 'Imported Title',
    description: 'Imported description',
    handle: 'imported',
    vendor: 'Acme',
    productType: 'Widget',
    options: [],
    imageUrls: ['https://cdn.shopify.com/img.jpg'],
    variants: [{ optionValues: [], price: { amount: 1999, currency: 'USD' }, inventory: { tracked: true, available: 3 } }],
    ...overrides,
  };
}

/**
 * A `listings` row as the repositories return it: FLAT, with the columns the
 * import merge and the reconcile sweep read.
 */
function listingRow(
  id: string,
  overrides: { sourceExternalId?: string; overriddenFields?: string[]; status?: string } = {},
): unknown {
  return {
    id,
    storeId: STORE_ID,
    status: overrides.status ?? 'active',
    sourceConnectionId: CONNECTION_ID,
    sourceProvider: 'shopify',
    sourceExternalId: overrides.sourceExternalId ?? 'shopify-1',
    overriddenFields: overrides.overriddenFields ?? [],
  };
}

/**
 * Answer the provenance lookup per external id.
 *
 * The import path and the archive path both resolve a listing through
 * `findListingBySourceExternalId` now — Mongo used a `findOne` for the import and
 * a provenance-FILTERED `updateOne` for the archive, so they were two different
 * mocks — which is why a single `mockResolvedValue` cannot serve both.
 */
function stubListingsByExternalId(rows: Record<string, unknown>): void {
  findListingBySourceExternalId.mockImplementation((_storeId, _connectionId, externalId) =>
    Promise.resolve(rows[externalId] ?? null),
  );
}

/** The `updateListingColumns` patch carrying the provenance columns, if any. */
function provenancePatch(): Record<string, unknown> | undefined {
  const call = updateListingColumns.mock.calls.find(([, patch]) => 'sourceExternalId' in patch);
  return call?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONNECTOR_DEFAULT_CATEGORY_SLUG = 'home';
  categorySlugExists.mockResolvedValue(true);
  decryptSecret.mockReturnValue(JSON.stringify({ accessToken: 'shpat_test' }));
  syncRunCreate.mockImplementation(() => Promise.resolve(mockRun()));
  connectionUpdateOne.mockResolvedValue({});
  updateListingColumns.mockResolvedValue(null);
  setListingStatusIfIn.mockResolvedValue(true);
  // No push-mirror by default (the echo-skip lookup finds nothing).
  listingPushedToConnection.mockResolvedValue(false);
  // Delete-reconciliation read: no sourced listings by default (no archives).
  findListingsBySourceConnection.mockResolvedValue([]);
  // Re-price read: no existing variants by default (no re-pricing).
  findVariantsByListing.mockResolvedValue([]);
  findVariantOptionValues.mockResolvedValue(new Map());
  getConnectorProvider.mockReturnValue({ fetchProducts: (...a: unknown[]) => fetchProducts(...a) });
});

describe('runBackfill — create path', () => {
  it('creates a new store product and stamps its connector provenance', async () => {
    connectionFindOne.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(createStoreProduct).toHaveBeenCalledTimes(1);
    const [storeArg, input] = createStoreProduct.mock.calls[0];
    expect(storeArg).toBe(STORE_ID);
    expect(input.category).toBe('home');
    expect(input.variants[0].price).toEqual({ amount: 1999, currency: 'USD' });

    // Provenance stamped on the new listing. The old assertion read a
    // `$set.source` sub-document off a `Listing.updateOne`; the four fields are
    // flat columns now, written through `updateListingColumns`. `autoPublish` is
    // true for this connection, so no `status` is forced.
    expect(updateListingColumns).toHaveBeenCalledWith('listing-new', {
      sourceConnectionId: CONNECTION_ID,
      sourceProvider: 'shopify',
      sourceExternalId: 'shopify-1',
      sourceExternalUpdatedAt: new Date('2026-07-12T00:00:00Z'),
    });

    expect(run.status).toBe('completed');
    expect(run.counts.created).toBe(1);
    expect(updateListing).not.toHaveBeenCalled();
  });

  it('writes an explicit NULL when the platform reports no externalUpdatedAt', async () => {
    // Behaviour change worth pinning: assigning the embedded `source` simply left
    // the key out, keeping the PREVIOUS sync's timestamp on a product whose
    // source had stopped reporting one. A flat column is written either way.
    connectionFindOne.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product({ externalUpdatedAt: undefined })] });

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(provenancePatch()).toMatchObject({ sourceExternalUpdatedAt: null });
  });

  it('skips an inbound product that is an echo of our own push (loop prevention)', async () => {
    connectionFindOne.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    // The push mirror moved from an embedded `externalRefs` array to its own
    // table; the echo check is the repository predicate over it.
    listingPushedToConnection.mockResolvedValue(true);
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(listingPushedToConnection).toHaveBeenCalledWith(STORE_ID, CONNECTION_ID, 'shopify-1');
    expect(createStoreProduct).not.toHaveBeenCalled();
    expect(run.counts.skipped).toBe(1);
  });
});

describe('runBackfill — update path respects overriddenFields', () => {
  it('skips a locally-pinned field but overwrites the rest', async () => {
    connectionFindOne.mockResolvedValue(mockConnection('respect_overrides'));
    findListingBySourceExternalId.mockResolvedValue(
      listingRow('listing-existing', { overriddenFields: ['title'] }),
    );
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(createStoreProduct).not.toHaveBeenCalled();
    expect(updateListing).toHaveBeenCalledTimes(1);
    const [listingId, patch] = updateListing.mock.calls[0];
    expect(listingId).toBe('listing-existing');
    // Pinned title is NOT written; description + images (etc.) are.
    expect(patch.title).toBeUndefined();
    expect(patch.description).toBe('Imported description');
    expect(patch.imageFileIds).toEqual(['https://cdn.shopify.com/img.jpg']);
    expect(run.counts.updated).toBe(1);
  });

  it('counts a product as skipped when every managed field is pinned', async () => {
    connectionFindOne.mockResolvedValue(mockConnection('respect_overrides'));
    findListingBySourceExternalId.mockResolvedValue(
      listingRow('listing-existing', {
        overriddenFields: ['title', 'description', 'images', 'vendor', 'productType', 'handle', 'seo'],
      }),
    );
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateListing).not.toHaveBeenCalled();
    expect(run.counts.skipped).toBe(1);
    // Provenance (externalUpdatedAt) is still refreshed.
    expect(provenancePatch()).toMatchObject({ sourceExternalId: 'shopify-1' });
  });

  it('connector_wins overwrites even locally-edited fields', async () => {
    connectionFindOne.mockResolvedValue(mockConnection('connector_wins'));
    findListingBySourceExternalId.mockResolvedValue(
      listingRow('listing-existing', { overriddenFields: ['title'] }),
    );
    fetchProducts.mockResolvedValue({ products: [product()] });

    await runBackfill(STORE_ID, CONNECTION_ID);

    const [, patch] = updateListing.mock.calls[0];
    expect(patch.title).toBe('Imported Title');
  });
});

describe('runBackfill — paging + guards', () => {
  it('follows the provider cursor across pages', async () => {
    connectionFindOne.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-x');
    fetchProducts
      .mockResolvedValueOnce({ products: [product({ externalId: 'p1' })], nextCursor: 'CURSOR2' })
      .mockResolvedValueOnce({ products: [product({ externalId: 'p2' })] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(fetchProducts).toHaveBeenCalledTimes(2);
    expect(fetchProducts.mock.calls[1][1]).toBe('CURSOR2');
    expect(run.counts.created).toBe(2);
  });

  it('rejects when product pull is disabled for the connection', async () => {
    const base = mockConnection();
    connectionFindOne.mockResolvedValue({
      ...base,
      syncSettings: { ...base.syncSettings, products: 'off' },
    });

    await expect(runBackfill(STORE_ID, CONNECTION_ID)).rejects.toThrow(/not enabled/);
    expect(syncRunCreate).not.toHaveBeenCalled();
  });

  it('records a failed run (does not throw) when a page fetch fails mid-run', async () => {
    connectionFindOne.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    fetchProducts.mockRejectedValue(new Error('shopify 500'));

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(run.status).toBe('failed');
    expect(run.error).toContain('shopify 500');
  });
});

// --- Fix 1: re-price existing variants on the update path --------------------

/** A connected pull connection whose `priceRules` apply a markup. */
function mockConnectionWithMarkup(markupPercent: number) {
  const base = mockConnection('respect_overrides');
  return {
    ...base,
    syncSettings: { ...base.syncSettings, priceRules: { markupPercent } },
  };
}

/**
 * An existing `product_variants` row as `repriceExistingVariants` reads it.
 *
 * `price` was ONE embedded object; it is two NULLABLE columns here, so a fixture
 * states `priceAmount`/`priceCurrency` separately — and a variant with neither is
 * now representable (see the null-price case below).
 */
function existingVariant(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'v1',
    listingId: 'listing-existing',
    sku: null,
    priceAmount: 1999,
    priceCurrency: 'USD',
    compareAtPriceAmount: null,
    compareAtPriceCurrency: null,
    inventoryTracked: true,
    inventoryAvailable: 3,
    ...overrides,
  };
}

/**
 * Point the re-price read at the given variant rows.
 *
 * `optionValues` is a CHILD TABLE now, loaded once for the whole listing rather
 * than embedded in each variant, so the stub answers both reads: the variants and
 * their option-value map (empty here — these fixtures match by SKU or by the
 * empty option tuple).
 */
function stubExistingVariants(variants: unknown[]): void {
  findVariantsByListing.mockResolvedValue(variants);
  findVariantOptionValues.mockResolvedValue(new Map());
}

describe('runBackfill — Fix 1: re-prices existing variants', () => {
  it('applies the connection price rules and updates a variant whose price changed', async () => {
    connectionFindOne.mockResolvedValue(mockConnectionWithMarkup(100)); // ×2
    findListingBySourceExternalId.mockResolvedValue(listingRow('listing-existing'));
    stubExistingVariants([existingVariant()]); // stored at 1999
    fetchProducts.mockResolvedValue({ products: [product()] }); // incoming 1999 → ×2 = 3998

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateVariant).toHaveBeenCalledTimes(1);
    const [listingId, variantId, patch] = updateVariant.mock.calls[0];
    expect(listingId).toBe('listing-existing');
    expect(variantId).toBe('v1');
    expect(patch.price).toEqual({ amount: 3998, currency: 'USD' });
    expect(run.counts.updated).toBe(1);
  });

  it('re-prices even when every listing field is pinned — counts the product as updated', async () => {
    connectionFindOne.mockResolvedValue(mockConnectionWithMarkup(100));
    // All connector-managed LISTING fields pinned (so the listing patch is empty),
    // but `price` is NOT pinned — the re-price alone must bump the outcome to updated.
    findListingBySourceExternalId.mockResolvedValue(
      listingRow('listing-existing', {
        overriddenFields: ['title', 'description', 'images', 'vendor', 'productType', 'handle', 'seo'],
      }),
    );
    stubExistingVariants([existingVariant()]);
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateListing).not.toHaveBeenCalled(); // listing patch was empty
    expect(updateVariant).toHaveBeenCalledTimes(1);
    expect(run.counts.updated).toBe(1);
    expect(run.counts.skipped).toBe(0);
  });

  it('skips re-pricing when `price` is pinned in overriddenFields', async () => {
    connectionFindOne.mockResolvedValue(mockConnectionWithMarkup(100));
    findListingBySourceExternalId.mockResolvedValue(
      listingRow('listing-existing', { overriddenFields: ['price'] }),
    );
    // Even if a differing variant existed, the pin short-circuits before reading.
    stubExistingVariants([existingVariant()]);
    fetchProducts.mockResolvedValue({ products: [product()] });

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateVariant).not.toHaveBeenCalled();
    expect(findVariantsByListing).not.toHaveBeenCalled();
  });

  it('is a no-op when the incoming price already matches the stored price', async () => {
    connectionFindOne.mockResolvedValue(mockConnection('respect_overrides')); // no markup
    findListingBySourceExternalId.mockResolvedValue(listingRow('listing-existing'));
    stubExistingVariants([existingVariant({ priceAmount: 1999, priceCurrency: 'USD' })]);
    fetchProducts.mockResolvedValue({ products: [product()] }); // incoming also 1999

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateVariant).not.toHaveBeenCalled();
  });

  it('prices a variant that has NO stored price at all — a state Mongo could not hold', async () => {
    // `price` was required on the Mongoose model; both of its columns are nullable
    // here. NULL must differ from every incoming amount, so the first re-sync
    // prices the variant rather than leaving it priceless.
    connectionFindOne.mockResolvedValue(mockConnection('respect_overrides'));
    findListingBySourceExternalId.mockResolvedValue(listingRow('listing-existing'));
    stubExistingVariants([existingVariant({ priceAmount: null, priceCurrency: null })]);
    fetchProducts.mockResolvedValue({ products: [product()] });

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateVariant).toHaveBeenCalledTimes(1);
    const [, , patch] = updateVariant.mock.calls[0];
    expect(patch.price).toEqual({ amount: 1999, currency: 'USD' });
  });

  it('matches variants by SKU when the option tuples are ambiguous', async () => {
    connectionFindOne.mockResolvedValue(mockConnectionWithMarkup(0)); // no price change from rules
    findListingBySourceExternalId.mockResolvedValue(listingRow('listing-existing'));
    // Stored variant keyed by SKU, at a price the incoming product will change.
    stubExistingVariants([existingVariant({ id: 'v-sku', sku: 'ABC', priceAmount: 1000 })]);
    fetchProducts.mockResolvedValue({
      products: [product({ variants: [{ optionValues: [], sku: 'ABC', price: { amount: 2500, currency: 'USD' }, inventory: { tracked: true, available: 1 } }] })],
    });

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateVariant).toHaveBeenCalledTimes(1);
    const [, variantId, patch] = updateVariant.mock.calls[0];
    expect(variantId).toBe('v-sku');
    expect(patch.price).toEqual({ amount: 2500, currency: 'USD' });
  });
});

// --- Fix 3: delete reconciliation in backfill -------------------------------

/**
 * The listing ids `setListingStatusIfIn` was asked to archive.
 *
 * The old helper read `filter['source.externalId']` off the archiving
 * `Listing.updateOne`, because the provenance key WAS the update's filter. The
 * archive is a two-step now (resolve by provenance, then a conditional status
 * write by id), so the archived set is identified by listing id — and the
 * external ids it came from are pinned by the `findListingBySourceExternalId`
 * calls asserted alongside.
 */
function archivedListingIds(): string[] {
  return setListingStatusIfIn.mock.calls
    .filter(([, next]) => next === 'archived')
    .map(([listingId]) => listingId);
}

describe('runBackfill — Fix 3: delete reconciliation', () => {
  it('archives a sourced listing NOT seen in a fully-completed backfill', async () => {
    connectionFindOne.mockResolvedValue(mockConnection());
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product({ externalId: 'p1' })] }); // full: no cursor
    // p1 is unknown (create path); p2 is stale → must be archived.
    stubListingsByExternalId({ p2: listingRow('l2', { sourceExternalId: 'p2' }) });
    findListingsBySourceConnection.mockResolvedValue([
      listingRow('l1', { sourceExternalId: 'p1' }),
      listingRow('l2', { sourceExternalId: 'p2' }),
    ]);

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(findListingsBySourceConnection).toHaveBeenCalledWith(STORE_ID, CONNECTION_ID);
    expect(archivedListingIds()).toEqual(['l2']); // only the unseen id
    expect(setListingStatusIfIn).toHaveBeenCalledWith('l2', 'archived', ALL_LISTING_STATUSES);
    expect(run.status).toBe('completed');
    expect(run.counts.created).toBe(1); // p1
    expect(run.counts.updated).toBe(1); // the archive of p2
  });

  it('does NOT archive on a partial/failed fetch (guards against mass-archive)', async () => {
    connectionFindOne.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');
    // First page ok (has a next cursor), second page fetch FAILS → partial fetch.
    fetchProducts
      .mockResolvedValueOnce({ products: [product({ externalId: 'p1' })], nextCursor: 'C2' })
      .mockRejectedValueOnce(new Error('shopify 500'));

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(run.status).toBe('failed');
    // The reconcile read is never even issued on a partial fetch.
    expect(findListingsBySourceConnection).not.toHaveBeenCalled();
    expect(archivedListingIds()).toEqual([]);
  });

  it('respects a pinned status — an unseen but status-pinned listing is not archived', async () => {
    connectionFindOne.mockResolvedValue(mockConnection('respect_overrides'));
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product({ externalId: 'p1' })] });
    stubListingsByExternalId({ p2: listingRow('l2', { sourceExternalId: 'p2' }) });
    findListingsBySourceConnection.mockResolvedValue([
      listingRow('l2', { sourceExternalId: 'p2', overriddenFields: ['status'] }),
    ]);

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(archivedListingIds()).toEqual([]);
  });

  it('never re-archives an ALREADY-archived sourced listing', async () => {
    // The repository read is deliberately status-agnostic (the Mongo query filtered
    // `status: { $ne: 'archived' }` itself), so the service filters — and this is
    // what keeps a nightly reconcile from re-counting yesterday's archives.
    connectionFindOne.mockResolvedValue(mockConnection());
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product({ externalId: 'p1' })] });
    stubListingsByExternalId({ p2: listingRow('l2', { sourceExternalId: 'p2', status: 'archived' }) });
    findListingsBySourceConnection.mockResolvedValue([
      listingRow('l2', { sourceExternalId: 'p2', status: 'archived' }),
    ]);

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(archivedListingIds()).toEqual([]);
    expect(run.counts.updated).toBe(0);
  });

  it('archives ALL sourced listings when the platform catalog is now empty', async () => {
    connectionFindOne.mockResolvedValue(mockConnection());
    fetchProducts.mockResolvedValue({ products: [] }); // full fetch, zero products
    stubListingsByExternalId({
      'gone-1': listingRow('l1', { sourceExternalId: 'gone-1' }),
      'gone-2': listingRow('l2', { sourceExternalId: 'gone-2' }),
    });
    findListingsBySourceConnection.mockResolvedValue([
      listingRow('l1', { sourceExternalId: 'gone-1' }),
      listingRow('l2', { sourceExternalId: 'gone-2' }),
    ]);

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(archivedListingIds()).toEqual(['l1', 'l2']);
    expect(findListingBySourceExternalId.mock.calls.map(([, , externalId]) => externalId)).toEqual([
      'gone-1',
      'gone-2',
    ]);
    expect(run.status).toBe('completed');
    expect(run.counts.updated).toBe(2);
  });
});
