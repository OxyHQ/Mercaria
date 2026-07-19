/**
 * Unit tests for the two-way connector sync engine (Fase 3):
 *  - `pushListingToChannels` LOOP PREVENTION — a listing is pushed to every
 *    push/bidirectional connection EXCEPT the one it was pulled from, and the
 *    external mapping is recorded on the listing.
 *  - `syncOrders` / order-webhook UPSERT — an external order is created once with
 *    `source` provenance + `DualMoney`, and a re-sync of the same external id
 *    updates in place (idempotent, never duplicated).
 *
 * No DB / no network: every model + the provider registry + crypto are mocked.
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

const listingFindById = vi.fn();
const listingFindOne = vi.fn();
const listingUpdateOne = vi.fn();
const listingExists = vi.fn();
vi.mock('../../models/listing.js', () => ({
  Listing: {
    findById: (...a: unknown[]) => listingFindById(...a),
    findOne: (...a: unknown[]) => listingFindOne(...a),
    updateOne: (...a: unknown[]) => listingUpdateOne(...a),
    exists: (...a: unknown[]) => listingExists(...a),
  },
}));

const variantFind = vi.fn();
vi.mock('../../models/product-variant.js', () => ({
  ProductVariant: { find: (...a: unknown[]) => variantFind(...a) },
}));

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

vi.mock('../../models/category.js', () => ({ Category: { exists: vi.fn() } }));
vi.mock('../catalog-write.service.js', () => ({
  createStoreProduct: vi.fn(),
  updateListing: vi.fn(),
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
  listingUpdateOne.mockResolvedValue({});
  orderUpdateOne.mockResolvedValue({});
  orderCreate.mockResolvedValue({});
  listingExists.mockResolvedValue(null);
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

describe('pushListingToChannels — loop prevention', () => {
  it('pushes to non-origin connections and skips the connection it was pulled from', async () => {
    // Listing was pulled FROM `origin`; must NOT be pushed back there, but SHOULD
    // be pushed to `other`.
    listingFindById.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'listing-1',
        ownerType: 'store',
        storeId: STORE_ID,
        title: 'Tee',
        description: '',
        status: 'active',
        options: [],
        images: [],
        externalRefs: [],
        source: { connectionId: 'origin', provider: 'shopify', externalId: 'shp-origin' },
      }),
    });
    connectionFind.mockResolvedValue([pushConnection('origin'), pushConnection('other')]);
    variantFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          {
            optionValues: [],
            price: { amount: 1999, currency: 'USD' },
            inventory: { tracked: true, available: 3 },
          },
        ]),
      }),
    });

    const pushProduct = vi.fn().mockResolvedValue({ externalId: 'shp-other' });
    getConnectorProvider.mockReturnValue({ pushProduct });

    await pushListingToChannels(STORE_ID, 'listing-1');

    // Pushed exactly once — to `other`, never to the `origin` connection.
    expect(pushProduct).toHaveBeenCalledTimes(1);
    const runKinds = syncRunCreate.mock.calls.map(([arg]) => arg);
    expect(runKinds).toHaveLength(1);
    expect(runKinds[0]).toMatchObject({ connectionId: 'other', kind: 'product_push' });

    // The external mapping is recorded (pull old for this conn, then push new).
    const pushRefCall = listingUpdateOne.mock.calls.find(
      ([, update]) => update?.$push?.externalRefs,
    );
    expect(pushRefCall?.[1].$push.externalRefs).toMatchObject({
      connectionId: 'other',
      provider: 'shopify',
      externalId: 'shp-other',
    });
  });

  it('is a no-op when the store has no push/bidirectional connections', async () => {
    listingFindById.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'listing-1',
        ownerType: 'store',
        storeId: STORE_ID,
        images: [],
        options: [],
        externalRefs: [],
      }),
    });
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
