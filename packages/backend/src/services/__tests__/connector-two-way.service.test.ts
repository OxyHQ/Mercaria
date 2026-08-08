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
import type { NormalizedOrder } from '../../connectors/types.js';

vi.mock('../../socket.js', () => ({ getIO: () => null }));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const connectionFind = vi.fn();
const connectionFindOne = vi.fn();
const connectionFindById = vi.fn();
const connectionUpdateOne = vi.fn();
vi.mock('../../models/connection.js', () => ({
  Connection: {
    find: (...a: unknown[]) => connectionFind(...a),
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

const orderFindOne = vi.fn();
const orderCreate = vi.fn();
const orderUpdateOne = vi.fn();
vi.mock('../../models/order.js', () => ({
  Order: {
    findOne: (...a: unknown[]) => orderFindOne(...a),
    create: (...a: unknown[]) => orderCreate(...a),
    updateOne: (...a: unknown[]) => orderUpdateOne(...a),
  },
}));

const nextOrderNumber = vi.fn();
vi.mock('../../models/counter.js', () => ({
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
  orderUpdateOne.mockResolvedValue({});
  orderCreate.mockResolvedValue({});
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

/** A pushable store connection (products bidirectional) with credentials. */
function pushConnection(id: string) {
  return {
    _id: id,
    storeId: STORE_ID,
    provider: 'shopify' as const,
    status: 'connected' as const,
    credentials: { ciphertext: 'x', iv: 'y', tag: 'z' },
    shopDomain: 'acme.myshopify.com',
    shopCurrency: 'USD',
    syncSettings: { products: 'bidirectional' as const },
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
    connectionFind.mockResolvedValue([pushConnection('origin'), pushConnection('other')]);
    findVariantsByListing.mockResolvedValue([pushableVariantRow()]);

    const pushProduct = vi.fn().mockResolvedValue({ externalId: 'shp-other' });
    getConnectorProvider.mockReturnValue({ pushProduct });

    await pushListingToChannels(STORE_ID, 'listing-1');

    // Pushed exactly once — to `other`, never to the `origin` connection.
    expect(pushProduct).toHaveBeenCalledTimes(1);
    const runKinds = syncRunCreate.mock.calls.map(([arg]) => arg);
    expect(runKinds).toHaveLength(1);
    expect(runKinds[0]).toMatchObject({ connectionId: 'other', kind: 'product_push' });
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
    connectionFind.mockResolvedValue([pushConnection('other')]);
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
    connectionFind.mockResolvedValue([]);

    await pushListingToChannels(STORE_ID, 'listing-1');
    expect(syncRunCreate).not.toHaveBeenCalled();
  });
});

// --- order upsert — idempotency + DualMoney ---------------------------------

/** A connected pull connection with order pull enabled. */
function orderPullConnection() {
  return {
    _id: 'conn-ord',
    storeId: STORE_ID,
    provider: 'shopify' as const,
    mode: 'pull' as const,
    status: 'connected' as const,
    credentials: { ciphertext: 'x', iv: 'y', tag: 'z' },
    shopDomain: 'acme.myshopify.com',
    shopCurrency: 'USD',
    syncSettings: { products: 'off' as const, inventory: 'off' as const, orders: 'pull' as const },
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
    fxRate: { from: 'USD', to: 'EUR', rate: 0.9, asOf: '2026-07-15T11:00:00Z' },
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
    connectionFindOne.mockResolvedValue(orderPullConnection());
    orderFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
    getConnectorProvider.mockReturnValue({
      fetchOrders: vi.fn().mockResolvedValue({ orders: [normalizedOrder()] }),
    });

    const run = await syncOrders(STORE_ID, 'conn-ord');

    expect(orderCreate).toHaveBeenCalledTimes(1);
    const [doc] = orderCreate.mock.calls[0];
    expect(doc.orderNumber).toBe('MRC-000042');
    expect(doc.sellerType).toBe('store');
    expect(doc.storeId).toBe(STORE_ID);
    expect(doc.source).toMatchObject({ connectionId: 'conn-ord', provider: 'shopify', externalId: 'shp-1001' });
    expect(doc.payment).toMatchObject({ status: 'paid', provider: 'external' });
    // DualMoney preserved on totals + line items.
    expect(doc.totals.grandTotal).toEqual({
      shop: { amount: 3900, currency: 'USD' },
      presentment: { amount: 3510, currency: 'EUR' },
    });
    expect(doc.items[0].unitPrice.presentment).toEqual({ amount: 1800, currency: 'EUR' });
    expect(doc.fxRate).toEqual({ from: 'USD', to: 'EUR', rate: 0.9, asOf: '2026-07-15T11:00:00Z' });
    // Buyer id is synthetic (no Oxy user for an external order).
    expect(doc.buyerOxyUserId).toContain('ext:shopify:');

    expect(run.status).toBe('completed');
    expect(run.counts).toMatchObject({ created: 1 });
  });

  it('is idempotent — a re-sync of the same external order updates in place, never duplicates', async () => {
    connectionFindOne.mockResolvedValue(orderPullConnection());
    // The order already exists (a prior sync created it).
    orderFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: 'order-existing', status: 'pending_payment' }),
    });
    getConnectorProvider.mockReturnValue({
      fetchOrders: vi.fn().mockResolvedValue({ orders: [normalizedOrder()] }),
    });

    const run = await syncOrders(STORE_ID, 'conn-ord');

    expect(orderCreate).not.toHaveBeenCalled();
    expect(orderUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = orderUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'order-existing' });
    expect(update.$set.status).toBe('paid');
    // status changed pending_payment → paid ⇒ counted as updated.
    expect(run.counts).toMatchObject({ updated: 1, created: 0 });
  });
});

// --- orders webhook path -----------------------------------------------------

describe('processConnectorWebhook — orders topic', () => {
  it('upserts the order for an orders/create webhook (records a webhook run)', async () => {
    connectionFindById.mockResolvedValue(orderPullConnection());
    orderFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
    const normalizeOrder = vi.fn().mockReturnValue(normalizedOrder());
    getConnectorProvider.mockReturnValue({ normalizeOrder });

    await processConnectorWebhook({
      connectionId: 'conn-ord',
      topic: 'orders/create',
      payload: { id: 1001 },
    });

    expect(normalizeOrder).toHaveBeenCalledWith({ id: 1001 }, 'USD');
    expect(orderCreate).toHaveBeenCalledTimes(1);
    const runKind = syncRunCreate.mock.calls[0][0];
    expect(runKind).toMatchObject({ kind: 'webhook' });
  });

  it('ignores an orders webhook when order pull is disabled (no run, no write)', async () => {
    connectionFindById.mockResolvedValue({
      ...orderPullConnection(),
      syncSettings: { products: 'off', inventory: 'off', orders: 'off' },
    });

    await processConnectorWebhook({
      connectionId: 'conn-ord',
      topic: 'orders/updated',
      payload: { id: 1001 },
    });

    expect(syncRunCreate).not.toHaveBeenCalled();
    expect(orderCreate).not.toHaveBeenCalled();
  });
});
