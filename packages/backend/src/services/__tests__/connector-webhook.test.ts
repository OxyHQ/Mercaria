/**
 * Unit tests for `processConnectorWebhook` — the inbound-webhook write path.
 *
 * Focus (per the connectors async/real-time layer): a `products/delete` webhook
 * ARCHIVES the mapped listing (soft-delete, never hard-delete) and records a
 * `webhook` SyncRun; an unmapped delete is a no-op counted as skipped; and a
 * webhook for a connection with product pull DISABLED is ignored (no SyncRun, no
 * write). Models + Socket.IO are mocked so no DB or socket server is touched.
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

import { processConnectorWebhook } from '../connector-sync.service.js';

/** A live, product-pull connection the webhook can act on. */
function connectedPullConnection(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'conn-1',
    storeId: 'store-1',
    provider: 'shopify',
    status: 'connected',
    shopCurrency: 'USD',
    syncSettings: { products: 'pull', autoPublish: true, conflictPolicy: 'respect_overrides' },
    ...overrides,
  };
}

let run: { counts: unknown; status: string; error?: string; finishedAt?: Date; save: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  run = { counts: {}, status: 'running', save: vi.fn().mockResolvedValue(undefined) };
  syncRunCreate.mockResolvedValue(run);
  connectionUpdateOne.mockResolvedValue({});
});

describe('processConnectorWebhook — products/delete → archive', () => {
  it('archives the mapped listing and completes the run (counted as updated)', async () => {
    connectionFindById.mockResolvedValue(connectedPullConnection());
    listingUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    await processConnectorWebhook({
      connectionId: 'conn-1',
      topic: 'products/delete',
      payload: { id: 987654321 },
    });

    // Soft-delete via status:archived, scoped by the external provenance key.
    expect(listingUpdateOne).toHaveBeenCalledWith(
      { storeId: 'store-1', 'source.connectionId': 'conn-1', 'source.externalId': '987654321' },
      { $set: { status: 'archived' } },
    );
    expect(run.status).toBe('completed');
    expect(run.counts).toEqual({ created: 0, updated: 1, skipped: 0, failed: 0 });
    expect(run.save).toHaveBeenCalled();
  });

  it('counts a delete for an unmapped product as skipped (no archive happened)', async () => {
    connectionFindById.mockResolvedValue(connectedPullConnection());
    listingUpdateOne.mockResolvedValue({ modifiedCount: 0 });

    await processConnectorWebhook({
      connectionId: 'conn-1',
      topic: 'products/delete',
      payload: { id: 1 },
    });

    expect(run.status).toBe('completed');
    expect(run.counts).toEqual({ created: 0, updated: 0, skipped: 1, failed: 0 });
  });

  it('records a failure (not a throw) on a malformed delete payload', async () => {
    connectionFindById.mockResolvedValue(connectedPullConnection());

    await expect(
      processConnectorWebhook({ connectionId: 'conn-1', topic: 'products/delete', payload: {} }),
    ).resolves.toBeUndefined();

    expect(listingUpdateOne).not.toHaveBeenCalled();
    expect(run.status).toBe('failed');
    expect(run.counts).toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });
  });
});

describe('processConnectorWebhook — direction + status guards', () => {
  it('ignores the webhook when product pull is disabled (no SyncRun, no write)', async () => {
    connectionFindById.mockResolvedValue(
      connectedPullConnection({ syncSettings: { products: 'off', autoPublish: false, conflictPolicy: 'respect_overrides' } }),
    );

    await processConnectorWebhook({
      connectionId: 'conn-1',
      topic: 'products/delete',
      payload: { id: 1 },
    });

    expect(syncRunCreate).not.toHaveBeenCalled();
    expect(listingUpdateOne).not.toHaveBeenCalled();
  });

  it('ignores a webhook for an unknown connection', async () => {
    connectionFindById.mockResolvedValue(null);

    await processConnectorWebhook({
      connectionId: 'missing',
      topic: 'products/delete',
      payload: { id: 1 },
    });

    expect(syncRunCreate).not.toHaveBeenCalled();
    expect(listingUpdateOne).not.toHaveBeenCalled();
  });

  it('ignores a webhook for a disconnected connection', async () => {
    connectionFindById.mockResolvedValue(connectedPullConnection({ status: 'disconnected' }));

    await processConnectorWebhook({
      connectionId: 'conn-1',
      topic: 'products/delete',
      payload: { id: 1 },
    });

    expect(syncRunCreate).not.toHaveBeenCalled();
    expect(listingUpdateOne).not.toHaveBeenCalled();
  });
});
