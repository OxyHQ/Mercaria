/**
 * Unit tests for `channel-ingest.service` — the `push_in` receive side.
 *
 * No DB / no network. `Connection`/`SyncRun` are still Mongoose and are mocked as
 * models; the CATALOGUE moved to Postgres, so the listing/variant reads and the
 * provenance write are mocked at the REPOSITORY boundary
 * (`db/catalog/listingRepository`, `db/catalog/variantRepository`) — plain async
 * functions returning rows, no query chains. The catalog-write funnels, the
 * inventory service and the shared connector-sync resolvers are mocked too.
 *
 * The tests drive the service with `IngestProduct`/inventory DTOs and assert: the
 * create path (+ provenance + draft), the override-respecting merge, the
 * all-pinned "skipped" path, `connector_wins`, per-item failure isolation,
 * idempotency (same externalId twice never double-creates), cross-store isolation
 * + the non-push_in rejection, connect-push upsert/conflict, and the inventory
 * mapping (single-variant, by-SKU, unmapped skip).
 *
 * Provenance is FOUR FLAT COLUMNS now (`sourceConnectionId`, `sourceProvider`,
 * `sourceExternalId`, `sourceExternalUpdatedAt`) applied with
 * `updateListingColumns`, not a `$set: { source: {...} }` sub-document — and the
 * timestamp is written explicitly `null` when the platform sends none, which the
 * embedded version could not express (it left the key out, silently keeping the
 * previous push's value). Both are pinned below.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  IngestInventoryInput,
  IngestProduct,
  IngestProductsInput,
} from '@mercaria/shared-types';

const connectionFindOne = vi.fn();
const connectionFindOneAndUpdate = vi.fn();
const connectionUpdateOne = vi.fn();
const syncRunCreate = vi.fn();
const findListingBySourceExternalId = vi.fn();
const updateListingColumns = vi.fn();
const findVariantByListingAndSku = vi.fn();
const findVariantsByListing = vi.fn();
const createStoreProduct = vi.fn();
const updateListing = vi.fn();
const setAvailable = vi.fn();
const resolveImportCategorySlug = vi.fn();
const resolveImportLocationId = vi.fn();
const resolveInventoryLocationId = vi.fn();

vi.mock('../../models/connection.js', () => ({
  Connection: {
    findOne: (...args: unknown[]) => connectionFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => connectionFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => connectionUpdateOne(...args),
  },
}));
vi.mock('../../models/sync-run.js', () => ({
  SyncRun: { create: (...args: unknown[]) => syncRunCreate(...args) },
}));
vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingBySourceExternalId: (...args: unknown[]) => findListingBySourceExternalId(...args),
  updateListingColumns: (...args: unknown[]) => updateListingColumns(...args),
}));
vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantByListingAndSku: (...args: unknown[]) => findVariantByListingAndSku(...args),
  findVariantsByListing: (...args: unknown[]) => findVariantsByListing(...args),
}));
vi.mock('../catalog-write.service.js', () => ({
  createStoreProduct: (...args: unknown[]) => createStoreProduct(...args),
  updateListing: (...args: unknown[]) => updateListing(...args),
}));
vi.mock('../inventory.service.js', () => ({
  setAvailable: (...args: unknown[]) => setAvailable(...args),
}));
vi.mock('../connector-sync.service.js', () => ({
  resolveImportCategorySlug: (...args: unknown[]) => resolveImportCategorySlug(...args),
  resolveImportLocationId: (...args: unknown[]) => resolveImportLocationId(...args),
  resolveInventoryLocationId: (...args: unknown[]) => resolveInventoryLocationId(...args),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  connectPushIn,
  ingestInventory,
  ingestProducts,
  isKnownConnectorProvider,
} from '../channel-ingest.service.js';

const STORE_ID = 'store-1';
const CONNECTION_ID = 'conn-1';

/** A mutable mock SyncRun doc (the service assigns counts/status and saves). */
function mockRun() {
  return {
    _id: 'run-1',
    connectionId: CONNECTION_ID,
    kind: 'ingest' as const,
    status: 'running' as const,
    counts: { created: 0, updated: 0, skipped: 0, failed: 0 },
    startedAt: new Date(),
    finishedAt: undefined as Date | undefined,
    error: undefined as string | undefined,
    save: vi.fn().mockResolvedValue(undefined),
  };
}

/** A connected `push_in` WooCommerce connection with the given conflict policy. */
function pushInConnection(
  overrides: {
    mode?: 'pull' | 'push_in';
    conflictPolicy?: 'respect_overrides' | 'connector_wins';
    autoPublish?: boolean;
  } = {},
) {
  return {
    _id: CONNECTION_ID,
    storeId: STORE_ID,
    provider: 'woocommerce' as const,
    mode: overrides.mode ?? ('push_in' as const),
    status: 'connected' as const,
    syncSettings: {
      products: 'off' as const,
      inventory: 'off' as const,
      orders: 'off' as const,
      autoPublish: overrides.autoPublish ?? false,
      conflictPolicy: overrides.conflictPolicy ?? ('respect_overrides' as const),
    },
  };
}

/** A canned ingest product. */
function ingestProduct(overrides: Partial<IngestProduct> = {}): IngestProduct {
  return {
    externalId: 'woo-1',
    externalUpdatedAt: '2026-07-12T00:00:00Z',
    title: 'Woo Title',
    description: 'Woo description',
    images: ['https://cdn.woo.com/img.jpg'],
    options: [],
    variants: [
      { optionValues: [], price: { amount: 2500, currency: 'EUR' }, inventory: { available: 5 }, sku: 'SKU-1' },
    ],
    vendor: 'Acme',
    productType: 'Widget',
    handle: 'woo-title',
    ...overrides,
  };
}

/**
 * A `listings` row as `findListingBySourceExternalId` returns it — flat, with the
 * two columns the ingest merge reads.
 */
function sourcedListingRow(id: string, overriddenFields: string[] = []): unknown {
  return {
    id,
    storeId: STORE_ID,
    status: 'active',
    sourceConnectionId: CONNECTION_ID,
    sourceProvider: 'woocommerce',
    sourceExternalId: 'woo-1',
    overriddenFields,
  };
}

/** The `updateListingColumns` patch that carries the provenance columns. */
function provenancePatch(): Record<string, unknown> | undefined {
  const call = updateListingColumns.mock.calls.find(([, patch]) => 'sourceExternalId' in patch);
  return call?.[1];
}

const productsBody = (products: IngestProduct[]): IngestProductsInput => ({ products });

beforeEach(() => {
  vi.clearAllMocks();
  resolveImportCategorySlug.mockResolvedValue('home');
  syncRunCreate.mockImplementation(() => Promise.resolve(mockRun()));
  connectionUpdateOne.mockResolvedValue({});
  updateListingColumns.mockResolvedValue(null);
  resolveImportLocationId.mockResolvedValue(undefined);
  resolveInventoryLocationId.mockResolvedValue('loc-1');
  setAvailable.mockResolvedValue(undefined);
});

describe('isKnownConnectorProvider', () => {
  it('accepts the known provider ids and rejects unknowns', () => {
    expect(isKnownConnectorProvider('woocommerce')).toBe(true);
    expect(isKnownConnectorProvider('shopify')).toBe(true);
    expect(isKnownConnectorProvider('bigcommerce')).toBe(false);
    expect(isKnownConnectorProvider('')).toBe(false);
  });
});

describe('ingestProducts — create path', () => {
  it('creates a store product, stamps provenance, holds as draft, and echoes the result', async () => {
    let captured: ReturnType<typeof mockRun> | undefined;
    syncRunCreate.mockImplementation(() => {
      captured = mockRun();
      return Promise.resolve(captured);
    });
    connectionFindOne.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');

    const result = await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));

    expect(createStoreProduct).toHaveBeenCalledTimes(1);
    const [storeArg, input] = createStoreProduct.mock.calls[0];
    expect(storeArg).toBe(STORE_ID);
    expect(input.category).toBe('home');
    expect(input.variants[0].price).toEqual({ amount: 2500, currency: 'EUR' });
    expect(input.variants[0].inventory).toEqual({ tracked: true, available: 5 });

    // Provenance + draft stamped on the new listing (autoPublish false). The old
    // assertion read a `$set.source` SUB-DOCUMENT off a `Listing.updateOne`; the
    // four fields are flat columns now, written through `updateListingColumns`.
    expect(updateListingColumns).toHaveBeenCalledWith('listing-new', {
      sourceConnectionId: CONNECTION_ID,
      sourceProvider: 'woocommerce',
      sourceExternalId: 'woo-1',
      sourceExternalUpdatedAt: new Date('2026-07-12T00:00:00Z'),
      status: 'draft',
    });

    expect(result.results).toEqual([{ externalId: 'woo-1', action: 'created', listingId: 'listing-new' }]);
    expect(captured?.status).toBe('completed');
    expect(captured?.counts.created).toBe(1);
    expect(updateListing).not.toHaveBeenCalled();
    expect(connectionUpdateOne).toHaveBeenCalledWith(
      { _id: CONNECTION_ID },
      { $set: { lastSyncAt: expect.any(Date) } },
    );
  });

  it('publishes (no draft) when the connection autoPublishes', async () => {
    connectionFindOne.mockResolvedValue(pushInConnection({ autoPublish: true }));
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');

    await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));

    expect(provenancePatch()).not.toHaveProperty('status');
  });

  it('writes an explicit NULL when the platform reports no externalUpdatedAt', async () => {
    // Behaviour change worth pinning: the embedded `source` simply omitted the key,
    // so a re-push from a platform that had STOPPED sending a timestamp kept the
    // previous push's value on the listing. A flat column is written either way.
    connectionFindOne.mockResolvedValue(pushInConnection({ autoPublish: true }));
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');

    await ingestProducts(
      STORE_ID,
      CONNECTION_ID,
      productsBody([ingestProduct({ externalUpdatedAt: undefined })]),
    );

    expect(provenancePatch()).toMatchObject({ sourceExternalUpdatedAt: null });
  });
});

describe('ingestProducts — update path respects overriddenFields', () => {
  it('skips a locally-pinned field but overwrites the rest', async () => {
    connectionFindOne.mockResolvedValue(pushInConnection({ conflictPolicy: 'respect_overrides' }));
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-existing', ['title']));

    const result = await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));

    expect(createStoreProduct).not.toHaveBeenCalled();
    expect(updateListing).toHaveBeenCalledTimes(1);
    const [listingId, patch] = updateListing.mock.calls[0];
    expect(listingId).toBe('listing-existing');
    expect(patch.title).toBeUndefined();
    expect(patch.description).toBe('Woo description');
    expect(patch.imageFileIds).toEqual(['https://cdn.woo.com/img.jpg']);
    expect(result.results[0]).toEqual({
      externalId: 'woo-1',
      action: 'updated',
      listingId: 'listing-existing',
    });
  });

  it('counts a product as skipped when every managed field is pinned', async () => {
    let captured: ReturnType<typeof mockRun> | undefined;
    syncRunCreate.mockImplementation(() => {
      captured = mockRun();
      return Promise.resolve(captured);
    });
    connectionFindOne.mockResolvedValue(pushInConnection({ conflictPolicy: 'respect_overrides' }));
    findListingBySourceExternalId.mockResolvedValue(
      sourcedListingRow('listing-existing', [
        'title',
        'description',
        'images',
        'vendor',
        'productType',
        'handle',
        'seo',
      ]),
    );

    const result = await ingestProducts(
      STORE_ID,
      CONNECTION_ID,
      productsBody([ingestProduct({ seo: { title: 'S', description: 'D' } })]),
    );

    expect(updateListing).not.toHaveBeenCalled();
    expect(result.results[0].action).toBe('skipped');
    expect(captured?.counts.skipped).toBe(1);
    // Provenance is still refreshed.
    expect(provenancePatch()).toMatchObject({ sourceExternalId: 'woo-1' });
  });

  it('connector_wins overwrites even locally-edited fields', async () => {
    connectionFindOne.mockResolvedValue(pushInConnection({ conflictPolicy: 'connector_wins' }));
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-existing', ['title']));

    await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));

    const [, patch] = updateListing.mock.calls[0];
    expect(patch.title).toBe('Woo Title');
  });
});

describe('ingestProducts — idempotency + failure isolation', () => {
  it('never double-creates the same externalId across two pushes', async () => {
    connectionFindOne.mockResolvedValue(pushInConnection());
    createStoreProduct.mockResolvedValue('listing-new');
    // First push: not found → create. Second push: found → update.
    findListingBySourceExternalId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sourcedListingRow('listing-new'));

    const first = await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));
    const second = await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));

    expect(createStoreProduct).toHaveBeenCalledTimes(1);
    expect(first.results[0].action).toBe('created');
    expect(second.results[0].action).toBe('updated');
    expect(second.results[0].listingId).toBe('listing-new');
  });

  it('isolates a per-product failure (counts + reports it, keeps going)', async () => {
    let captured: ReturnType<typeof mockRun> | undefined;
    syncRunCreate.mockImplementation(() => {
      captured = mockRun();
      return Promise.resolve(captured);
    });
    connectionFindOne.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct
      .mockRejectedValueOnce(new Error('duplicate handle'))
      .mockResolvedValueOnce('listing-ok');

    const result = await ingestProducts(
      STORE_ID,
      CONNECTION_ID,
      productsBody([ingestProduct({ externalId: 'bad' }), ingestProduct({ externalId: 'good' })]),
    );

    expect(result.results[0]).toMatchObject({ externalId: 'bad', action: 'failed' });
    expect(result.results[0].error).toContain('duplicate handle');
    expect(result.results[1]).toMatchObject({ externalId: 'good', action: 'created' });
    expect(captured?.counts.failed).toBe(1);
    expect(captured?.counts.created).toBe(1);
    // Partial success is still a completed run.
    expect(captured?.status).toBe('completed');
  });

  it('marks the run failed only when every product fails', async () => {
    let captured: ReturnType<typeof mockRun> | undefined;
    syncRunCreate.mockImplementation(() => {
      captured = mockRun();
      return Promise.resolve(captured);
    });
    connectionFindOne.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockRejectedValue(new Error('boom'));

    await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));

    expect(captured?.status).toBe('failed');
  });
});

describe('ingestProducts — connection guards (cross-store isolation)', () => {
  it('rejects when the connection does not belong to the store (404)', async () => {
    // `{ _id, storeId }` never matches another store's connection.
    connectionFindOne.mockResolvedValue(null);

    await expect(
      ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()])),
    ).rejects.toThrow(/not found/i);
    expect(createStoreProduct).not.toHaveBeenCalled();
    expect(syncRunCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-push_in connection (400)', async () => {
    connectionFindOne.mockResolvedValue(pushInConnection({ mode: 'pull' }));

    await expect(
      ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()])),
    ).rejects.toThrow(/not a push-in channel/i);
    expect(createStoreProduct).not.toHaveBeenCalled();
  });
});

describe('connectPushIn', () => {
  it('upserts a push_in connection and returns it', async () => {
    connectionFindOne.mockResolvedValue(null);
    connectionFindOneAndUpdate.mockResolvedValue(pushInConnection());

    const conn = await connectPushIn(STORE_ID, 'woocommerce', { shopDomain: 'shop.example.com' });

    expect(conn.mode).toBe('push_in');
    const [filter, update, options] = connectionFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ storeId: STORE_ID, provider: 'woocommerce' });
    expect(update.$set).toMatchObject({
      mode: 'push_in',
      status: 'connected',
      shopDomain: 'shop.example.com',
    });
    expect(options).toMatchObject({ upsert: true, new: true, setDefaultsOnInsert: true });
  });

  it('refuses to hijack an existing connection in a different mode (conflict)', async () => {
    connectionFindOne.mockResolvedValue(pushInConnection({ mode: 'pull' }));

    await expect(connectPushIn(STORE_ID, 'woocommerce', {})).rejects.toThrow(/different mode/i);
    expect(connectionFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('is idempotent when a push_in connection already exists', async () => {
    connectionFindOne.mockResolvedValue(pushInConnection());
    connectionFindOneAndUpdate.mockResolvedValue(pushInConnection());

    await expect(connectPushIn(STORE_ID, 'woocommerce', {})).resolves.toMatchObject({
      mode: 'push_in',
    });
  });
});

describe('ingestInventory', () => {
  const inventoryBody = (
    items: IngestInventoryInput['items'],
  ): IngestInventoryInput => ({ items });

  it('sets stock on a single-variant listing at the default location', async () => {
    connectionFindOne.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-1'));
    findVariantsByListing.mockResolvedValue([{ id: 'var-1', listingId: 'listing-1' }]);

    const result = await ingestInventory(
      STORE_ID,
      CONNECTION_ID,
      inventoryBody([{ externalId: 'woo-1', available: 7 }]),
    );

    expect(setAvailable).toHaveBeenCalledWith('var-1', 'listing-1', 'loc-1', 7);
    expect(result.results[0]).toEqual({ externalId: 'woo-1', action: 'updated', variantId: 'var-1' });
  });

  it('maps a multi-variant listing by SKU', async () => {
    connectionFindOne.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-1'));
    findVariantByListingAndSku.mockResolvedValue({ id: 'var-2', listingId: 'listing-1' });

    await ingestInventory(
      STORE_ID,
      CONNECTION_ID,
      inventoryBody([{ externalId: 'woo-1', sku: 'SKU-2', available: 3 }]),
    );

    expect(findVariantByListingAndSku).toHaveBeenCalledWith('listing-1', 'SKU-2');
    expect(setAvailable).toHaveBeenCalledWith('var-2', 'listing-1', 'loc-1', 3);
    expect(findVariantsByListing).not.toHaveBeenCalled();
  });

  it('skips an item whose SKU matches no variant of the mapped listing', async () => {
    connectionFindOne.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-1'));
    findVariantByListingAndSku.mockResolvedValue(null);

    const result = await ingestInventory(
      STORE_ID,
      CONNECTION_ID,
      inventoryBody([{ externalId: 'woo-1', sku: 'NOPE', available: 3 }]),
    );

    expect(setAvailable).not.toHaveBeenCalled();
    expect(result.results[0]).toEqual({ externalId: 'woo-1', action: 'skipped' });
  });

  it('skips an item that maps to no listing', async () => {
    connectionFindOne.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(null);

    const result = await ingestInventory(
      STORE_ID,
      CONNECTION_ID,
      inventoryBody([{ externalId: 'missing', available: 1 }]),
    );

    expect(setAvailable).not.toHaveBeenCalled();
    expect(result.results[0]).toEqual({ externalId: 'missing', action: 'skipped' });
  });

  it('skips a multi-variant listing when no SKU disambiguates it', async () => {
    connectionFindOne.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-1'));
    findVariantsByListing.mockResolvedValue([
      { id: 'a', listingId: 'listing-1' },
      { id: 'b', listingId: 'listing-1' },
    ]);

    const result = await ingestInventory(
      STORE_ID,
      CONNECTION_ID,
      inventoryBody([{ externalId: 'woo-1', available: 2 }]),
    );

    expect(setAvailable).not.toHaveBeenCalled();
    expect(result.results[0].action).toBe('skipped');
  });
});
