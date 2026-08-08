/**
 * Unit tests for the Fase 2/3 connector-sync additions:
 *  - `collectionMapping` applied on re-sync — maps a product's external collection
 *    refs onto Mercaria collection membership, RESPECTING `overriddenFields` (a
 *    pinned `collections` field is left untouched).
 *  - `syncInventory` — pulls platform inventory levels and absolute-sets stock on the
 *    mapped variants at the connection's target location (idempotent, targeted).
 *  - `pushOrderFulfillment` — pushes a fulfillment only for a `bidirectional` order
 *    connection, and is loop-safe (skips a non-bidirectional / source-less order).
 *
 * No DB / no network. `Connection`/`SyncRun`/`Order` are still Mongoose and are
 * mocked as models; the CATALOGUE moved to Postgres, so listings, variants,
 * collection membership and locations are mocked at the REPOSITORY boundary. The
 * provider registry and crypto are mocked; the price/money math
 * (`applyPriceRules`) runs for real.
 *
 * Two shapes changed and the assertions follow:
 *  - Collection membership is a SET DIFF in SQL —
 *    `setListingAutomatedMemberships(listingId, managed, desired)` — not a
 *    read-modify-write of a `collectionIds` array.
 *  - `findLocation` does NOT filter on `isActive` (the Mongo `Location.exists`
 *    folded that into the query), so the service makes the active check itself.
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

const findListingById = vi.fn();
const findListingBySourceExternalId = vi.fn();
const findListingChildren = vi.fn();
const findListingsBySourceConnection = vi.fn();
const setListingStatusIfIn = vi.fn();
const updateListingColumns = vi.fn();
vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingById: (...a: unknown[]) => findListingById(...a),
  findListingBySourceExternalId: (...a: unknown[]) => findListingBySourceExternalId(...a),
  findListingChildren: (...a: unknown[]) => findListingChildren(...a),
  findListingsBySourceConnection: (...a: unknown[]) => findListingsBySourceConnection(...a),
  setListingStatusIfIn: (...a: unknown[]) => setListingStatusIfIn(...a),
  updateListingColumns: (...a: unknown[]) => updateListingColumns(...a),
}));

const findVariantBySourceInventoryItemId = vi.fn();
const findVariantOptionValues = vi.fn();
const findVariantsByListing = vi.fn();
const findVariantsBySourceConnection = vi.fn();
const updateVariantColumns = vi.fn();
vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantBySourceInventoryItemId: (...a: unknown[]) =>
    findVariantBySourceInventoryItemId(...a),
  findVariantOptionValues: (...a: unknown[]) => findVariantOptionValues(...a),
  findVariantsByListing: (...a: unknown[]) => findVariantsByListing(...a),
  findVariantsBySourceConnection: (...a: unknown[]) => findVariantsBySourceConnection(...a),
  updateVariant: (...a: unknown[]) => updateVariantColumns(...a),
}));

const listingPushedToConnection = vi.fn();
vi.mock('../../db/catalog/listingExternalRefRepository.js', () => ({
  findExternalRefByListingAndConnection: vi.fn(),
  listingPushedToConnection: (...a: unknown[]) => listingPushedToConnection(...a),
  upsertExternalRef: vi.fn(),
}));

const categorySlugExists = vi.fn();
vi.mock('../../db/catalog/categoryRepository.js', () => ({
  categorySlugExists: (...a: unknown[]) => categorySlugExists(...a),
}));

const setListingAutomatedMemberships = vi.fn();
vi.mock('../../db/merchandising/collectionRepository.js', () => ({
  setListingAutomatedMemberships: (...a: unknown[]) => setListingAutomatedMemberships(...a),
}));

const findLocation = vi.fn();
vi.mock('../../db/stores/locationRepository.js', () => ({
  findLocation: (...a: unknown[]) => findLocation(...a),
}));

const findOrderById = vi.fn();
vi.mock('../../db/orders/orderRepository.js', () => ({
  findOrderById: (...a: unknown[]) => findOrderById(...a),
  findOrderBySourceExternalId: vi.fn(),
  insertOrder: vi.fn(),
  updateOrderFromSource: vi.fn(),
  nextOrderNumber: vi.fn(),
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
  updateListingColumns.mockResolvedValue(null);
  setListingStatusIfIn.mockResolvedValue(true);
  listingPushedToConnection.mockResolvedValue(false);
  decryptSecret.mockReturnValue(JSON.stringify({ accessToken: 'shpat_test' }));
  resolveDefaultLocationId.mockResolvedValue('loc-default');
  // Re-price reads (update path): no existing variants by default → no re-pricing.
  findVariantsByListing.mockResolvedValue([]);
  findVariantOptionValues.mockResolvedValue(new Map());
  // Delete-reconciliation read (fully-completed backfill): no sourced listings.
  findListingsBySourceConnection.mockResolvedValue([]);
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

/** An existing imported `listings` row with the given local pins. */
function importedListingRow(overriddenFields: string[]): unknown {
  return {
    id: 'listing-1',
    storeId: STORE_ID,
    status: 'active',
    sourceConnectionId: 'conn-col',
    sourceProvider: 'shopify',
    sourceExternalId: 'shopify-1',
    overriddenFields,
  };
}

describe('collectionMapping on re-sync', () => {
  beforeEach(() => {
    process.env.CONNECTOR_DEFAULT_CATEGORY_SLUG = 'home';
    categorySlugExists.mockResolvedValue(true);
    getConnectorProvider.mockReturnValue({
      fetchProducts: vi.fn().mockResolvedValue({ products: [collectionProduct()] }),
    });
  });

  it('sets the mapped connector collections and scopes the diff to the connector-managed set', async () => {
    connectionFindOne.mockResolvedValue(collectionMappingConnection());
    findListingBySourceExternalId.mockResolvedValue(importedListingRow([]));

    await runBackfill(STORE_ID, 'conn-col');

    // The old assertion read the whole rewritten `$set.collectionIds` array
    // (`['native-1', 'merc-col-A']`) off a `Listing.updateOne`, because the merge
    // was a read-modify-write in the service. There is no array and no read any
    // more: the service states the connector-MANAGED scope (the mapping's
    // codomain) and the DESIRED subset, and the insert/delete diff happens in
    // SQL. "Native memberships are preserved" is now a property of that scoped
    // delete rather than of a filter here — it is exercised against a real server
    // by `src/db/__tests__/catalog.realdb.test.ts` ("set-diffs an automated
    // membership and clears a stale manual position"), so it is not re-asserted
    // against a mock that could not tell either way.
    expect(setListingAutomatedMemberships).toHaveBeenCalledTimes(1);
    expect(setListingAutomatedMemberships).toHaveBeenCalledWith(
      'listing-1',
      ['merc-col-A', 'merc-col-B'],
      ['merc-col-A'],
    );
  });

  it('drops the managed memberships when the platform sends no collection refs', async () => {
    // A product with NO refs is not "nothing to do": it means the platform removed
    // it from every mapped collection, so the desired set is empty while the
    // managed scope stays whole.
    connectionFindOne.mockResolvedValue(collectionMappingConnection());
    findListingBySourceExternalId.mockResolvedValue(importedListingRow([]));
    getConnectorProvider.mockReturnValue({
      fetchProducts: vi
        .fn()
        .mockResolvedValue({ products: [{ ...collectionProduct(), collectionRefs: [] }] }),
    });

    await runBackfill(STORE_ID, 'conn-col');

    expect(setListingAutomatedMemberships).toHaveBeenCalledWith(
      'listing-1',
      ['merc-col-A', 'merc-col-B'],
      [],
    );
  });

  it('leaves membership untouched when `collections` is pinned in overriddenFields', async () => {
    connectionFindOne.mockResolvedValue(collectionMappingConnection());
    findListingBySourceExternalId.mockResolvedValue(importedListingRow(['collections']));

    await runBackfill(STORE_ID, 'conn-col');

    expect(setListingAutomatedMemberships).not.toHaveBeenCalled();
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

/** The connector-sourced `product_variants` rows of the inventory connection. */
function sourcedVariants(): unknown[] {
  return [
    { id: 'v1', listingId: 'l1', sourceConnectionId: 'conn-inv', sourceExternalInventoryItemId: '111' },
    { id: 'v2', listingId: 'l1', sourceConnectionId: 'conn-inv', sourceExternalInventoryItemId: '222' },
  ];
}

describe('syncInventory — pull to target location', () => {
  beforeEach(() => {
    findVariantsBySourceConnection.mockResolvedValue(sourcedVariants());
    setAvailable.mockResolvedValue(undefined);
  });

  it('absolute-sets mapped stock at the configured target location; skips unmapped', async () => {
    connectionFindOne.mockResolvedValue(inventoryConnection('loc-target'));
    findLocation.mockResolvedValue({ id: 'loc-target', storeId: STORE_ID, isActive: true });
    getConnectorProvider.mockReturnValue({
      fetchInventory: vi.fn().mockResolvedValue([
        { externalInventoryItemId: '111', available: 7 },
        { externalInventoryItemId: '999', available: 3 }, // no mapped variant → skipped
      ]),
    });

    const run = await syncInventory(STORE_ID, 'conn-inv');

    // The working set is ONE connection-scoped repository read, not a listing scan.
    expect(findVariantsBySourceConnection).toHaveBeenCalledWith('conn-inv');
    // v1 (item 111) set to 7 at loc-target; item 999 has no variant → skipped.
    expect(setAvailable).toHaveBeenCalledTimes(1);
    expect(setAvailable).toHaveBeenCalledWith('v1', 'l1', 'loc-target', 7);
    expect(run.counts).toMatchObject({ updated: 1, skipped: 1 });
    expect(run.status).toBe('completed');
  });

  it('is idempotent — a second run makes the identical absolute set', async () => {
    connectionFindOne.mockResolvedValue(inventoryConnection('loc-target'));
    findLocation.mockResolvedValue({ id: 'loc-target', storeId: STORE_ID, isActive: true });
    getConnectorProvider.mockReturnValue({
      fetchInventory: vi.fn().mockResolvedValue([{ externalInventoryItemId: '111', available: 7 }]),
    });

    await syncInventory(STORE_ID, 'conn-inv');
    await syncInventory(STORE_ID, 'conn-inv');

    expect(setAvailable).toHaveBeenCalledTimes(2);
    expect(setAvailable).toHaveBeenNthCalledWith(1, 'v1', 'l1', 'loc-target', 7);
    expect(setAvailable).toHaveBeenNthCalledWith(2, 'v1', 'l1', 'loc-target', 7);
  });

  it('falls back to the store default when the target location does not exist', async () => {
    connectionFindOne.mockResolvedValue(inventoryConnection('loc-bogus'));
    findLocation.mockResolvedValue(null); // not a location of this store → default
    getConnectorProvider.mockReturnValue({
      fetchInventory: vi.fn().mockResolvedValue([{ externalInventoryItemId: '111', available: 4 }]),
    });

    await syncInventory(STORE_ID, 'conn-inv');

    expect(findLocation).toHaveBeenCalledWith(STORE_ID, 'loc-bogus');
    expect(setAvailable).toHaveBeenCalledWith('v1', 'l1', 'loc-default', 4);
  });

  it('falls back to the store default when the target location is DEACTIVATED', async () => {
    // The Mongo lookup was `Location.exists({ _id, storeId, isActive: true })`, so
    // a deactivated target was indistinguishable from a missing one. `findLocation`
    // scopes to the store but does NOT filter on `isActive`, so the service makes
    // the check — and a row that exists but is inactive is the case that would
    // silently start receiving stock if it ever stopped making it.
    connectionFindOne.mockResolvedValue(inventoryConnection('loc-off'));
    findLocation.mockResolvedValue({ id: 'loc-off', storeId: STORE_ID, isActive: false });
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
    findVariantBySourceInventoryItemId.mockResolvedValue({ id: 'v1', listingId: 'l1' });
    const fetchInventory = vi.fn().mockResolvedValue([{ externalInventoryItemId: '111', available: 9 }]);
    getConnectorProvider.mockReturnValue({ fetchInventory });

    await processConnectorWebhook({
      connectionId: 'conn-inv',
      topic: 'inventory_levels/update',
      payload: { inventory_item_id: 111 },
    });

    // The platform's inventory-item id is NOT the variant id — the mapping is the
    // indexed provenance lookup.
    expect(findVariantBySourceInventoryItemId).toHaveBeenCalledWith('conn-inv', '111');
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
  // Connector provenance is three flat columns now, and "is this a connector
  // order" is `source_external_id is not null` rather than a nested object.
  return {
    id: 'order-1',
    sourceConnectionId: 'conn-ful',
    sourceProvider: 'shopify',
    sourceExternalId: 'shp-1001',
    shippingTrackingNumber: 'TRK123',
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
    findOrderById.mockResolvedValue(fulfilledOrder());
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
    findOrderById.mockResolvedValue(fulfilledOrder());
    connectionFindById.mockResolvedValue(fulfillmentConnection('pull'));
    const pushFulfillment = vi.fn();
    getConnectorProvider.mockReturnValue({ pushFulfillment });

    await pushOrderFulfillment('order-1');

    expect(pushFulfillment).not.toHaveBeenCalled();
    expect(syncRunCreate).not.toHaveBeenCalled();
  });

  it('is a no-op for a non-connector order (no source)', async () => {
    findOrderById.mockResolvedValue({
      id: 'order-2',
      sourceConnectionId: null,
      sourceExternalId: null,
      shippingTrackingNumber: null,
    });

    await pushOrderFulfillment('order-2');

    expect(connectionFindById).not.toHaveBeenCalled();
    expect(syncRunCreate).not.toHaveBeenCalled();
  });

  it('does NOT push for a disconnected connection', async () => {
    findOrderById.mockResolvedValue(fulfilledOrder());
    connectionFindById.mockResolvedValue({ ...fulfillmentConnection('bidirectional'), status: 'disconnected' });
    const pushFulfillment = vi.fn();
    getConnectorProvider.mockReturnValue({ pushFulfillment });

    await pushOrderFulfillment('order-1');

    expect(pushFulfillment).not.toHaveBeenCalled();
    expect(syncRunCreate).not.toHaveBeenCalled();
  });
});
