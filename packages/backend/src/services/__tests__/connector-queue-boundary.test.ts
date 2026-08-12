/**
 * ACCEPTANCE 4, the half Mercaria owns: large sync work is ENQUEUED, never done
 * inside the request that asked for it.
 *
 * A real 5,000-product backfill against a real store is the other half and stays
 * manual (`docs/runbooks/connector-real-store-verification.md`). What is provable
 * here is the property that decides whether it can time out at all: every
 * request-facing entry point validates synchronously — so the caller still gets a
 * proper 404/400 — and then hands the work to the `marketplace-sync` queue.
 *
 * The distinction that makes this worth a test rather than a reading of the code
 * is that `runBackfill`, `syncOrders` and `syncInventory` are EXPORTED beside
 * their `request*` siblings and do the work inline. They are the worker bodies;
 * a controller wired to one of them instead would look almost identical at the
 * call site and would hold an HTTP connection open for the length of a catalogue.
 *
 * The producers are mocked because their INLINE FALLBACK is the thing under test:
 * without Redis they run the handler in-process, so a test that let the real
 * producer run could not tell "enqueued" from "ran inline" at all.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findConnection = vi.fn();
const enqueueConnectionBackfill = vi.fn();
const enqueueOrderSync = vi.fn();
const enqueueInventorySync = vi.fn();
const enqueueWebhookProcess = vi.fn();
const fetchProducts = vi.fn();
const fetchOrders = vi.fn();
const fetchInventory = vi.fn();

vi.mock('../../db/connectors/connectionRepository.js', () => ({
  findConnection: (...args: unknown[]) => findConnection(...args),
  findConnectionById: vi.fn(),
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
  touchConnectionLastSync: vi.fn(),
  updateSyncSettings: vi.fn(),
  upsertConnection: vi.fn(),
}));
vi.mock('../../queue/producers.js', () => ({
  enqueueConnectionBackfill: (...args: unknown[]) => enqueueConnectionBackfill(...args),
  enqueueOrderSync: (...args: unknown[]) => enqueueOrderSync(...args),
  enqueueInventorySync: (...args: unknown[]) => enqueueInventorySync(...args),
  enqueueWebhookProcess: (...args: unknown[]) => enqueueWebhookProcess(...args),
  enqueueProductPush: vi.fn(),
  enqueueFulfillmentPush: vi.fn(),
}));
vi.mock('../../connectors/registry.js', () => ({
  getConnectorProvider: () => ({
    id: 'shopify',
    fetchProducts: (...args: unknown[]) => fetchProducts(...args),
    fetchOrders: (...args: unknown[]) => fetchOrders(...args),
    fetchInventory: (...args: unknown[]) => fetchInventory(...args),
  }),
  isImplementedProvider: () => true,
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  requestBackfill,
  requestInventorySync,
  requestOrderSync,
} from '../connector-sync.service.js';

/** A connected `pull` connection with every direction enabled. */
const CONNECTION = {
  id: 'conn-1',
  storeId: 'store-1',
  provider: 'shopify' as const,
  mode: 'pull' as const,
  status: 'connected' as const,
  shopCurrency: 'EUR',
  syncSettingsProducts: 'pull' as const,
  syncSettingsInventory: 'pull' as const,
  syncSettingsOrders: 'pull' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  findConnection.mockResolvedValue(CONNECTION);
});

describe('the request/worker boundary', () => {
  it('ENQUEUES a backfill instead of paging the platform in the request', async () => {
    await requestBackfill('store-1', 'conn-1');

    expect(enqueueConnectionBackfill).toHaveBeenCalledWith({
      storeId: 'store-1',
      connectionId: 'conn-1',
    });
    // The provider is never touched: no page is fetched, so there is nothing for
    // a large catalogue to time out on.
    expect(fetchProducts).not.toHaveBeenCalled();
  });

  it('ENQUEUES an order sync instead of paging orders in the request', async () => {
    await requestOrderSync('store-1', 'conn-1');

    expect(enqueueOrderSync).toHaveBeenCalledWith({ storeId: 'store-1', connectionId: 'conn-1' });
    expect(fetchOrders).not.toHaveBeenCalled();
  });

  it('ENQUEUES an inventory sync instead of reading levels in the request', async () => {
    await requestInventorySync('store-1', 'conn-1');

    expect(enqueueInventorySync).toHaveBeenCalledWith({
      storeId: 'store-1',
      connectionId: 'conn-1',
    });
    expect(fetchInventory).not.toHaveBeenCalled();
  });
});

describe('validation still runs SYNCHRONOUSLY, so the caller gets a real error', () => {
  it('404s an unknown connection and enqueues nothing', async () => {
    findConnection.mockResolvedValue(null);

    await expect(requestBackfill('store-1', 'conn-1')).rejects.toThrow();
    expect(enqueueConnectionBackfill).not.toHaveBeenCalled();
  });

  it('400s a connection whose product pull is off, and enqueues nothing', async () => {
    findConnection.mockResolvedValue({ ...CONNECTION, syncSettingsProducts: 'off' });

    await expect(requestBackfill('store-1', 'conn-1')).rejects.toThrow();
    expect(enqueueConnectionBackfill).not.toHaveBeenCalled();
  });

  it('400s a push-in connection asked to backfill', async () => {
    findConnection.mockResolvedValue({ ...CONNECTION, mode: 'push_in' });

    await expect(requestBackfill('store-1', 'conn-1')).rejects.toThrow();
    expect(enqueueConnectionBackfill).not.toHaveBeenCalled();
  });

  it('400s an order sync whose order pull is off', async () => {
    findConnection.mockResolvedValue({ ...CONNECTION, syncSettingsOrders: 'off' });

    await expect(requestOrderSync('store-1', 'conn-1')).rejects.toThrow();
    expect(enqueueOrderSync).not.toHaveBeenCalled();
  });

  it('400s an inventory sync whose inventory pull is off', async () => {
    findConnection.mockResolvedValue({ ...CONNECTION, syncSettingsInventory: 'off' });

    await expect(requestInventorySync('store-1', 'conn-1')).rejects.toThrow();
    expect(enqueueInventorySync).not.toHaveBeenCalled();
  });
});
