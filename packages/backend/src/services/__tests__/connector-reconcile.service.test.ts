/**
 * Unit tests for `connector-sync.service.reconcileAllConnections` — the scheduled
 * reconcile sweep (Fix 2: the safety net for missed real-time webhooks).
 *
 * No DB / no network: the connection repository and the queue producer are
 * mocked. The sweep must (a) resolve ONLY connected `pull`/`bidirectional`
 * connections and enqueue a backfill for each, and (b) survive a failing
 * connection without aborting the rest of the sweep. The registry/crypto/catalog
 * mocks mirror the sibling connector-sync test so no heavy real module loads at
 * import.
 *
 * The Mongo FILTER this used to assert on (`{mode, status, 'syncSettings.products':
 * {$in: […]}}`) is not a value the service composes any more — it is the
 * repository's own `where`, which a mock cannot see and a mocked assertion about
 * it could only restate. What the service still owns, and what is asserted here,
 * is that the sweep enqueues one job per row the repository returns and survives
 * a failure in any one of them. The filter itself is exercised against a real
 * server by `src/db/__tests__/connectors.realdb.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findPullConnectionsToReconcile = vi.fn();
const enqueueConnectionBackfill = vi.fn();

vi.mock('../../db/connectors/connectionRepository.js', () => ({
  findPullConnectionsToReconcile: (...a: unknown[]) => findPullConnectionsToReconcile(...a),
  findConnection: vi.fn(),
  findConnectionById: vi.fn(),
  findConnectionByProvider: vi.fn(),
  findConnectionCredentials: vi.fn(),
  findConnectionsByStore: vi.fn(),
  findPushConnections: vi.fn(),
  disconnectConnection: vi.fn(),
  markConnectionError: vi.fn(),
  markConnectionSynced: vi.fn(),
  setConnectionWebhooks: vi.fn(),
  touchConnectionLastSync: vi.fn(),
  updateSyncSettings: vi.fn(),
  upsertConnection: vi.fn(),
}));
vi.mock('../../db/connectors/syncRunRepository.js', () => ({
  insertSyncRun: vi.fn(),
  finishSyncRun: vi.fn(),
}));
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
  it('enqueues a backfill for each connection the pull-enabled read returns', async () => {
    findPullConnectionsToReconcile.mockResolvedValue([
      { id: 'c1', storeId: 's1' },
      { id: 'c2', storeId: 's2' },
    ]);

    await reconcileAllConnections();

    // The projection is now the repository's whole select list — two columns —
    // so the sweep never touches a connection's credentials or settings at all.
    expect(findPullConnectionsToReconcile).toHaveBeenCalledTimes(1);
    expect(enqueueConnectionBackfill).toHaveBeenCalledTimes(2);
    expect(enqueueConnectionBackfill).toHaveBeenCalledWith({ storeId: 's1', connectionId: 'c1' });
    expect(enqueueConnectionBackfill).toHaveBeenCalledWith({ storeId: 's2', connectionId: 'c2' });
  });

  it('survives one failing connection and still enqueues the rest', async () => {
    findPullConnectionsToReconcile.mockResolvedValue([
      { id: 'c1', storeId: 's1' },
      { id: 'c2', storeId: 's2' },
    ]);
    enqueueConnectionBackfill
      .mockRejectedValueOnce(new Error('enqueue boom'))
      .mockResolvedValueOnce(undefined);

    await expect(reconcileAllConnections()).resolves.toBeUndefined();
    expect(enqueueConnectionBackfill).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when there are no eligible connections', async () => {
    findPullConnectionsToReconcile.mockResolvedValue([]);

    await reconcileAllConnections();

    expect(enqueueConnectionBackfill).not.toHaveBeenCalled();
  });
});
