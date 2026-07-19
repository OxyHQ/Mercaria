/**
 * Unit tests for `connector-sync.service.reconcileAllConnections` — the scheduled
 * reconcile sweep (Fix 2: the safety net for missed real-time webhooks).
 *
 * No DB / no network: the Connection model and the queue producer are mocked. The
 * sweep must (a) resolve ONLY connected `pull`/`bidirectional` connections and
 * enqueue a backfill for each, and (b) survive a failing connection without
 * aborting the rest of the sweep. The registry/crypto/catalog mocks mirror the
 * sibling connector-sync test so no heavy real module loads at import.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const connectionFind = vi.fn();
const enqueueConnectionBackfill = vi.fn();

vi.mock('../../models/connection.js', () => ({
  Connection: { find: (...a: unknown[]) => connectionFind(...a) },
}));
vi.mock('../../models/sync-run.js', () => ({ SyncRun: { create: vi.fn() } }));
vi.mock('../../models/listing.js', () => ({
  Listing: { find: vi.fn(), findOne: vi.fn(), updateOne: vi.fn(), exists: vi.fn() },
}));
vi.mock('../../models/product-variant.js', () => ({ ProductVariant: { find: vi.fn() } }));
vi.mock('../../models/category.js', () => ({ Category: { exists: vi.fn() } }));
vi.mock('../catalog-write.service.js', () => ({
  createStoreProduct: vi.fn(),
  updateListing: vi.fn(),
  updateVariant: vi.fn(),
}));
vi.mock('../../lib/connector-crypto.js', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock('../../connectors/registry.js', () => ({ getConnectorProvider: vi.fn() }));
vi.mock('../../queue/producers.js', () => ({
  enqueueConnectionBackfill: (...a: unknown[]) => enqueueConnectionBackfill(...a),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { reconcileAllConnections } from '../connector-sync.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  enqueueConnectionBackfill.mockResolvedValue(undefined);
});

describe('reconcileAllConnections — scheduled sweep', () => {
  it('enqueues a backfill for each connection resolved by the pull-enabled filter', async () => {
    connectionFind.mockResolvedValue([
      { _id: 'c1', storeId: 's1' },
      { _id: 'c2', storeId: 's2' },
    ]);

    await reconcileAllConnections();

    // The Mongo filter restricts to connected, product-pull-enabled pull connections.
    const [filter] = connectionFind.mock.calls[0];
    expect(filter).toMatchObject({
      mode: 'pull',
      status: 'connected',
      'syncSettings.products': { $in: ['pull', 'bidirectional'] },
    });
    expect(enqueueConnectionBackfill).toHaveBeenCalledTimes(2);
    expect(enqueueConnectionBackfill).toHaveBeenCalledWith({ storeId: 's1', connectionId: 'c1' });
    expect(enqueueConnectionBackfill).toHaveBeenCalledWith({ storeId: 's2', connectionId: 'c2' });
  });

  it('survives one failing connection and still enqueues the rest', async () => {
    connectionFind.mockResolvedValue([
      { _id: 'c1', storeId: 's1' },
      { _id: 'c2', storeId: 's2' },
    ]);
    enqueueConnectionBackfill
      .mockRejectedValueOnce(new Error('enqueue boom'))
      .mockResolvedValueOnce(undefined);

    await expect(reconcileAllConnections()).resolves.toBeUndefined();
    expect(enqueueConnectionBackfill).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when there are no eligible connections', async () => {
    connectionFind.mockResolvedValue([]);

    await reconcileAllConnections();

    expect(enqueueConnectionBackfill).not.toHaveBeenCalled();
  });
});
