/**
 * Unit tests for the PROVIDER-AWARE inbound-webhook dispatch, exercised through the
 * WooCommerce path. Proves the dispatcher classifies WooCommerce's dot-delimited
 * topics (`product.deleted`, `order.created`, …) to the SAME provider-neutral kinds
 * as Shopify's slash topics, and routes them to the right — provider-agnostic —
 * handler (product archive, idempotent order upsert), gated per resource direction.
 *
 * The real WooCommerce provider is used (its `normalizeOrder` is a pure map), so the
 * order path is a genuine integration of Woo-JSON → NormalizedOrder → Mercaria order.
 * Models + Socket.IO are mocked so no DB or socket server is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../socket.js', () => ({ getIO: () => null }));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const connectionFindById = vi.fn();
const connectionUpdateOne = vi.fn();
vi.mock('../../models/connection.js', () => ({
  Connection: {
    findById: (...args: unknown[]) => connectionFindById(...args),
    updateOne: (...args: unknown[]) => connectionUpdateOne(...args),
  },
}));

const listingUpdateOne = vi.fn();
vi.mock('../../models/listing.js', () => ({
  Listing: { updateOne: (...args: unknown[]) => listingUpdateOne(...args) },
}));

const syncRunCreate = vi.fn();
vi.mock('../../models/sync-run.js', () => ({
  SyncRun: { create: (...args: unknown[]) => syncRunCreate(...args) },
}));

const orderFindOne = vi.fn();
const orderCreate = vi.fn();
const orderUpdateOne = vi.fn();
vi.mock('../../models/order.js', () => ({
  Order: {
    findOne: (...args: unknown[]) => orderFindOne(...args),
    create: (...args: unknown[]) => orderCreate(...args),
    updateOne: (...args: unknown[]) => orderUpdateOne(...args),
  },
}));

const nextOrderNumber = vi.fn();
vi.mock('../../models/counter.js', () => ({
  nextOrderNumber: (...args: unknown[]) => nextOrderNumber(...args),
}));

import { processConnectorWebhook } from '../connector-sync.service.js';

/** A live WooCommerce pull connection (products + orders pulling). */
function wooConnection(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'conn-woo',
    storeId: 'store-1',
    provider: 'woocommerce',
    status: 'connected',
    shopCurrency: 'EUR',
    syncSettings: {
      products: 'pull',
      orders: 'pull',
      inventory: 'off',
      autoPublish: true,
      conflictPolicy: 'respect_overrides',
    },
    ...overrides,
  };
}

/** A minimal WooCommerce order payload (single-currency EUR, processing → paid). */
function wooOrderPayload() {
  return {
    id: 727,
    number: '727',
    status: 'processing',
    currency: 'EUR',
    date_created_gmt: '2026-07-15T10:00:00',
    date_modified_gmt: '2026-07-15T11:00:00',
    total: '40.00',
    total_tax: '0.00',
    shipping_total: '0.00',
    discount_total: '0.00',
    customer_id: 12,
    billing: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', country: 'GB' },
    shipping: {},
    line_items: [
      { id: 1, name: 'Classic Tee', product_id: 111, variation_id: 999, quantity: 2, subtotal: '40.00', total: '40.00', sku: 'TEE-M', meta_data: [] },
    ],
    refunds: [],
  };
}

let run: { counts: unknown; status: string; save: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  run = { counts: {}, status: 'running', save: vi.fn().mockResolvedValue(undefined) };
  syncRunCreate.mockResolvedValue(run);
  connectionUpdateOne.mockResolvedValue({});
  orderUpdateOne.mockResolvedValue({});
  orderCreate.mockResolvedValue({});
  nextOrderNumber.mockResolvedValue('MRC-000042');
});

describe('provider-aware dispatch — WooCommerce product.deleted', () => {
  it('classifies the dot-topic to product_delete and archives the mapped listing', async () => {
    connectionFindById.mockResolvedValue(wooConnection());
    listingUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    await processConnectorWebhook({
      connectionId: 'conn-woo',
      topic: 'product.deleted',
      payload: { id: 987654321 },
    });

    expect(listingUpdateOne).toHaveBeenCalledWith(
      { storeId: 'store-1', 'source.connectionId': 'conn-woo', 'source.externalId': '987654321' },
      { $set: { status: 'archived' } },
    );
    expect(run.status).toBe('completed');
    expect(run.counts).toEqual({ created: 0, updated: 1, skipped: 0, failed: 0 });
  });

  it('ignores the webhook when product pull is disabled (no run, no write)', async () => {
    connectionFindById.mockResolvedValue(
      wooConnection({
        syncSettings: { products: 'off', orders: 'pull', inventory: 'off', autoPublish: false, conflictPolicy: 'respect_overrides' },
      }),
    );

    await processConnectorWebhook({ connectionId: 'conn-woo', topic: 'product.deleted', payload: { id: 1 } });

    expect(syncRunCreate).not.toHaveBeenCalled();
    expect(listingUpdateOne).not.toHaveBeenCalled();
  });
});

describe('provider-aware dispatch — WooCommerce order.created / order.updated', () => {
  it('routes order.created to an order upsert (real Woo normalizeOrder → Mercaria order)', async () => {
    connectionFindById.mockResolvedValue(wooConnection());
    orderFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });

    await processConnectorWebhook({
      connectionId: 'conn-woo',
      topic: 'order.created',
      payload: wooOrderPayload(),
    });

    expect(orderCreate).toHaveBeenCalledTimes(1);
    const [doc] = orderCreate.mock.calls[0];
    expect(doc.source).toMatchObject({ provider: 'woocommerce', externalId: '727', connectionId: 'conn-woo' });
    expect(doc.payment).toMatchObject({ status: 'paid', provider: 'external' });
    expect(doc.buyerOxyUserId).toContain('ext:woocommerce:');
    // Single-currency: shop === presentment on the grand total.
    expect(doc.totals.grandTotal.shop).toEqual({ amount: 4000, currency: 'EUR' });
    expect(doc.totals.grandTotal.presentment).toEqual({ amount: 4000, currency: 'EUR' });
    expect(doc.fxRate).toBeUndefined();
    expect(syncRunCreate.mock.calls[0][0]).toMatchObject({ kind: 'webhook' });
  });

  it('is idempotent — order.updated for an existing external order updates in place, never duplicates', async () => {
    connectionFindById.mockResolvedValue(wooConnection());
    orderFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: 'order-existing', status: 'pending_payment' }),
    });

    await processConnectorWebhook({
      connectionId: 'conn-woo',
      topic: 'order.updated',
      payload: wooOrderPayload(),
    });

    expect(orderCreate).not.toHaveBeenCalled();
    expect(orderUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = orderUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'order-existing' });
    expect(update.$set.status).toBe('paid');
    expect(run.counts).toMatchObject({ updated: 1, created: 0 });
  });

  it('ignores an order webhook when order pull is disabled', async () => {
    connectionFindById.mockResolvedValue(
      wooConnection({
        syncSettings: { products: 'pull', orders: 'off', inventory: 'off', autoPublish: true, conflictPolicy: 'respect_overrides' },
      }),
    );

    await processConnectorWebhook({ connectionId: 'conn-woo', topic: 'order.updated', payload: wooOrderPayload() });

    expect(syncRunCreate).not.toHaveBeenCalled();
    expect(orderCreate).not.toHaveBeenCalled();
  });
});
