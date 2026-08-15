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
const findConnectionsToAuditWebhooks = vi.fn();
const enqueueConnectionBackfill = vi.fn();
const enqueueConnectionWebhookAudit = vi.fn();

vi.mock('../../db/connectors/connectionRepository.js', () => ({
  findPullConnectionsToReconcile: (...a: unknown[]) => findPullConnectionsToReconcile(...a),
  findConnectionsToAuditWebhooks: (...a: unknown[]) => findConnectionsToAuditWebhooks(...a),
  findConnection: vi.fn(),
  findConnectionById: vi.fn(),
  findConnectionByProvider: vi.fn(),
  findConnectionCredentials: vi.fn(),
  findConnectionsByStore: vi.fn(),
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
  enqueueConnectionWebhookAudit: (...a: unknown[]) => enqueueConnectionWebhookAudit(...a),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { reconcileAllConnections } from '../connector-sync.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  enqueueConnectionBackfill.mockResolvedValue(undefined);
  enqueueConnectionWebhookAudit.mockResolvedValue(undefined);
  findConnectionsToAuditWebhooks.mockResolvedValue([]);
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
    expect(enqueueConnectionWebhookAudit).not.toHaveBeenCalled();
  });

  it('ALSO enqueues a webhook audit per connection, over its OWN population (#295)', async () => {
    // The entrypoint assertion, and the reason it is here rather than left to
    // the contract suite: `auditConnectionWebhooks` is fully exercised there
    // against a real database and a real platform fake, and would go on passing
    // with NOTHING calling it. #295's detector is only a detector if the
    // six-hourly sweep runs it.
    findPullConnectionsToReconcile.mockResolvedValue([{ id: 'c1', storeId: 's1' }]);
    // A DIFFERENT set, deliberately: webhooks are registered for every topic a
    // provider declares, so a connection selling through `orders: 'pull'` alone
    // has subscriptions and no catalogue to re-pull. Reusing the backfill
    // population would look right and cover a strict subset.
    findConnectionsToAuditWebhooks.mockResolvedValue([
      { id: 'c1', storeId: 's1' },
      { id: 'orders-only', storeId: 's2' },
    ]);

    await reconcileAllConnections();

    expect(findConnectionsToAuditWebhooks).toHaveBeenCalledTimes(1);
    expect(enqueueConnectionWebhookAudit).toHaveBeenCalledTimes(2);
    expect(enqueueConnectionWebhookAudit).toHaveBeenCalledWith({
      storeId: 's1',
      connectionId: 'c1',
    });
    expect(enqueueConnectionWebhookAudit).toHaveBeenCalledWith({
      storeId: 's2',
      connectionId: 'orders-only',
    });
  });

  it('a failing AUDIT enqueue aborts neither the audits nor the sweep', async () => {
    findPullConnectionsToReconcile.mockResolvedValue([{ id: 'c1', storeId: 's1' }]);
    findConnectionsToAuditWebhooks.mockResolvedValue([
      { id: 'c1', storeId: 's1' },
      { id: 'c2', storeId: 's2' },
    ]);
    enqueueConnectionWebhookAudit
      .mockRejectedValueOnce(new Error('enqueue boom'))
      .mockResolvedValueOnce(undefined);

    await expect(reconcileAllConnections()).resolves.toBeUndefined();

    expect(enqueueConnectionWebhookAudit).toHaveBeenCalledTimes(2);
    // And the CATALOGUE half is untouched by it — one unreachable shop's audit
    // must not cost every other merchant their reconcile.
    expect(enqueueConnectionBackfill).toHaveBeenCalledTimes(1);
  });
});
