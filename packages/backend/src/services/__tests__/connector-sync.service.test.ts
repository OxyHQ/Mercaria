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
const listingFindOne = vi.fn();
const listingUpdateOne = vi.fn();
const listingExists = vi.fn();
const categoryExists = vi.fn();
const createStoreProduct = vi.fn();
const updateListing = vi.fn();
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
    findOne: (...args: unknown[]) => listingFindOne(...args),
    updateOne: (...args: unknown[]) => listingUpdateOne(...args),
    exists: (...args: unknown[]) => listingExists(...args),
  },
}));
vi.mock('../../models/category.js', () => ({
  Category: { exists: (...args: unknown[]) => categoryExists(...args) },
}));
vi.mock('../catalog-write.service.js', () => ({
  createStoreProduct: (...args: unknown[]) => createStoreProduct(...args),
  updateListing: (...args: unknown[]) => updateListing(...args),
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
  listingUpdateOne.mockResolvedValue({});
  // No push-mirror by default (the echo-skip lookup finds nothing).
  listingExists.mockResolvedValue(null);
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
