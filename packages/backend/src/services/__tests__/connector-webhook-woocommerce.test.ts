/**
 * Unit tests for the PROVIDER-AWARE inbound-webhook dispatch, exercised through the
 * WooCommerce path. Proves the dispatcher classifies WooCommerce's dot-delimited
 * topics (`product.deleted`, `order.created`, …) to the SAME provider-neutral kinds
 * as Shopify's slash topics, and routes them to the right — provider-agnostic —
 * handler (product archive, idempotent order upsert), gated per resource direction.
 *
 * The real WooCommerce provider is used (its `normalizeOrder` is a pure map), so the
 * order path is a genuine integration of Woo-JSON → NormalizedOrder → Mercaria order.
 *
 * The product archive goes through the listing REPOSITORY
 * (`findListingBySourceExternalId` + `setListingStatusIfIn`). Every repository
 * this path touches — catalogue, connection, sync-run, order — and Socket.IO are
 * mocked, so no database or socket server is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ALL_LISTING_STATUSES, type SyncRunCounts } from '@mercaria/shared-types';

vi.mock('../../socket.js', () => ({ getIO: () => null }));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const findConnectionById = vi.fn();
const touchConnectionLastSync = vi.fn();
vi.mock('../../db/connectors/connectionRepository.js', () => ({
  findConnectionById: (...args: unknown[]) => findConnectionById(...args),
  touchConnectionLastSync: (...args: unknown[]) => touchConnectionLastSync(...args),
  findConnection: vi.fn(),
  findConnectionByProvider: vi.fn(),
  findConnectionCredentials: vi.fn(),
  findConnectionsByStore: vi.fn(),
  findPullConnectionsToReconcile: vi.fn(),
  findPushConnections: vi.fn(),
  disconnectConnection: vi.fn(),
  markConnectionError: vi.fn(),
  markConnectionSynced: vi.fn(),
  recordConnectionWebhookRegistration: vi.fn(),
  findConnectionWebhookFailures: vi.fn().mockResolvedValue(new Map()),
  updateSyncSettings: vi.fn(),
  upsertConnection: vi.fn(),
}));

const findListingById = vi.fn();
const findListingBySourceExternalId = vi.fn();
const findListingChildren = vi.fn();
const findListingsBySourceConnection = vi.fn();
const setListingStatusIfIn = vi.fn();
const updateListingColumns = vi.fn();
vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingById: (...args: unknown[]) => findListingById(...args),
  findListingBySourceExternalId: (...args: unknown[]) => findListingBySourceExternalId(...args),
  findListingChildren: (...args: unknown[]) => findListingChildren(...args),
  findListingsBySourceConnection: (...args: unknown[]) => findListingsBySourceConnection(...args),
  setListingStatusIfIn: (...args: unknown[]) => setListingStatusIfIn(...args),
  updateListingColumns: (...args: unknown[]) => updateListingColumns(...args),
}));

vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantBySourceInventoryItemId: vi.fn(),
  findVariantOptionValues: vi.fn(),
  findVariantsByListing: vi.fn(),
  findVariantsBySourceConnection: vi.fn(),
  updateVariant: vi.fn(),
}));
vi.mock('../../db/catalog/listingExternalRefRepository.js', () => ({
  findExternalRefByListingAndConnection: vi.fn(),
  listingPushedToConnection: vi.fn(),
  upsertExternalRef: vi.fn(),
}));
vi.mock('../../db/catalog/categoryRepository.js', () => ({ categorySlugExists: vi.fn() }));
vi.mock('../../db/merchandising/collectionRepository.js', () => ({
  setListingAutomatedMemberships: vi.fn(),
}));
vi.mock('../../db/stores/locationRepository.js', () => ({ findLocation: vi.fn() }));
vi.mock('../catalog-write.service.js', () => ({
  createStoreProduct: vi.fn(),
  updateListing: vi.fn(),
  updateVariant: vi.fn(),
  resolveDefaultLocationId: vi.fn(),
}));
vi.mock('../inventory.service.js', () => ({ setAvailable: vi.fn() }));
/**
 * No database: this suite mocks every repository, so the real `getDb()` throws
 * "PostgreSQL is not connected".
 *
 * That throw is not new. Before #584 it happened INSIDE `requestNativeOfferSync`,
 * whose catch swallowed it — so the archive paths below have never enqueued an
 * offer convergence here, and nothing said so. #584 made the handle a required
 * argument, so the call site names the root connection and the throw moved OUT
 * of that catch. Stubbing `getDb` puts it back where it was: the enqueue still
 * fails, still inside the try, still swallowed. What the suite tests is the
 * connector's own bookkeeping; offer convergence is #57's and is exercised
 * against a real server by `offers.realdb.test.ts`.
 */
vi.mock('../../db/postgres.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/postgres.js')>()),
  getDb: () => ({}) as ReturnType<typeof import('../../db/postgres.js').getDb>,
}));

const insertSyncRun = vi.fn();
const finishSyncRun = vi.fn();
vi.mock('../../db/connectors/syncRunRepository.js', () => ({
  insertSyncRun: (...args: unknown[]) => insertSyncRun(...args),
  finishSyncRun: (...args: unknown[]) => finishSyncRun(...args),
}));

const findOrderBySourceExternalId = vi.fn();
const insertOrder = vi.fn();
const updateOrderFromSource = vi.fn();
const nextOrderNumber = vi.fn();
vi.mock('../../db/orders/orderRepository.js', () => ({
  findOrderBySourceExternalId: (...args: unknown[]) => findOrderBySourceExternalId(...args),
  insertOrder: (...args: unknown[]) => insertOrder(...args),
  updateOrderFromSource: (...args: unknown[]) => updateOrderFromSource(...args),
  findOrderById: vi.fn(),
  nextOrderNumber: (...args: unknown[]) => nextOrderNumber(...args),
}));


import { processConnectorWebhook } from '../connector-sync.service.js';

/** A live WooCommerce pull connection (products + orders pulling) — FLAT columns. */
function wooConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-woo',
    storeId: 'store-1',
    provider: 'woocommerce',
    status: 'connected',
    hasCredentials: true,
    shopCurrency: 'EUR',
    syncSettingsProducts: 'pull',
    syncSettingsOrders: 'pull',
    syncSettingsInventory: 'off',
    syncSettingsAutoPublish: true,
    syncSettingsConflictPolicy: 'respect_overrides',
    syncSettingsPriceRulesMarkupPercent: null,
    syncSettingsPriceRulesRounding: null,
    syncSettingsCollectionMapping: null,
    syncSettingsTargetLocationId: null,
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

/**
 * The outcome the service reported when it CLOSED the run — the two-statement
 * replacement for reading `run.status`/`run.counts` off a mutated document.
 */
function closedRun(): { status: string; counts: SyncRunCounts; error?: string } {
  const call = finishSyncRun.mock.calls[0] as
    | [string, { status: string; counts: SyncRunCounts; error?: string }]
    | undefined;
  if (!call) {
    throw new Error('the run was never closed');
  }
  return call[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  insertSyncRun.mockResolvedValue({ id: 'run-1', connectionId: 'conn-woo', kind: 'webhook' });
  finishSyncRun.mockResolvedValue({ id: 'run-1' });
  touchConnectionLastSync.mockResolvedValue(undefined);
  updateOrderFromSource.mockResolvedValue(undefined);
  insertOrder.mockResolvedValue({ id: 'order-created' });
  nextOrderNumber.mockResolvedValue('MRC-000042');
});

describe('provider-aware dispatch — WooCommerce product.deleted', () => {
  it('classifies the dot-topic to product_delete and archives the mapped listing', async () => {
    findConnectionById.mockResolvedValue(wooConnection());
    findListingBySourceExternalId.mockResolvedValue({
      id: 'listing-woo',
      storeId: 'store-1',
      status: 'active',
      sourceConnectionId: 'conn-woo',
      sourceProvider: 'woocommerce',
      sourceExternalId: '987654321',
      overriddenFields: [],
    });
    setListingStatusIfIn.mockResolvedValue(true);

    await processConnectorWebhook({
      connectionId: 'conn-woo',
      topic: 'product.deleted',
      payload: { id: 987654321 },
    });

    // The Mongo assertion pinned one `updateOne` whose FILTER carried the
    // provenance key; that predicate is gone. The same decision — resolve THIS
    // connection's listing for THIS external id, then archive it — is now these
    // two repository calls, and the Woo dot-topic reaching them at all is what
    // this test is really about.
    expect(findListingBySourceExternalId).toHaveBeenCalledWith('store-1', 'conn-woo', '987654321');
    expect(setListingStatusIfIn).toHaveBeenCalledWith(
      'listing-woo',
      'archived',
      ALL_LISTING_STATUSES,
      // #390 — see the Shopify twin of this case.
      'connector_product_deleted',
    );
    expect(closedRun().status).toBe('completed');
    expect(closedRun().counts).toEqual({ created: 0, updated: 1, skipped: 0, failed: 0 });
  });

  it('ignores the webhook when product pull is disabled (no run, no write)', async () => {
    findConnectionById.mockResolvedValue(
      wooConnection({ syncSettingsProducts: 'off' }),
    );

    await processConnectorWebhook({ connectionId: 'conn-woo', topic: 'product.deleted', payload: { id: 1 } });

    expect(insertSyncRun).not.toHaveBeenCalled();
    expect(findListingBySourceExternalId).not.toHaveBeenCalled();
    expect(setListingStatusIfIn).not.toHaveBeenCalled();
  });
});

describe('provider-aware dispatch — WooCommerce order.created / order.updated', () => {
  it('routes order.created to an order upsert (real Woo normalizeOrder → Mercaria order)', async () => {
    findConnectionById.mockResolvedValue(wooConnection());
    findOrderBySourceExternalId.mockResolvedValue(null);

    await processConnectorWebhook({
      connectionId: 'conn-woo',
      topic: 'order.created',
      payload: wooOrderPayload(),
    });

    expect(insertOrder).toHaveBeenCalledTimes(1);
    const [doc] = insertOrder.mock.calls[0];
    expect(doc.source).toMatchObject({ provider: 'woocommerce', externalId: '727', connectionId: 'conn-woo' });
    // `payment` flattened into two columns; an external order settles off Oxy Pay.
    expect(doc.paymentStatus).toBe('paid');
    expect(doc.paymentProvider).toBe('external');
    expect(doc.buyerOxyUserId).toContain('ext:woocommerce:');
    // Single-currency: shop === presentment on the grand total.
    expect(doc.totals.grandTotal.shop).toEqual({ amount: 4000, currency: 'EUR' });
    expect(doc.totals.grandTotal.presentment).toEqual({ amount: 4000, currency: 'EUR' });
    expect(doc.fxRate).toBeUndefined();
    expect(insertSyncRun).toHaveBeenCalledWith('conn-woo', 'webhook');
  });

  it('is idempotent — order.updated for an existing external order updates in place, never duplicates', async () => {
    findConnectionById.mockResolvedValue(wooConnection());
    findOrderBySourceExternalId.mockResolvedValue({
      id: 'order-existing',
      status: 'pending_payment',
    });

    await processConnectorWebhook({
      connectionId: 'conn-woo',
      topic: 'order.updated',
      payload: wooOrderPayload(),
    });

    expect(insertOrder).not.toHaveBeenCalled();
    expect(updateOrderFromSource).toHaveBeenCalledTimes(1);
    const [orderId, patch] = updateOrderFromSource.mock.calls[0];
    expect(orderId).toBe('order-existing');
    expect(patch.status).toBe('paid');
    expect(closedRun().counts).toMatchObject({ updated: 1, created: 0 });
  });

  it('ignores an order webhook when order pull is disabled', async () => {
    findConnectionById.mockResolvedValue(
      wooConnection({ syncSettingsOrders: 'off' }),
    );

    await processConnectorWebhook({ connectionId: 'conn-woo', topic: 'order.updated', payload: wooOrderPayload() });

    expect(insertSyncRun).not.toHaveBeenCalled();
    expect(insertOrder).not.toHaveBeenCalled();
  });
});
