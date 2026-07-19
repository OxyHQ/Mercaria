/**
 * Unit tests for the Fase 2/3 connector-sync additions:
 *  - `collectionMapping` applied on re-sync — maps a product's external collection
 *    refs onto Mercaria `collectionIds`, preserving native memberships and RESPECTING
 *    `overriddenFields` (a pinned `collections` field is left untouched).
 *  - `syncInventory` — pulls platform inventory levels and absolute-sets stock on the
 *    mapped variants at the connection's target location (idempotent, targeted).
 *  - `pushOrderFulfillment` — pushes a fulfillment only for a `bidirectional` order
 *    connection, and is loop-safe (skips a non-bidirectional / source-less order).
 *
 * No DB / no network: every model + the provider registry + crypto are mocked. The
 * price/money math (`applyPriceRules`) runs for real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedProduct } from '../../connectors/types.js';

vi.mock('../../socket.js', () => ({ getIO: () => null }));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const connectionFindOne = vi.fn();
const connectionFindById = vi.fn();
const connectionUpdateOne = vi.fn();
vi.mock('../../models/connection.js', () => ({
  Connection: {
    findOne: (...a: unknown[]) => connectionFindOne(...a),
    findById: (...a: unknown[]) => connectionFindById(...a),
    updateOne: (...a: unknown[]) => connectionUpdateOne(...a),
  },
}));

const syncRunCreate = vi.fn();
vi.mock('../../models/sync-run.js', () => ({
  SyncRun: { create: (...a: unknown[]) => syncRunCreate(...a) },
}));

const listingFind = vi.fn();
const listingFindOne = vi.fn();
const listingFindById = vi.fn();
const listingUpdateOne = vi.fn();
const listingExists = vi.fn();
vi.mock('../../models/listing.js', () => ({
  Listing: {
    find: (...a: unknown[]) => listingFind(...a),
    findOne: (...a: unknown[]) => listingFindOne(...a),
    findById: (...a: unknown[]) => listingFindById(...a),
    updateOne: (...a: unknown[]) => listingUpdateOne(...a),
    exists: (...a: unknown[]) => listingExists(...a),
  },
}));

const variantFind = vi.fn();
const variantFindOne = vi.fn();
vi.mock('../../models/product-variant.js', () => ({
  ProductVariant: {
    find: (...a: unknown[]) => variantFind(...a),
    findOne: (...a: unknown[]) => variantFindOne(...a),
  },
}));

const orderFindById = vi.fn();
vi.mock('../../models/order.js', () => ({
  Order: { findById: (...a: unknown[]) => orderFindById(...a) },
}));

const locationExists = vi.fn();
vi.mock('../../models/location.js', () => ({
  Location: { exists: (...a: unknown[]) => locationExists(...a) },
}));

const categoryExists = vi.fn();
vi.mock('../../models/category.js', () => ({
  Category: { exists: (...a: unknown[]) => categoryExists(...a) },
}));

const createStoreProduct = vi.fn();
const updateListing = vi.fn();
const updateVariant = vi.fn();
const resolveDefaultLocationId = vi.fn();
vi.mock('../catalog-write.service.js', () => ({
  createStoreProduct: (...a: unknown[]) => createStoreProduct(...a),
  updateListing: (...a: unknown[]) => updateListing(...a),
  updateVariant: (...a: unknown[]) => updateVariant(...a),
  resolveDefaultLocationId: (...a: unknown[]) => resolveDefaultLocationId(...a),
}));

const setAvailable = vi.fn();
vi.mock('../inventory.service.js', () => ({
  setAvailable: (...a: unknown[]) => setAvailable(...a),
}));

const decryptSecret = vi.fn();
vi.mock('../../lib/connector-crypto.js', () => ({
  encryptSecret: vi.fn(),
  decryptSecret: (...a: unknown[]) => decryptSecret(...a),
}));

const getConnectorProvider = vi.fn();
vi.mock('../../connectors/registry.js', () => ({
  getConnectorProvider: (...a: unknown[]) => getConnectorProvider(...a),
}));

import {
  runBackfill,
  syncInventory,
  pushOrderFulfillment,
  processConnectorWebhook,
} from '../connector-sync.service.js';

const STORE_ID = 'store-1';

/** A fresh mutable SyncRun doc the service assigns counts/status and saves. */
function mockRun() {
  return {
    counts: { created: 0, updated: 0, skipped: 0, failed: 0 },
    status: 'running' as string,
    error: undefined as string | undefined,
    finishedAt: undefined as Date | undefined,
    save: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  syncRunCreate.mockImplementation(() => Promise.resolve(mockRun()));
  connectionUpdateOne.mockResolvedValue({});
  listingUpdateOne.mockResolvedValue({});
  listingExists.mockResolvedValue(null);
  decryptSecret.mockReturnValue(JSON.stringify({ accessToken: 'shpat_test' }));
  resolveDefaultLocationId.mockResolvedValue('loc-default');
  // Re-price query (update path): no existing variants by default → no re-pricing.
  variantFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
  // Delete-reconciliation query (fully-completed backfill): no sourced listings.
  listingFind.mockReturnValue({ lean: () => Promise.resolve([]) });
});

// --- collectionMapping on re-sync -------------------------------------------

/** A pull connection with a collection mapping (external ref → Mercaria collection). */
function collectionMappingConnection() {
  return {
    _id: 'conn-col',
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
      conflictPolicy: 'respect_overrides' as const,
      collectionMapping: new Map([
        ['ext-col-1', 'merc-col-A'],
        ['ext-col-2', 'merc-col-B'],
      ]),
    },
  };
}

/** A normalized product that belongs to one external collection. */
function collectionProduct(): NormalizedProduct {
  return {
    externalId: 'shopify-1',
    externalUpdatedAt: new Date('2026-07-12T00:00:00Z'),
    title: 'Imported Title',
    description: 'Imported description',
    options: [],
    imageUrls: ['https://cdn.shopify.com/img.jpg'],
    collectionRefs: ['ext-col-1'],
    variants: [{ optionValues: [], price: { amount: 1999, currency: 'USD' }, inventory: { tracked: true, available: 3 } }],
  };
}

describe('collectionMapping on re-sync', () => {
  beforeEach(() => {
    process.env.CONNECTOR_DEFAULT_CATEGORY_SLUG = 'home';
    categoryExists.mockResolvedValue({ _id: 'cat-1' });
    getConnectorProvider.mockReturnValue({
      fetchProducts: vi.fn().mockResolvedValue({ products: [collectionProduct()] }),
    });
  });

  it('sets mapped connector collections, preserves native ones, drops stale connector ones', async () => {
    connectionFindOne.mockResolvedValue(collectionMappingConnection());
    // Existing listing (update path), no pinned fields.
    listingFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: 'listing-1', overriddenFields: [] }),
    });
    // Current memberships: a NATIVE collection + a STALE connector collection (merc-col-B).
    listingFindById.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ collectionIds: ['native-1', 'merc-col-B'] }),
      }),
    });

    await runBackfill(STORE_ID, 'conn-col');

    // The connector-managed subset (codomain = {merc-col-A, merc-col-B}) is set to the
    // currently-desired {merc-col-A}; native-1 is preserved; stale merc-col-B removed.
    const colCall = listingUpdateOne.mock.calls.find(([, u]) => u?.$set?.collectionIds);
    expect(colCall?.[1].$set.collectionIds).toEqual(['native-1', 'merc-col-A']);
  });

  it('leaves collectionIds untouched when `collections` is pinned in overriddenFields', async () => {
    connectionFindOne.mockResolvedValue(collectionMappingConnection());
    listingFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: 'listing-1', overriddenFields: ['collections'] }),
    });

    await runBackfill(STORE_ID, 'conn-col');

    // Pinned → no collectionIds write, and no membership read.
    expect(listingFindById).not.toHaveBeenCalled();
    const colCall = listingUpdateOne.mock.calls.find(([, u]) => u?.$set?.collectionIds);
    expect(colCall).toBeUndefined();
  });
});

// --- inventory pull ---------------------------------------------------------

/** A pull connection with inventory pull enabled and an explicit target location. */
function inventoryConnection(targetLocationId?: string) {
  return {
    _id: 'conn-inv',
    storeId: STORE_ID,
    provider: 'shopify' as const,
    mode: 'pull' as const,
    status: 'connected' as const,
    credentials: { ciphertext: 'x', iv: 'y', tag: 'z' },
    shopDomain: 'acme.myshopify.com',
    shopCurrency: 'USD',
    syncSettings: {
      products: 'off' as const,
      inventory: 'pull' as const,
      orders: 'off' as const,
      autoPublish: false,
      conflictPolicy: 'respect_overrides' as const,
      ...(targetLocationId ? { targetLocationId } : {}),
    },
  };
}

/** The connector-sourced variants of the inventory connection. */
function sourcedVariants() {
  return [
    { _id: 'v1', listingId: 'l1', source: { externalInventoryItemId: '111' } },
    { _id: 'v2', listingId: 'l1', source: { externalInventoryItemId: '222' } },
  ];
}

describe('syncInventory — pull to target location', () => {
  beforeEach(() => {
    variantFind.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(sourcedVariants()) }),
    });
    setAvailable.mockResolvedValue(undefined);
  });

  it('absolute-sets mapped stock at the configured target location; skips unmapped', async () => {
    connectionFindOne.mockResolvedValue(inventoryConnection('loc-target'));
    locationExists.mockResolvedValue({ _id: 'loc-target' }); // target is a valid store location
    getConnectorProvider.mockReturnValue({
      fetchInventory: vi.fn().mockResolvedValue([
        { externalInventoryItemId: '111', available: 7 },
        { externalInventoryItemId: '999', available: 3 }, // no mapped variant → skipped
      ]),
    });

    const run = await syncInventory(STORE_ID, 'conn-inv');

    // v1 (item 111) set to 7 at loc-target; item 999 has no variant → skipped.
    expect(setAvailable).toHaveBeenCalledTimes(1);
    expect(setAvailable).toHaveBeenCalledWith('v1', 'l1', 'loc-target', 7);
    expect(run.counts).toMatchObject({ updated: 1, skipped: 1 });
    expect(run.status).toBe('completed');
  });

  it('is idempotent — a second run makes the identical absolute set', async () => {
    connectionFindOne.mockResolvedValue(inventoryConnection('loc-target'));
    locationExists.mockResolvedValue({ _id: 'loc-target' });
    getConnectorProvider.mockReturnValue({
      fetchInventory: vi.fn().mockResolvedValue([{ externalInventoryItemId: '111', available: 7 }]),
    });

    await syncInventory(STORE_ID, 'conn-inv');
    await syncInventory(STORE_ID, 'conn-inv');

    expect(setAvailable).toHaveBeenCalledTimes(2);
    expect(setAvailable).toHaveBeenNthCalledWith(1, 'v1', 'l1', 'loc-target', 7);
    expect(setAvailable).toHaveBeenNthCalledWith(2, 'v1', 'l1', 'loc-target', 7);
  });

  it('falls back to the store default when the target location is invalid', async () => {
    connectionFindOne.mockResolvedValue(inventoryConnection('loc-bogus'));
    locationExists.mockResolvedValue(null); // target not a valid location → default
    getConnectorProvider.mockReturnValue({
      fetchInventory: vi.fn().mockResolvedValue([{ externalInventoryItemId: '111', available: 4 }]),
    });

    await syncInventory(STORE_ID, 'conn-inv');

    expect(setAvailable).toHaveBeenCalledWith('v1', 'l1', 'loc-default', 4);
  });

  it('rejects when inventory pull is disabled for the connection', async () => {
    const base = inventoryConnection();
    connectionFindOne.mockResolvedValue({
      ...base,
      syncSettings: { ...base.syncSettings, inventory: 'off' },
    });

    await expect(syncInventory(STORE_ID, 'conn-inv')).rejects.toThrow(/not enabled/);
    expect(syncRunCreate).not.toHaveBeenCalled();
  });
});

// --- inventory_levels/update webhook ----------------------------------------

describe('processConnectorWebhook — inventory_levels/update', () => {
  it('re-fetches the authoritative total and absolute-sets the mapped variant', async () => {
    connectionFindById.mockResolvedValue(inventoryConnection());
    variantFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'v1', listingId: 'l1' }),
      }),
    });
    const fetchInventory = vi.fn().mockResolvedValue([{ externalInventoryItemId: '111', available: 9 }]);
    getConnectorProvider.mockReturnValue({ fetchInventory });

    await processConnectorWebhook({
      connectionId: 'conn-inv',
      topic: 'inventory_levels/update',
      payload: { inventory_item_id: 111 },
    });

    // The webhook reports one location; the shop-wide total is re-fetched, then set.
    expect(fetchInventory).toHaveBeenCalledWith(
      { accessToken: 'shpat_test', shopDomain: 'acme.myshopify.com' },
      { inventoryItemIds: ['111'] },
    );
    expect(setAvailable).toHaveBeenCalledWith('v1', 'l1', 'loc-default', 9);
  });

  it('ignores the webhook when inventory pull is disabled (no run, no write)', async () => {
    const base = inventoryConnection();
    connectionFindById.mockResolvedValue({
      ...base,
      syncSettings: { ...base.syncSettings, inventory: 'off' },
    });

    await processConnectorWebhook({
      connectionId: 'conn-inv',
      topic: 'inventory_levels/update',
      payload: { inventory_item_id: 111 },
    });

    expect(syncRunCreate).not.toHaveBeenCalled();
    expect(setAvailable).not.toHaveBeenCalled();
  });
});

// --- fulfillment push (loop-safety / gating) --------------------------------

/** A connector order that Mercaria has fulfilled, with a tracking number. */
function fulfilledOrder() {
  return {
    _id: 'order-1',
    source: { connectionId: 'conn-ful', provider: 'shopify', externalId: 'shp-1001' },
    shipping: { trackingNumber: 'TRK123' },
  };
}

/** A connection with the given order direction. */
function fulfillmentConnection(orders: 'pull' | 'bidirectional') {
  return {
    _id: 'conn-ful',
    storeId: STORE_ID,
    provider: 'shopify' as const,
    status: 'connected' as const,
    credentials: { ciphertext: 'x', iv: 'y', tag: 'z' },
    shopDomain: 'acme.myshopify.com',
    syncSettings: { orders },
  };
}

describe('pushOrderFulfillment — bidirectional gate + loop-safety', () => {
  it('pushes the fulfillment (with tracking) for a bidirectional order connection', async () => {
    orderFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(fulfilledOrder()) });
    connectionFindById.mockResolvedValue(fulfillmentConnection('bidirectional'));
    const pushFulfillment = vi.fn().mockResolvedValue(undefined);
    getConnectorProvider.mockReturnValue({ pushFulfillment });

    await pushOrderFulfillment('order-1');

    expect(pushFulfillment).toHaveBeenCalledTimes(1);
    expect(pushFulfillment).toHaveBeenCalledWith(
      { accessToken: 'shpat_test', shopDomain: 'acme.myshopify.com' },
      { externalOrderId: 'shp-1001', trackingNumber: 'TRK123' },
    );
    const runKind = syncRunCreate.mock.calls[0][0];
    expect(runKind).toMatchObject({ connectionId: 'conn-ful', kind: 'fulfillment_push' });
  });

  it('does NOT push when the order connection is only pull (loop-safe)', async () => {
    orderFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(fulfilledOrder()) });
    connectionFindById.mockResolvedValue(fulfillmentConnection('pull'));
    const pushFulfillment = vi.fn();
    getConnectorProvider.mockReturnValue({ pushFulfillment });

    await pushOrderFulfillment('order-1');

    expect(pushFulfillment).not.toHaveBeenCalled();
    expect(syncRunCreate).not.toHaveBeenCalled();
  });

  it('is a no-op for a non-connector order (no source)', async () => {
    orderFindById.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'order-2', shipping: { trackingNumber: null } }),
    });

    await pushOrderFulfillment('order-2');

    expect(connectionFindById).not.toHaveBeenCalled();
    expect(syncRunCreate).not.toHaveBeenCalled();
  });

  it('does NOT push for a disconnected connection', async () => {
    orderFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(fulfilledOrder()) });
    connectionFindById.mockResolvedValue({ ...fulfillmentConnection('bidirectional'), status: 'disconnected' });
    const pushFulfillment = vi.fn();
    getConnectorProvider.mockReturnValue({ pushFulfillment });

    await pushOrderFulfillment('order-1');

    expect(pushFulfillment).not.toHaveBeenCalled();
    expect(syncRunCreate).not.toHaveBeenCalled();
  });
});
