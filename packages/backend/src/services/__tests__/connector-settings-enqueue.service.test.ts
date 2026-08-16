/**
 * Turning a resource ON is what starts its first import.
 *
 * The defect this pins was total and silent in production: `updateSyncSettings`
 * wrote the `sync_settings_*` columns and did nothing else, while the connect path
 * enqueued an initial pull only for resources already enabled — and a fresh
 * connection defaults every direction to `off`. So the two paths between them
 * covered no case at all. A merchant connected a real store, moved `products` from
 * `off` to `pull`, saved, and imported nothing, forever, with the connection
 * reporting `connected` and every layer returning success.
 *
 * What is measured here is the SERVICE half: which resources a given write turns
 * on, and whether a connection is one an initial pull could actually run against.
 * The SQL half — that the previous directions returned beside the new ones really
 * are the pre-update values — is not mockable and lives in
 * `db/__tests__/connectors.realdb.test.ts`, because a mocked `update` accepts any
 * statement including one the server would reject.
 *
 * The producers are mocked for `connector-queue-boundary.test.ts`'s reason: their
 * inline fallback runs the real handler in-process when Redis is off, so a test
 * that let the real producer run could not tell "enqueued" from "ran inline".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncResourceDirection } from '@mercaria/shared-types';

const updateSyncSettingsColumns = vi.fn();
const enqueueConnectionBackfill = vi.fn();
const enqueueOrderSync = vi.fn();
const enqueueInventorySync = vi.fn();

vi.mock('../../db/connectors/connectionRepository.js', () => ({
  updateSyncSettings: (...args: unknown[]) => updateSyncSettingsColumns(...args),
  findConnection: vi.fn(),
  findConnectionById: vi.fn(),
  findConnectionByProvider: vi.fn(),
  findConnectionCredentials: vi.fn(),
  findConnectionsByStore: vi.fn(),
  findPullConnectionsToReconcile: vi.fn(),
  findPushConnections: vi.fn(),
  findConnectionWebhookFailures: vi.fn().mockResolvedValue(new Map()),
  disconnectConnection: vi.fn(),
  markConnectionError: vi.fn(),
  markConnectionSynced: vi.fn(),
  recordConnectionWebhookRegistration: vi.fn(),
  touchConnectionLastSync: vi.fn(),
  upsertConnection: vi.fn(),
}));
vi.mock('../../queue/producers.js', () => ({
  enqueueConnectionBackfill: (...args: unknown[]) => enqueueConnectionBackfill(...args),
  enqueueOrderSync: (...args: unknown[]) => enqueueOrderSync(...args),
  enqueueInventorySync: (...args: unknown[]) => enqueueInventorySync(...args),
  enqueueWebhookProcess: vi.fn(),
  enqueueProductPush: vi.fn(),
  enqueueFulfillmentPush: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { updateSyncSettings } from '../connector-sync.service.js';

interface RowOverrides {
  readonly products?: SyncResourceDirection;
  readonly inventory?: SyncResourceDirection;
  readonly orders?: SyncResourceDirection;
  readonly previousProducts?: SyncResourceDirection;
  readonly previousInventory?: SyncResourceDirection;
  readonly previousOrders?: SyncResourceDirection;
  readonly mode?: 'pull' | 'push_in';
  readonly hasCredentials?: boolean;
}

/**
 * The row `updateSyncSettings` returns: the connection as written, plus the three
 * directions as they stood before the write. Defaults are the state that matters —
 * a connected `pull` channel that was importing nothing.
 */
function updatedRow(overrides: RowOverrides = {}) {
  return {
    id: 'conn-1',
    storeId: 'store-1',
    provider: 'shopify' as const,
    mode: overrides.mode ?? ('pull' as const),
    status: 'connected' as const,
    hasCredentials: overrides.hasCredentials ?? true,
    syncSettingsProducts: overrides.products ?? ('off' as const),
    syncSettingsInventory: overrides.inventory ?? ('off' as const),
    syncSettingsOrders: overrides.orders ?? ('off' as const),
    previousSyncSettingsProducts: overrides.previousProducts ?? ('off' as const),
    previousSyncSettingsInventory: overrides.previousInventory ?? ('off' as const),
    previousSyncSettingsOrders: overrides.previousOrders ?? ('off' as const),
  };
}

/** Every producer this path can reach, for the assertions that must see none of them. */
function enqueueCallCount(): number {
  return (
    enqueueConnectionBackfill.mock.calls.length +
    enqueueOrderSync.mock.calls.length +
    enqueueInventorySync.mock.calls.length
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every producer resolves `Promise<void>`, so the mocks must too — the service
  // attaches a `.catch` to keep a queue outage from failing a committed write, and
  // a mock returning `undefined` would measure a shape the real module never has.
  // Re-asserted per test rather than once, so the rejection case below cannot leak
  // into whatever runs after it.
  enqueueConnectionBackfill.mockResolvedValue(undefined);
  enqueueOrderSync.mockResolvedValue(undefined);
  enqueueInventorySync.mockResolvedValue(undefined);
});

describe('saving sync settings starts what it turns on', () => {
  it('ENQUEUES a backfill when products moves off -> pull', async () => {
    updateSyncSettingsColumns.mockResolvedValue(updatedRow({ products: 'pull' }));

    await updateSyncSettings('store-1', 'conn-1', { products: 'pull' });

    expect(enqueueConnectionBackfill).toHaveBeenCalledWith({
      storeId: 'store-1',
      connectionId: 'conn-1',
    });
  });

  it('ENQUEUES a backfill when products moves off -> bidirectional', async () => {
    // `bidirectional` pulls too. Reading only `=== 'pull'` would leave a two-way
    // channel importing nothing, which is the same silence in a rarer shape.
    updateSyncSettingsColumns.mockResolvedValue(updatedRow({ products: 'bidirectional' }));

    await updateSyncSettings('store-1', 'conn-1', { products: 'bidirectional' });

    expect(enqueueConnectionBackfill).toHaveBeenCalledTimes(1);
  });

  it('enqueues each resource its own producer, and only the ones turned on', async () => {
    updateSyncSettingsColumns.mockResolvedValue(
      updatedRow({
        products: 'pull',
        orders: 'pull',
        // Inventory was ALREADY pulling and the patch leaves it there.
        inventory: 'pull',
        previousInventory: 'pull',
      }),
    );

    await updateSyncSettings('store-1', 'conn-1', { products: 'pull', orders: 'pull' });

    expect(enqueueConnectionBackfill).toHaveBeenCalledTimes(1);
    expect(enqueueOrderSync).toHaveBeenCalledTimes(1);
    expect(enqueueInventorySync).not.toHaveBeenCalled();
  });
});

describe('what must NOT re-import', () => {
  it('enqueues nothing when a resource was already pulling', async () => {
    // The partial-patch case: a merchant saves a target location on a channel that
    // has been importing for months. `products` is written unchanged, and a check
    // on the STATE rather than the TRANSITION would re-import the whole catalogue
    // on every unrelated save.
    updateSyncSettingsColumns.mockResolvedValue(
      updatedRow({ products: 'pull', previousProducts: 'pull' }),
    );

    await updateSyncSettings('store-1', 'conn-1', { targetLocationId: 'loc-1' });

    expect(enqueueCallCount()).toBe(0);
  });

  it('enqueues nothing when a resource is turned OFF', async () => {
    updateSyncSettingsColumns.mockResolvedValue(
      updatedRow({ products: 'off', previousProducts: 'pull' }),
    );

    await updateSyncSettings('store-1', 'conn-1', { products: 'off' });

    expect(enqueueCallCount()).toBe(0);
  });

  it('enqueues nothing when a resource moves push -> pull is not what happened', async () => {
    // `push` does not pull, so `push -> pull` IS a transition and must import;
    // `pull -> push` is not and must not. Both directions in one case, because a
    // predicate written as `after !== before` would get the second one wrong.
    updateSyncSettingsColumns.mockResolvedValue(
      updatedRow({ products: 'push', previousProducts: 'pull' }),
    );

    await updateSyncSettings('store-1', 'conn-1', { products: 'push' });

    expect(enqueueCallCount()).toBe(0);
  });

  it('ENQUEUES when a resource moves push -> pull', async () => {
    updateSyncSettingsColumns.mockResolvedValue(
      updatedRow({ products: 'pull', previousProducts: 'push' }),
    );

    await updateSyncSettings('store-1', 'conn-1', { products: 'pull' });

    expect(enqueueConnectionBackfill).toHaveBeenCalledTimes(1);
  });
});

describe('connections an initial pull could not run against', () => {
  it('writes the setting but enqueues nothing for a push_in connection', async () => {
    // A plugin pushes INTO Mercaria and cannot run a pull at all — `requestBackfill`
    // refuses one outright. The setting is still stored: this path has nobody to
    // report a refusal to, so it must not enqueue work that is certain to fail.
    const row = updatedRow({ products: 'pull', mode: 'push_in' });
    updateSyncSettingsColumns.mockResolvedValue(row);

    const result = await updateSyncSettings('store-1', 'conn-1', { products: 'pull' });

    expect(enqueueCallCount()).toBe(0);
    expect(result.syncSettingsProducts).toBe('pull');
  });

  it('writes the setting but enqueues nothing for a connection holding no credential', async () => {
    // Disconnecting nulls all three credential columns, so a backfill would fail on
    // decrypt. A merchant may configure a channel before reconnecting it, and the
    // RECONNECT is what starts the import.
    const row = updatedRow({ products: 'pull', hasCredentials: false });
    updateSyncSettingsColumns.mockResolvedValue(row);

    const result = await updateSyncSettings('store-1', 'conn-1', { products: 'pull' });

    expect(enqueueCallCount()).toBe(0);
    expect(result.syncSettingsProducts).toBe('pull');
  });
});

describe('a failed enqueue never fails the save', () => {
  it('returns the written connection when the producer rejects', async () => {
    // The columns are already committed by the time this runs. A queue that is
    // briefly unreachable must not turn a settings save into a 500 the merchant
    // retries against a row that already changed.
    updateSyncSettingsColumns.mockResolvedValue(updatedRow({ products: 'pull' }));
    enqueueConnectionBackfill.mockRejectedValue(new Error('redis is down'));

    const result = await updateSyncSettings('store-1', 'conn-1', { products: 'pull' });

    expect(result.syncSettingsProducts).toBe('pull');
  });
});
