/**
 * Unit tests for `connector-sync.service.runBackfill`.
 *
 * No DB / no network: the Connection/SyncRun/Listing/Category models, the catalog
 * write funnels, the crypto helper and the provider registry are all mocked. The
 * tests drive `runBackfill` with canned `NormalizedProduct`s (via a mocked
 * provider `fetchProducts`) and assert the create path, the override-respecting
 * merge, the all-pinned "skipped" path, and the `connector_wins` policy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedProduct } from '../../connectors/types.js';

const connectionFindOne = vi.fn();
const connectionUpdateOne = vi.fn();
const syncRunCreate = vi.fn();
const listingFind = vi.fn();
const listingFindOne = vi.fn();
const listingUpdateOne = vi.fn();
const listingExists = vi.fn();
const productVariantFind = vi.fn();
const categoryExists = vi.fn();
const createStoreProduct = vi.fn();
const updateListing = vi.fn();
const updateVariant = vi.fn();
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
vi.mock('../../models/listing.js', () => ({
  Listing: {
    find: (...args: unknown[]) => listingFind(...args),
    findOne: (...args: unknown[]) => listingFindOne(...args),
    updateOne: (...args: unknown[]) => listingUpdateOne(...args),
    exists: (...args: unknown[]) => listingExists(...args),
  },
}));
vi.mock('../../models/product-variant.js', () => ({
  ProductVariant: { find: (...args: unknown[]) => productVariantFind(...args) },
}));
vi.mock('../../models/category.js', () => ({
  Category: { exists: (...args: unknown[]) => categoryExists(...args) },
}));
vi.mock('../catalog-write.service.js', () => ({
  createStoreProduct: (...args: unknown[]) => createStoreProduct(...args),
  updateListing: (...args: unknown[]) => updateListing(...args),
  updateVariant: (...args: unknown[]) => updateVariant(...args),
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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONNECTOR_DEFAULT_CATEGORY_SLUG = 'home';
  categoryExists.mockResolvedValue({ _id: 'cat-1' });
  decryptSecret.mockReturnValue(JSON.stringify({ accessToken: 'shpat_test' }));
  syncRunCreate.mockImplementation(() => Promise.resolve(mockRun()));
  connectionUpdateOne.mockResolvedValue({});
  listingUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  // No push-mirror by default (the echo-skip lookup finds nothing).
  listingExists.mockResolvedValue(null);
  // Delete-reconciliation query: no sourced listings by default (no archives).
  listingFind.mockReturnValue({ lean: () => Promise.resolve([]) });
  // Re-price query: no existing variants by default (no re-pricing).
  productVariantFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
  getConnectorProvider.mockReturnValue({ fetchProducts: (...a: unknown[]) => fetchProducts(...a) });
});

describe('runBackfill — create path', () => {
  it('creates a new store product and stamps its connector provenance', async () => {
    connectionFindOne.mockResolvedValue(mockConnection());
    listingFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(createStoreProduct).toHaveBeenCalledTimes(1);
    const [storeArg, input] = createStoreProduct.mock.calls[0];
    expect(storeArg).toBe(STORE_ID);
    expect(input.category).toBe('home');
    expect(input.variants[0].price).toEqual({ amount: 1999, currency: 'USD' });

    // Provenance stamped on the new listing.
    const sourceSet = listingUpdateOne.mock.calls.find(
      ([, update]) => update?.$set?.source,
    );
    expect(sourceSet?.[1].$set.source).toMatchObject({
      connectionId: CONNECTION_ID,
      provider: 'shopify',
      externalId: 'shopify-1',
    });

    expect(run.status).toBe('completed');
    expect(run.counts.created).toBe(1);
    expect(updateListing).not.toHaveBeenCalled();
  });
});

describe('runBackfill — update path respects overriddenFields', () => {
  it('skips a locally-pinned field but overwrites the rest', async () => {
    connectionFindOne.mockResolvedValue(mockConnection('respect_overrides'));
    listingFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: 'listing-existing', overriddenFields: ['title'] }),
    });
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
    listingFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({
        _id: 'listing-existing',
        overriddenFields: ['title', 'description', 'images', 'vendor', 'productType', 'handle', 'seo'],
      }),
    });
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateListing).not.toHaveBeenCalled();
    expect(run.counts.skipped).toBe(1);
    // Provenance (externalUpdatedAt) is still refreshed.
    expect(listingUpdateOne).toHaveBeenCalled();
  });

  it('connector_wins overwrites even locally-edited fields', async () => {
    connectionFindOne.mockResolvedValue(mockConnection('connector_wins'));
    listingFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: 'listing-existing', overriddenFields: ['title'] }),
    });
    fetchProducts.mockResolvedValue({ products: [product()] });

    await runBackfill(STORE_ID, CONNECTION_ID);

    const [, patch] = updateListing.mock.calls[0];
    expect(patch.title).toBe('Imported Title');
  });
});

describe('runBackfill — paging + guards', () => {
  it('follows the provider cursor across pages', async () => {
    connectionFindOne.mockResolvedValue(mockConnection());
    listingFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
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
    listingFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
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

/** An existing variant record as `repriceExistingVariants` reads it (lean). */
function existingVariant(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'v1',
    sku: undefined as string | undefined,
    optionValues: [],
    price: { amount: 1999, currency: 'USD' },
    compareAtPrice: undefined as { amount: number; currency: string } | undefined,
    ...overrides,
  };
}

/** Point `ProductVariant.find(...).select(...).lean()` at the given variant docs. */
function stubExistingVariants(variants: ReturnType<typeof existingVariant>[]) {
  productVariantFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(variants) }) });
}

describe('runBackfill — Fix 1: re-prices existing variants', () => {
  it('applies the connection price rules and updates a variant whose price changed', async () => {
    connectionFindOne.mockResolvedValue(mockConnectionWithMarkup(100)); // ×2
    listingFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: 'listing-existing', overriddenFields: [] }),
    });
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
    listingFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({
        _id: 'listing-existing',
        overriddenFields: ['title', 'description', 'images', 'vendor', 'productType', 'handle', 'seo'],
      }),
    });
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
    listingFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: 'listing-existing', overriddenFields: ['price'] }),
    });
    // Even if a differing variant existed, the pin short-circuits before querying.
    stubExistingVariants([existingVariant()]);
    fetchProducts.mockResolvedValue({ products: [product()] });

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateVariant).not.toHaveBeenCalled();
  });

  it('is a no-op when the incoming price already matches the stored price', async () => {
    connectionFindOne.mockResolvedValue(mockConnection('respect_overrides')); // no markup
    listingFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: 'listing-existing', overriddenFields: [] }),
    });
    stubExistingVariants([existingVariant({ price: { amount: 1999, currency: 'USD' } })]);
    fetchProducts.mockResolvedValue({ products: [product()] }); // incoming also 1999

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateVariant).not.toHaveBeenCalled();
  });

  it('matches variants by SKU when the option tuples are ambiguous', async () => {
    connectionFindOne.mockResolvedValue(mockConnectionWithMarkup(0)); // no price change from rules
    listingFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: 'listing-existing', overriddenFields: [] }),
    });
    // Stored variant keyed by SKU, at a price the incoming product will change.
    stubExistingVariants([
      existingVariant({ _id: 'v-sku', sku: 'ABC', price: { amount: 1000, currency: 'USD' } }),
    ]);
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

/** Point the reconcile query `Listing.find(...).lean()` at the given sourced docs. */
function stubSourcedListings(docs: Array<{ _id: string; source: { externalId: string }; overriddenFields: string[] }>) {
  listingFind.mockReturnValue({ lean: () => Promise.resolve(docs) });
}

/** The archive `Listing.updateOne` call, if any (`$set.status === 'archived'`). */
function archiveCall() {
  return listingUpdateOne.mock.calls.find(([, update]) => update?.$set?.status === 'archived');
}

describe('runBackfill — Fix 3: delete reconciliation', () => {
  it('archives a sourced listing NOT seen in a fully-completed backfill', async () => {
    connectionFindOne.mockResolvedValue(mockConnection());
    listingFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) }); // create path
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product({ externalId: 'p1' })] }); // full: no cursor
    // p1 is seen; p2 is stale → must be archived.
    stubSourcedListings([
      { _id: 'l1', source: { externalId: 'p1' }, overriddenFields: [] },
      { _id: 'l2', source: { externalId: 'p2' }, overriddenFields: [] },
    ]);

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    const archived = archiveCall();
    expect(archived).toBeDefined();
    expect(archived?.[0]['source.externalId']).toBe('p2'); // only the unseen id
    expect(run.status).toBe('completed');
    expect(run.counts.created).toBe(1); // p1
    expect(run.counts.updated).toBe(1); // the archive of p2
  });

  it('does NOT archive on a partial/failed fetch (guards against mass-archive)', async () => {
    connectionFindOne.mockResolvedValue(mockConnection());
    listingFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
    createStoreProduct.mockResolvedValue('listing-new');
    // First page ok (has a next cursor), second page fetch FAILS → partial fetch.
    fetchProducts
      .mockResolvedValueOnce({ products: [product({ externalId: 'p1' })], nextCursor: 'C2' })
      .mockRejectedValueOnce(new Error('shopify 500'));

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(run.status).toBe('failed');
    // The reconcile query is never even issued on a partial fetch.
    expect(listingFind).not.toHaveBeenCalled();
    expect(archiveCall()).toBeUndefined();
  });

  it('respects a pinned status — an unseen but status-pinned listing is not archived', async () => {
    connectionFindOne.mockResolvedValue(mockConnection('respect_overrides'));
    listingFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product({ externalId: 'p1' })] });
    stubSourcedListings([{ _id: 'l2', source: { externalId: 'p2' }, overriddenFields: ['status'] }]);

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(archiveCall()).toBeUndefined();
  });

  it('archives ALL sourced listings when the platform catalog is now empty', async () => {
    connectionFindOne.mockResolvedValue(mockConnection());
    fetchProducts.mockResolvedValue({ products: [] }); // full fetch, zero products
    stubSourcedListings([
      { _id: 'l1', source: { externalId: 'gone-1' }, overriddenFields: [] },
      { _id: 'l2', source: { externalId: 'gone-2' }, overriddenFields: [] },
    ]);

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    const archivedExternalIds = listingUpdateOne.mock.calls
      .filter(([, update]) => update?.$set?.status === 'archived')
      .map(([filter]) => filter['source.externalId']);
    expect(archivedExternalIds).toEqual(['gone-1', 'gone-2']);
    expect(run.status).toBe('completed');
    expect(run.counts.updated).toBe(2);
  });
});
