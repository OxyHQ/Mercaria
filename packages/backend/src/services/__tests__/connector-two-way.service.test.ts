/**
 * Unit tests for the two-way connector sync engine (Fase 3):
 *  - `pushListingToChannels` LOOP PREVENTION — a listing is pushed to every
 *    push/bidirectional connection EXCEPT the one it was pulled from, and the
 *    external mapping is recorded for that connection.
 *  - `syncOrders` / order-webhook UPSERT — an external order is created once with
 *    `source` provenance + `DualMoney`, and a re-sync of the same external id
 *    updates in place (idempotent, never duplicated).
 *
 * No DB / no network. Orders are still Mongoose (`Order`, `Counter`), as are
 * `Connection`/`SyncRun`; the CATALOGUE moved to Postgres, so the listing, its
 * variants and their child rows are mocked at the REPOSITORY boundary.
 *
 * Two shapes changed under `pushListingToChannels` and the assertions follow:
 *  - The push mirror is the `listing_external_refs` TABLE, not an `externalRefs`
 *    array on the listing — so the recorded mapping is an `upsertExternalRef`
 *    call, not a `$push`, and the re-push target is read back with
 *    `findExternalRefByListingAndConnection`.
 *  - The listing's images, options and each variant's option values are separate
 *    tables, gathered once via `findListingChildren` / `findVariantOptionValues`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SyncRunCounts } from '@mercaria/shared-types';
import type { NormalizedOrder } from '../../connectors/types.js';

vi.mock('../../socket.js', () => ({ getIO: () => null }));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const findPushConnections = vi.fn();
const findConnection = vi.fn();
const findConnectionById = vi.fn();
const markConnectionSynced = vi.fn();
const markConnectionError = vi.fn();
const touchConnectionLastSync = vi.fn();
vi.mock('../../db/connectors/connectionRepository.js', () => ({
  findPushConnections: (...a: unknown[]) => findPushConnections(...a),
  findConnection: (...a: unknown[]) => findConnection(...a),
  findConnectionById: (...a: unknown[]) => findConnectionById(...a),
  markConnectionSynced: (...a: unknown[]) => markConnectionSynced(...a),
  markConnectionError: (...a: unknown[]) => markConnectionError(...a),
  touchConnectionLastSync: (...a: unknown[]) => touchConnectionLastSync(...a),
  findConnectionCredentials: vi.fn().mockResolvedValue({ ciphertext: 'x', iv: 'y', tag: 'z' }),
  findConnectionByProvider: vi.fn(),
  findConnectionsByStore: vi.fn(),
  findPullConnectionsToReconcile: vi.fn(),
  disconnectConnection: vi.fn(),
  setConnectionWebhooks: vi.fn(),
  updateSyncSettings: vi.fn(),
  upsertConnection: vi.fn(),
}));

const insertSyncRun = vi.fn();
const finishSyncRun = vi.fn();
vi.mock('../../db/connectors/syncRunRepository.js', () => ({
  insertSyncRun: (...a: unknown[]) => insertSyncRun(...a),
  finishSyncRun: (...a: unknown[]) => finishSyncRun(...a),
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

const findExternalRefByListingAndConnection = vi.fn();
const listingPushedToConnection = vi.fn();
const upsertExternalRef = vi.fn();
vi.mock('../../db/catalog/listingExternalRefRepository.js', () => ({
  findExternalRefByListingAndConnection: (...a: unknown[]) =>
    findExternalRefByListingAndConnection(...a),
  listingPushedToConnection: (...a: unknown[]) => listingPushedToConnection(...a),
  upsertExternalRef: (...a: unknown[]) => upsertExternalRef(...a),
}));

vi.mock('../../db/catalog/categoryRepository.js', () => ({ categorySlugExists: vi.fn() }));
vi.mock('../../db/merchandising/collectionRepository.js', () => ({
  setListingAutomatedMemberships: vi.fn(),
}));
vi.mock('../../db/stores/locationRepository.js', () => ({ findLocation: vi.fn() }));

const findOrderBySourceExternalId = vi.fn();
const insertOrder = vi.fn();
const updateOrderFromSource = vi.fn();
const nextOrderNumber = vi.fn();
vi.mock('../../db/orders/orderRepository.js', () => ({
  findOrderBySourceExternalId: (...a: unknown[]) => findOrderBySourceExternalId(...a),
  insertOrder: (...a: unknown[]) => insertOrder(...a),
  updateOrderFromSource: (...a: unknown[]) => updateOrderFromSource(...a),
  findOrderById: vi.fn(),
  nextOrderNumber: (...a: unknown[]) => nextOrderNumber(...a),
}));


vi.mock('../catalog-write.service.js', () => ({
  createStoreProduct: vi.fn(),
  updateListing: vi.fn(),
  updateVariant: vi.fn(),
  resolveDefaultLocationId: vi.fn(),
}));
vi.mock('../inventory.service.js', () => ({ setAvailable: vi.fn() }));

const decryptSecret = vi.fn();
vi.mock('../../lib/connector-crypto.js', () => ({
  encryptSecret: vi.fn(),
  decryptSecret: (...a: unknown[]) => decryptSecret(...a),
}));

const getConnectorProvider = vi.fn();
vi.mock('../../connectors/registry.js', () => ({
  getConnectorProvider: (...a: unknown[]) => getConnectorProvider(...a),
}));

import { pushListingToChannels, syncOrders, processConnectorWebhook } from '../connector-sync.service.js';

const STORE_ID = 'store-1';

/**
 * The rows the two run statements hand back.
 *
 * A run is opened and then closed now, rather than being a document the service
 * mutates and saves once — so the tallies the service computed are read off the
 * row the CLOSE persisted, in its four flat columns.
 */
function openedRun(connectionId: string, kind: string) {
  return {
    id: 'run-1',
    connectionId,
    kind,
    status: 'running',
    countsCreated: 0,
    countsUpdated: 0,
    countsSkipped: 0,
    countsFailed: 0,
    startedAt: new Date(),
    finishedAt: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function finishedRun(
  runId: string,
  outcome: { status: string; counts: SyncRunCounts; error?: string },
) {
  return {
    ...openedRun('conn', 'order_sync'),
    id: runId,
    status: outcome.status,
    countsCreated: outcome.counts.created,
    countsUpdated: outcome.counts.updated,
    countsSkipped: outcome.counts.skipped,
    countsFailed: outcome.counts.failed,
    finishedAt: new Date(),
    error: outcome.error ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertSyncRun.mockImplementation((connectionId: string, kind: string) =>
    Promise.resolve(openedRun(connectionId, kind)),
  );
  finishSyncRun.mockImplementation(
    (runId: string, outcome: { status: string; counts: SyncRunCounts; error?: string }) =>
      Promise.resolve(finishedRun(runId, outcome)),
  );
  markConnectionSynced.mockResolvedValue(undefined);
  markConnectionError.mockResolvedValue(undefined);
  touchConnectionLastSync.mockResolvedValue(undefined);
  updateListingColumns.mockResolvedValue(null);
  updateOrderFromSource.mockResolvedValue(undefined);
  insertOrder.mockResolvedValue({ id: 'order-created' });
  listingPushedToConnection.mockResolvedValue(false);
  findExternalRefByListingAndConnection.mockResolvedValue(null);
  upsertExternalRef.mockResolvedValue(undefined);
  findListingChildren.mockResolvedValue({
    images: new Map(),
    options: new Map(),
    collectionIds: new Map(),
  });
  findVariantOptionValues.mockResolvedValue(new Map());
  decryptSecret.mockReturnValue(JSON.stringify({ accessToken: 'shpat_test' }));
  nextOrderNumber.mockResolvedValue('MRC-000042');
});

// --- pushListingToChannels — loop prevention --------------------------------

/**
 * A pushable store connection (products bidirectional) with credentials.
 *
 * `hasCredentials` rather than the envelope: "is this connection authorized" is
 * the only question the push loop asks before it decides to push, and it is
 * answered without reading a secret. The envelope itself arrives through
 * `findConnectionCredentials`, inside the push.
 */
function pushConnection(id: string) {
  return {
    id,
    storeId: STORE_ID,
    provider: 'shopify' as const,
    status: 'connected' as const,
    hasCredentials: true,
    shopDomain: 'acme.myshopify.com',
    shopCurrency: 'USD',
    syncSettingsProducts: 'bidirectional' as const,
  };
}

/**
 * The `listings` row a push reads — FLAT, with `source` provenance as four
 * columns and no embedded images/options/externalRefs (all separate tables now).
 */
function pushableListingRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'listing-1',
    ownerType: 'store',
    storeId: STORE_ID,
    title: 'Tee',
    description: '',
    status: 'active',
    handle: null,
    vendor: null,
    productType: null,
    seoTitle: null,
    seoDescription: null,
    sourceConnectionId: 'origin',
    sourceProvider: 'shopify',
    sourceExternalId: 'shp-origin',
    sourceExternalUpdatedAt: null,
    ...overrides,
  };
}

/** A `product_variants` row as `toPushVariant` reads it (flat money columns). */
function pushableVariantRow(): unknown {
  return {
    id: 'variant-1',
    listingId: 'listing-1',
    title: 'Default Title',
    sku: null,
    barcode: null,
    priceAmount: 1999,
    priceCurrency: 'USD',
    compareAtPriceAmount: null,
    compareAtPriceCurrency: null,
    inventoryTracked: true,
    inventoryAvailable: 3,
  };
}

describe('pushListingToChannels — loop prevention', () => {
  it('pushes to non-origin connections and skips the connection it was pulled from', async () => {
    // Listing was pulled FROM `origin`; must NOT be pushed back there, but SHOULD
    // be pushed to `other`.
    findListingById.mockResolvedValue(pushableListingRow());
    findPushConnections.mockResolvedValue([pushConnection('origin'), pushConnection('other')]);
    findVariantsByListing.mockResolvedValue([pushableVariantRow()]);

    const pushProduct = vi.fn().mockResolvedValue({ externalId: 'shp-other' });
    getConnectorProvider.mockReturnValue({ pushProduct });

    await pushListingToChannels(STORE_ID, 'listing-1');

    // Pushed exactly once — to `other`, never to the `origin` connection.
    expect(pushProduct).toHaveBeenCalledTimes(1);
    // `SyncRun.create({connectionId, kind})` became `insertSyncRun(connectionId, kind)`.
    expect(insertSyncRun.mock.calls).toHaveLength(1);
    expect(insertSyncRun).toHaveBeenCalledWith('other', 'product_push');
    // The native price survives the push unconverted, read from the two columns.
    expect(pushProduct.mock.calls[0][1].variants[0].price).toEqual({ amount: 1999, currency: 'USD' });

    // The external mapping is recorded. The old assertion looked for a
    // `$push: { externalRefs: … }` (preceded by a `$pull` for the same
    // connection); that pair became ONE `upsertExternalRef`, which replaces the
    // pair's previous mapping itself.
    expect(findExternalRefByListingAndConnection).toHaveBeenCalledWith('listing-1', 'other');
    expect(upsertExternalRef).toHaveBeenCalledWith({
      listingId: 'listing-1',
      connectionId: 'other',
      provider: 'shopify',
      externalId: 'shp-other',
    });
  });

  it('re-pushes at the SAME external product when a mapping already exists', async () => {
    // The re-push target used to be found by scanning the embedded `externalRefs`
    // array; it is a row lookup now, and getting it wrong means a duplicate
    // product on the platform rather than an update.
    findListingById.mockResolvedValue(pushableListingRow({ sourceConnectionId: null }));
    findPushConnections.mockResolvedValue([pushConnection('other')]);
    findVariantsByListing.mockResolvedValue([pushableVariantRow()]);
    findExternalRefByListingAndConnection.mockResolvedValue({
      listingId: 'listing-1',
      connectionId: 'other',
      provider: 'shopify',
      externalId: 'shp-existing',
    });
    const pushProduct = vi.fn().mockResolvedValue({ externalId: 'shp-existing' });
    getConnectorProvider.mockReturnValue({ pushProduct });

    await pushListingToChannels(STORE_ID, 'listing-1');

    expect(pushProduct.mock.calls[0][1].externalId).toBe('shp-existing');
  });

  it('is a no-op when the store has no push/bidirectional connections', async () => {
    findListingById.mockResolvedValue(pushableListingRow());
    findPushConnections.mockResolvedValue([]);

    await pushListingToChannels(STORE_ID, 'listing-1');
    expect(insertSyncRun).not.toHaveBeenCalled();
  });
});

// --- order upsert — idempotency + DualMoney ---------------------------------

/** A connected pull connection with order pull enabled. */
function orderPullConnection() {
  return {
    id: 'conn-ord',
    storeId: STORE_ID,
    provider: 'shopify' as const,
    mode: 'pull' as const,
    status: 'connected' as const,
    hasCredentials: true,
    shopDomain: 'acme.myshopify.com',
    shopCurrency: 'USD',
    syncSettingsProducts: 'off' as const,
    syncSettingsInventory: 'off' as const,
    syncSettingsOrders: 'pull' as const,
  };
}

/** A normalized external order with distinct shop/presentment money. */
function normalizedOrder(): NormalizedOrder {
  return {
    externalId: 'shp-1001',
    externalNumber: '#1001',
    externalUpdatedAt: new Date('2026-07-15T11:00:00Z'),
    createdAt: new Date('2026-07-15T10:00:00Z'),
    status: 'paid',
    paymentStatus: 'paid',
    shopCurrency: 'USD',
    presentmentCurrency: 'EUR',
    fxRate: { from: 'USD', to: 'EUR', rate: 0.9, provider: 'shopify', asOf: '2026-07-15T11:00:00Z' },
    lines: [
      {
        title: 'Classic Tee',
        variantTitle: 'M / Black',
        quantity: 2,
        unitPrice: { shop: { amount: 2000, currency: 'USD' }, presentment: { amount: 1800, currency: 'EUR' } },
        lineTotal: { shop: { amount: 4000, currency: 'USD' }, presentment: { amount: 3600, currency: 'EUR' } },
        externalProductId: '111',
        externalVariantId: '999',
      },
    ],
    totals: {
      subtotal: { shop: { amount: 4000, currency: 'USD' }, presentment: { amount: 3600, currency: 'EUR' } },
      discountTotal: { shop: { amount: 500, currency: 'USD' }, presentment: { amount: 450, currency: 'EUR' } },
      tax: { shop: { amount: 400, currency: 'USD' }, presentment: { amount: 360, currency: 'EUR' } },
      shipping: { shop: { amount: 0, currency: 'USD' }, presentment: { amount: 0, currency: 'EUR' } },
      grandTotal: { shop: { amount: 3900, currency: 'USD' }, presentment: { amount: 3510, currency: 'EUR' } },
    },
    customer: { externalId: '7', email: 'buyer@example.com', name: 'Ada Lovelace' },
    shippingAddress: {
      recipientName: 'Ada Lovelace',
      line1: '1 Analytical Way',
      city: 'London',
      postalCode: 'EC1',
      country: 'GB',
    },
  };
}

describe('syncOrders — create + DualMoney', () => {
  it('creates a store order stamped with source, DualMoney totals and external payment', async () => {
    findConnection.mockResolvedValue(orderPullConnection());
    findOrderBySourceExternalId.mockResolvedValue(null);
    getConnectorProvider.mockReturnValue({
      fetchOrders: vi.fn().mockResolvedValue({ orders: [normalizedOrder()] }),
    });

    const run = await syncOrders(STORE_ID, 'conn-ord');

    expect(insertOrder).toHaveBeenCalledTimes(1);
    const [doc] = insertOrder.mock.calls[0];
    expect(doc.orderNumber).toBe('MRC-000042');
    expect(doc.sellerType).toBe('store');
    expect(doc.storeId).toBe(STORE_ID);
    expect(doc.source).toMatchObject({ connectionId: 'conn-ord', provider: 'shopify', externalId: 'shp-1001' });
    // `payment` flattened into two columns; an external order settles off Oxy Pay.
    expect(doc.paymentStatus).toBe('paid');
    expect(doc.paymentProvider).toBe('external');
    // DualMoney preserved on totals + line items.
    expect(doc.totals.grandTotal).toEqual({
      shop: { amount: 3900, currency: 'USD' },
      presentment: { amount: 3510, currency: 'EUR' },
    });
    expect(doc.items[0].unitPrice.presentment).toEqual({ amount: 1800, currency: 'EUR' });
    expect(doc.fxRate).toEqual({
      from: 'USD',
      to: 'EUR',
      rate: 0.9,
      provider: 'shopify',
      asOf: '2026-07-15T11:00:00Z',
    });
    // Buyer id is synthetic (no Oxy user for an external order).
    expect(doc.buyerOxyUserId).toContain('ext:shopify:');

    expect(run.status).toBe('completed');
    expect(run.countsCreated).toBe(1);
  });

  it('is idempotent — a re-sync of the same external order updates in place, never duplicates', async () => {
    findConnection.mockResolvedValue(orderPullConnection());
    // The order already exists (a prior sync created it).
    findOrderBySourceExternalId.mockResolvedValue({
      id: 'order-existing',
      status: 'pending_payment',
    });
    getConnectorProvider.mockReturnValue({
      fetchOrders: vi.fn().mockResolvedValue({ orders: [normalizedOrder()] }),
    });

    const run = await syncOrders(STORE_ID, 'conn-ord');

    expect(insertOrder).not.toHaveBeenCalled();
    expect(updateOrderFromSource).toHaveBeenCalledTimes(1);
    const [orderId, patch] = updateOrderFromSource.mock.calls[0];
    expect(orderId).toBe('order-existing');
    expect(patch.status).toBe('paid');
    // status changed pending_payment → paid ⇒ counted as updated.
    expect(run.countsUpdated).toBe(1);
    expect(run.countsCreated).toBe(0);
  });
});

// --- orders webhook path -----------------------------------------------------

describe('processConnectorWebhook — orders topic', () => {
  it('upserts the order for an orders/create webhook (records a webhook run)', async () => {
    findConnectionById.mockResolvedValue(orderPullConnection());
    findOrderBySourceExternalId.mockResolvedValue(null);
    const normalizeOrder = vi.fn().mockReturnValue(normalizedOrder());
    getConnectorProvider.mockReturnValue({ normalizeOrder });

    await processConnectorWebhook({
      connectionId: 'conn-ord',
      topic: 'orders/create',
      payload: { id: 1001 },
    });

    expect(normalizeOrder).toHaveBeenCalledWith({ id: 1001 }, 'USD');
    expect(insertOrder).toHaveBeenCalledTimes(1);
    expect(insertSyncRun).toHaveBeenCalledWith('conn-ord', 'webhook');
  });

  it('ignores an orders webhook when order pull is disabled (no run, no write)', async () => {
    findConnectionById.mockResolvedValue({
      ...orderPullConnection(),
      syncSettingsOrders: 'off' as const,
    });

    await processConnectorWebhook({
      connectionId: 'conn-ord',
      topic: 'orders/updated',
      payload: { id: 1001 },
    });

    expect(insertSyncRun).not.toHaveBeenCalled();
    expect(insertOrder).not.toHaveBeenCalled();
  });
});
