/**
 * Unit tests for `processConnectorWebhook` — the inbound-webhook write path.
 *
 * Focus (per the connectors async/real-time layer): a `products/delete` webhook
 * ARCHIVES the mapped listing (soft-delete, never hard-delete) and records a
 * `webhook` SyncRun; a delete that archives nothing is counted as skipped; and a
 * webhook for a connection with product pull DISABLED is ignored (no SyncRun, no
 * write).
 *
 * The archive is TWO repository calls: `findListingBySourceExternalId` resolves
 * the provenance key and `setListingStatusIfIn` makes the conditional status
 * write. Every repository this path touches — catalogue, connection, sync-run —
 * plus the catalog-write funnels, the inventory service and Socket.IO are
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

const insertSyncRun = vi.fn();
const finishSyncRun = vi.fn();
vi.mock('../../db/connectors/syncRunRepository.js', () => ({
  insertSyncRun: (...args: unknown[]) => insertSyncRun(...args),
  finishSyncRun: (...args: unknown[]) => finishSyncRun(...args),
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

const findVariantBySourceInventoryItemId = vi.fn();
const findVariantOptionValues = vi.fn();
const findVariantsByListing = vi.fn();
const findVariantsBySourceConnection = vi.fn();
const updateVariantColumns = vi.fn();
vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantBySourceInventoryItemId: (...args: unknown[]) =>
    findVariantBySourceInventoryItemId(...args),
  findVariantOptionValues: (...args: unknown[]) => findVariantOptionValues(...args),
  findVariantsByListing: (...args: unknown[]) => findVariantsByListing(...args),
  findVariantsBySourceConnection: (...args: unknown[]) => findVariantsBySourceConnection(...args),
  updateVariant: (...args: unknown[]) => updateVariantColumns(...args),
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

import { processConnectorWebhook } from '../connector-sync.service.js';

/** A live, product-pull connection the webhook can act on — FLAT columns. */
function connectedPullConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    storeId: 'store-1',
    provider: 'shopify',
    status: 'connected',
    hasCredentials: true,
    shopCurrency: 'USD',
    syncSettingsProducts: 'pull',
    syncSettingsAutoPublish: true,
    syncSettingsConflictPolicy: 'respect_overrides',
    syncSettingsPriceRulesMarkupPercent: null,
    syncSettingsPriceRulesRounding: null,
    syncSettingsCollectionMapping: null,
    syncSettingsTargetLocationId: null,
    ...overrides,
  };
}

/** The `listings` columns the archive path reads, as the repository returns them. */
function sourcedListingRow(): unknown {
  return {
    id: 'listing-1',
    storeId: 'store-1',
    status: 'active',
    sourceConnectionId: 'conn-1',
    sourceProvider: 'shopify',
    sourceExternalId: '987654321',
    overriddenFields: [],
  };
}

/**
 * The outcome the service reported when it CLOSED the run.
 *
 * The Mongoose path let a test read `run.status`/`run.counts` off a document the
 * service mutated in place. A run is two statements now — opened, then closed —
 * so the same facts live in the argument `finishSyncRun` received, which is the
 * thing that would actually have been persisted.
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
  insertSyncRun.mockResolvedValue({ id: 'run-1', connectionId: 'conn-1', kind: 'webhook' });
  finishSyncRun.mockResolvedValue({ id: 'run-1' });
  touchConnectionLastSync.mockResolvedValue(undefined);
});

describe('processConnectorWebhook — products/delete → archive', () => {
  it('archives the mapped listing and completes the run (counted as updated)', async () => {
    findConnectionById.mockResolvedValue(connectedPullConnection());
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow());
    setListingStatusIfIn.mockResolvedValue(true);

    await processConnectorWebhook({
      connectionId: 'conn-1',
      topic: 'products/delete',
      payload: { id: 987654321 },
    });

    // The old assertion pinned ONE Mongo `updateOne` whose FILTER carried the
    // provenance key (`{storeId, 'source.connectionId', 'source.externalId'}`).
    // No such predicate exists any more: the service resolves the listing by that
    // key and then makes a conditional status write, so the same decision is now
    // these two repository calls with these arguments.
    expect(findListingBySourceExternalId).toHaveBeenCalledWith('store-1', 'conn-1', '987654321');
    expect(setListingStatusIfIn).toHaveBeenCalledWith(
      'listing-1',
      'archived',
      ALL_LISTING_STATUSES,
    );
    expect(closedRun().status).toBe('completed');
    expect(closedRun().counts).toEqual({ created: 0, updated: 1, skipped: 0, failed: 0 });
    expect(finishSyncRun).toHaveBeenCalledTimes(1);
  });

  it('counts a delete for an unmapped product as skipped (no archive happened)', async () => {
    findConnectionById.mockResolvedValue(connectedPullConnection());
    findListingBySourceExternalId.mockResolvedValue(null);

    await processConnectorWebhook({
      connectionId: 'conn-1',
      topic: 'products/delete',
      payload: { id: 1 },
    });

    expect(setListingStatusIfIn).not.toHaveBeenCalled();
    expect(closedRun().status).toBe('completed');
    expect(closedRun().counts).toEqual({ created: 0, updated: 0, skipped: 1, failed: 0 });
  });

  it('counts a RE-DELIVERED delete as skipped — an already-archived listing is not re-archived', async () => {
    // Mongo collapsed this into the same `modifiedCount: 0` as the unmapped case
    // above; the two are separate outcomes now (a resolved listing whose guarded
    // status write refuses), and both must still count as skipped rather than as
    // a second archive.
    findConnectionById.mockResolvedValue(connectedPullConnection());
    findListingBySourceExternalId.mockResolvedValue({
      ...(sourcedListingRow() as Record<string, unknown>),
      status: 'archived',
    });
    setListingStatusIfIn.mockResolvedValue(false);

    await processConnectorWebhook({
      connectionId: 'conn-1',
      topic: 'products/delete',
      payload: { id: 987654321 },
    });

    expect(setListingStatusIfIn).toHaveBeenCalledTimes(1);
    expect(closedRun().status).toBe('completed');
    expect(closedRun().counts).toEqual({ created: 0, updated: 0, skipped: 1, failed: 0 });
  });

  it('records a failure (not a throw) on a malformed delete payload', async () => {
    findConnectionById.mockResolvedValue(connectedPullConnection());

    await expect(
      processConnectorWebhook({ connectionId: 'conn-1', topic: 'products/delete', payload: {} }),
    ).resolves.toBeUndefined();

    expect(findListingBySourceExternalId).not.toHaveBeenCalled();
    expect(setListingStatusIfIn).not.toHaveBeenCalled();
    expect(closedRun().status).toBe('failed');
    expect(closedRun().counts).toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });
  });
});

describe('processConnectorWebhook — direction + status guards', () => {
  it('ignores the webhook when product pull is disabled (no SyncRun, no write)', async () => {
    findConnectionById.mockResolvedValue(
      connectedPullConnection({ syncSettingsProducts: 'off' }),
    );

    await processConnectorWebhook({
      connectionId: 'conn-1',
      topic: 'products/delete',
      payload: { id: 1 },
    });

    expect(insertSyncRun).not.toHaveBeenCalled();
    expect(findListingBySourceExternalId).not.toHaveBeenCalled();
    expect(setListingStatusIfIn).not.toHaveBeenCalled();
  });

  it('ignores a webhook for an unknown connection', async () => {
    findConnectionById.mockResolvedValue(null);

    await processConnectorWebhook({
      connectionId: 'missing',
      topic: 'products/delete',
      payload: { id: 1 },
    });

    expect(insertSyncRun).not.toHaveBeenCalled();
    expect(setListingStatusIfIn).not.toHaveBeenCalled();
  });

  it('ignores a webhook for a disconnected connection', async () => {
    findConnectionById.mockResolvedValue(connectedPullConnection({ status: 'disconnected' }));

    await processConnectorWebhook({
      connectionId: 'conn-1',
      topic: 'products/delete',
      payload: { id: 1 },
    });

    expect(insertSyncRun).not.toHaveBeenCalled();
    expect(setListingStatusIfIn).not.toHaveBeenCalled();
  });
});
