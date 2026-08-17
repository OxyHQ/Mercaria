/**
 * Unit tests for `connector-sync.service.runBackfill`.
 *
 * No DB / no network. EVERYTHING is mocked at the REPOSITORY boundary now —
 * connections and sync runs alongside listings, variants, categories, the push
 * mirror and collection membership — so every stub is a plain async function
 * returning rows, with no query chains anywhere. The catalog-write funnels, the
 * inventory service, the crypto helper and the provider registry are mocked too.
 *
 * The tests drive `runBackfill` with canned `NormalizedProduct`s (via a mocked
 * provider `fetchProducts`) and assert the create path, the override-respecting
 * merge, the all-pinned "skipped" path, the `connector_wins` policy, paging,
 * variant re-pricing and delete reconciliation.
 *
 * Shapes that changed with the storage, all visible in the assertions:
 *  - Provenance is FOUR FLAT COLUMNS written through `updateListingColumns`, not
 *    a `$set: { source: {...} }` sub-document — and `sourceExternalUpdatedAt` is
 *    written explicitly `null` when the platform sends none.
 *  - The archive is `findListingBySourceExternalId` + `setListingStatusIfIn`
 *    rather than one `updateOne` whose FILTER carried the provenance key, so
 *    both the import lookup and the archive lookup go through the SAME
 *    repository function and the stub answers per external id.
 *  - A connection is FLAT columns (`syncSettingsProducts`, …), and a `SyncRun` is
 *    opened by `insertSyncRun` and closed by `finishSyncRun` rather than being a
 *    mutable document the service assigns `counts`/`status` onto. The run the
 *    service RETURNS is what `finishSyncRun` persisted, so the tests read its
 *    four tally columns — and `finishSyncRun`'s recorded argument is the outcome
 *    the service actually computed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ALL_LISTING_STATUSES, type SyncRunCounts } from '@mercaria/shared-types';
import type { NormalizedProduct } from '../../connectors/types.js';
import { validationError } from '../../lib/errors/error-codes.js';
import { merchantFacingFailureMessage } from '../../lib/errors/merchant-facing.js';

const findConnection = vi.fn();
const markConnectionSynced = vi.fn();
const markConnectionError = vi.fn();
const insertSyncRun = vi.fn();
const finishSyncRun = vi.fn();
const findListingById = vi.fn();
const findListingBySourceExternalId = vi.fn();
const findListingChildren = vi.fn();
const findListingsBySourceConnection = vi.fn();
const setListingStatusIfIn = vi.fn();
const updateListingColumns = vi.fn();
const findVariantBySourceInventoryItemId = vi.fn();
const findVariantOptionValues = vi.fn();
const findVariantsByListing = vi.fn();
const findVariantsBySourceConnection = vi.fn();
const updateVariantColumns = vi.fn();
const listingPushedToConnection = vi.fn();
const findExternalRefByListingAndConnection = vi.fn();
const upsertExternalRef = vi.fn();
const categorySlugExists = vi.fn();
const setListingAutomatedMemberships = vi.fn();
const findLocation = vi.fn();
const createStoreProduct = vi.fn();
const updateListing = vi.fn();
const updateVariant = vi.fn();
const resolveDefaultLocationId = vi.fn();
const setAvailable = vi.fn();
const decryptSecret = vi.fn();
const getConnectorProvider = vi.fn();
const fetchProducts = vi.fn();

vi.mock('../../db/connectors/connectionRepository.js', () => ({
  findConnection: (...args: unknown[]) => findConnection(...args),
  markConnectionSynced: (...args: unknown[]) => markConnectionSynced(...args),
  markConnectionError: (...args: unknown[]) => markConnectionError(...args),
  findConnectionById: vi.fn(),
  findConnectionByProvider: vi.fn(),
  findConnectionCredentials: vi.fn().mockResolvedValue({ ciphertext: 'x', iv: 'y', tag: 'z' }),
  findConnectionsByStore: vi.fn(),
  findPullConnectionsToReconcile: vi.fn(),
  findPushConnections: vi.fn(),
  disconnectConnection: vi.fn(),
  recordConnectionWebhookRegistration: vi.fn(),
  findConnectionWebhookFailures: vi.fn().mockResolvedValue(new Map()),
  touchConnectionLastSync: vi.fn(),
  updateSyncSettings: vi.fn(),
  upsertConnection: vi.fn(),
}));
vi.mock('../../db/connectors/syncRunRepository.js', () => ({
  insertSyncRun: (...args: unknown[]) => insertSyncRun(...args),
  finishSyncRun: (...args: unknown[]) => finishSyncRun(...args),
}));
vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingById: (...args: unknown[]) => findListingById(...args),
  findListingBySourceExternalId: (...args: unknown[]) => findListingBySourceExternalId(...args),
  findListingChildren: (...args: unknown[]) => findListingChildren(...args),
  findListingsBySourceConnection: (...args: unknown[]) => findListingsBySourceConnection(...args),
  setListingStatusIfIn: (...args: unknown[]) => setListingStatusIfIn(...args),
  updateListingColumns: (...args: unknown[]) => updateListingColumns(...args),
}));
vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantBySourceInventoryItemId: (...args: unknown[]) =>
    findVariantBySourceInventoryItemId(...args),
  findVariantOptionValues: (...args: unknown[]) => findVariantOptionValues(...args),
  findVariantsByListing: (...args: unknown[]) => findVariantsByListing(...args),
  findVariantsBySourceConnection: (...args: unknown[]) => findVariantsBySourceConnection(...args),
  updateVariant: (...args: unknown[]) => updateVariantColumns(...args),
}));
vi.mock('../../db/catalog/listingExternalRefRepository.js', () => ({
  findExternalRefByListingAndConnection: (...args: unknown[]) =>
    findExternalRefByListingAndConnection(...args),
  listingPushedToConnection: (...args: unknown[]) => listingPushedToConnection(...args),
  upsertExternalRef: (...args: unknown[]) => upsertExternalRef(...args),
}));
vi.mock('../../db/catalog/categoryRepository.js', () => ({
  categorySlugExists: (...args: unknown[]) => categorySlugExists(...args),
}));
vi.mock('../../db/merchandising/collectionRepository.js', () => ({
  setListingAutomatedMemberships: (...args: unknown[]) => setListingAutomatedMemberships(...args),
}));
vi.mock('../../db/stores/locationRepository.js', () => ({
  findLocation: (...args: unknown[]) => findLocation(...args),
}));
vi.mock('../catalog-write.service.js', () => ({
  createStoreProduct: (...args: unknown[]) => createStoreProduct(...args),
  updateListing: (...args: unknown[]) => updateListing(...args),
  updateVariant: (...args: unknown[]) => updateVariant(...args),
  resolveDefaultLocationId: (...args: unknown[]) => resolveDefaultLocationId(...args),
}));
vi.mock('../inventory.service.js', () => ({
  setAvailable: (...args: unknown[]) => setAvailable(...args),
}));
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
vi.mock('../../lib/connector-crypto.js', () => ({
  encryptSecret: vi.fn(),
  decryptSecret: (...args: unknown[]) => decryptSecret(...args),
}));
vi.mock('../../connectors/registry.js', () => ({
  getConnectorProvider: (...args: unknown[]) => getConnectorProvider(...args),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { runBackfill } from '../connector-sync.service.js';

const STORE_ID = 'store-1';
const CONNECTION_ID = 'conn-1';

/**
 * The row `insertSyncRun` hands back when a run is opened — the four tallies at
 * zero, because the service holds the running counts itself and only writes them
 * once, at the close.
 */
function openedRun(connectionId: string, kind: string) {
  return {
    id: 'run-1',
    connectionId,
    kind,
    status: 'running',
    countsCreated: 0,
    countsUpdated: 0,
    countsSkipped: 0,
    countsFailed: 0,
    startedAt: new Date(),
    finishedAt: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * The row `finishSyncRun` hands back — built from the outcome the service passed,
 * exactly as the repository builds it from the columns it just wrote. Reading the
 * returned run therefore reads what the service DECIDED, which is what the
 * mutated Mongoose document used to carry.
 */
function finishedRun(
  runId: string,
  outcome: { status: string; counts: SyncRunCounts; failure?: unknown },
) {
  return {
    ...openedRun(CONNECTION_ID, 'backfill'),
    id: runId,
    status: outcome.status,
    countsCreated: outcome.counts.created,
    countsUpdated: outcome.counts.updated,
    countsSkipped: outcome.counts.skipped,
    countsFailed: outcome.counts.failed,
    finishedAt: new Date(),
    // The REAL classifier, because this row stands for what `finishSyncRun`
    // writes and that function composes the message itself (#292). Spelling it
    // `outcome.failure` as a string here would make the mock a second, kinder
    // implementation of the one rule the column has.
    error:
      outcome.failure === undefined ? null : merchantFacingFailureMessage(outcome.failure),
  };
}

/**
 * A connected Shopify pull connection with the given conflict policy.
 *
 * FLAT columns: the embedded `syncSettings` sub-document is eight `sync_settings_*`
 * columns, and the credential envelope is not on the row at all — `hasCredentials`
 * is the derived presence flag the push/disconnect paths read, and the envelope
 * itself only ever arrives through `findConnectionCredentials`.
 */
function mockConnection(conflictPolicy: 'respect_overrides' | 'connector_wins' = 'respect_overrides') {
  return {
    id: CONNECTION_ID,
    storeId: STORE_ID,
    provider: 'shopify' as const,
    mode: 'pull' as const,
    status: 'connected' as const,
    hasCredentials: true,
    shopDomain: 'acme.myshopify.com',
    shopCurrency: 'USD',
    scopes: [],
    webhookIds: [],
    syncSettingsProducts: 'pull' as const,
    syncSettingsInventory: 'off' as const,
    syncSettingsOrders: 'off' as const,
    syncSettingsAutoPublish: true,
    syncSettingsConflictPolicy: conflictPolicy,
    syncSettingsTargetLocationId: null,
    syncSettingsPriceRulesMarkupPercent: null,
    syncSettingsPriceRulesRounding: null,
    syncSettingsCollectionMapping: null,
  };
}

/** A canned normalized product. */
function product(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    externalId: 'shopify-1',
    externalUpdatedAt: new Date('2026-07-12T00:00:00Z'),
    title: 'Imported Title',
    description: 'Imported description',
    handle: 'imported',
    vendor: 'Acme',
    productType: 'Widget',
    options: [],
    imageUrls: ['https://cdn.shopify.com/img.jpg'],
    variants: {
      enumeration: 'complete',
      variants: [{ optionValues: [], price: { amount: 1999, currency: 'USD' }, inventory: { tracked: true, available: 3 } }],
    },
    ...overrides,
  };
}

/**
 * A `listings` row as the repositories return it: FLAT, with the columns the
 * import merge and the reconcile sweep read.
 */
function listingRow(
  id: string,
  overrides: { sourceExternalId?: string; overriddenFields?: string[]; status?: string } = {},
): unknown {
  return {
    id,
    storeId: STORE_ID,
    status: overrides.status ?? 'active',
    sourceConnectionId: CONNECTION_ID,
    sourceProvider: 'shopify',
    sourceExternalId: overrides.sourceExternalId ?? 'shopify-1',
    overriddenFields: overrides.overriddenFields ?? [],
  };
}

/**
 * Answer the provenance lookup per external id.
 *
 * The import path and the archive path both resolve a listing through
 * `findListingBySourceExternalId` now — Mongo used a `findOne` for the import and
 * a provenance-FILTERED `updateOne` for the archive, so they were two different
 * mocks — which is why a single `mockResolvedValue` cannot serve both.
 */
function stubListingsByExternalId(rows: Record<string, unknown>): void {
  findListingBySourceExternalId.mockImplementation((_storeId, _connectionId, externalId) =>
    Promise.resolve(rows[externalId] ?? null),
  );
}

/**
 * A driver unique-violation as postgres.js surfaces one, for the ONE branch a
 * real server cannot be made to produce on demand: losing the provenance-unique
 * race (#221), which needs a concurrent writer between this service's read and
 * its insert.
 *
 * A synthetic error proves the BRANCH is reachable and nothing about whether
 * `isUniqueViolation` reads a real one correctly — the repo's own warning about
 * a `{code:'23505'}` fixture. That half is proven against a REAL server in
 * `connector-import-atomicity.realdb.test.ts`, which catches an actual refusal
 * from `listings_store_id_source_key_idx` and asserts the same predicate. The
 * two halves are deliberately in different files, each where it can be true.
 */
function uniqueViolation(constraintName: string): Error {
  const cause = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint_name: constraintName,
  });
  return Object.assign(new Error('Failed query'), { cause });
}

/** The `updateListingColumns` patch carrying the provenance columns, if any. */
function provenancePatch(): Record<string, unknown> | undefined {
  const call = updateListingColumns.mock.calls.find(([, patch]) => 'sourceExternalId' in patch);
  return call?.[1];
}

/**
 * The provenance the CREATE path handed `createStoreProduct`, if any.
 *
 * #221: a created listing's four `source_*` columns are written by the listing's
 * own insert, so they are an ARGUMENT here rather than a later patch. That is
 * the whole fix, which is why the create-path cases read this and the update
 * path still reads {@link provenancePatch}.
 */
function createdProvenance(): Record<string, unknown> | undefined {
  const call = createStoreProduct.mock.calls[0];
  return (call?.[2] as { source?: Record<string, unknown> } | undefined)?.source;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONNECTOR_DEFAULT_CATEGORY_SLUG = 'home';
  categorySlugExists.mockResolvedValue(true);
  decryptSecret.mockReturnValue(JSON.stringify({ accessToken: 'shpat_test' }));
  insertSyncRun.mockImplementation((connectionId: string, kind: string) =>
    Promise.resolve(openedRun(connectionId, kind)),
  );
  finishSyncRun.mockImplementation(
    (runId: string, outcome: { status: string; counts: SyncRunCounts; failure?: unknown }) =>
      Promise.resolve(finishedRun(runId, outcome)),
  );
  markConnectionSynced.mockResolvedValue(undefined);
  markConnectionError.mockResolvedValue(undefined);
  updateListingColumns.mockResolvedValue(null);
  setListingStatusIfIn.mockResolvedValue(true);
  // No push-mirror by default (the echo-skip lookup finds nothing).
  listingPushedToConnection.mockResolvedValue(false);
  // Delete-reconciliation read: no sourced listings by default (no archives).
  findListingsBySourceConnection.mockResolvedValue([]);
  // Re-price read: no existing variants by default (no re-pricing).
  findVariantsByListing.mockResolvedValue([]);
  findVariantOptionValues.mockResolvedValue(new Map());
  getConnectorProvider.mockReturnValue({ fetchProducts: (...a: unknown[]) => fetchProducts(...a) });
});

describe('runBackfill — create path', () => {
  it('creates a new store product and stamps its connector provenance', async () => {
    findConnection.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(createStoreProduct).toHaveBeenCalledTimes(1);
    const [storeArg, input] = createStoreProduct.mock.calls[0];
    expect(storeArg).toBe(STORE_ID);
    expect(input.category).toBe('home');
    expect(input.variants[0].price).toEqual({ amount: 1999, currency: 'USD' });

    // #221: the provenance goes INTO the create, so the listing's own insert
    // writes it. The old assertion read it off a second `updateListingColumns`
    // statement, which is precisely the window that stranded a listing —
    // unmatchable forever and still holding its handle. `autoPublish` is true
    // for this connection, so the status is `active`.
    expect(createdProvenance()).toEqual({
      sourceConnectionId: CONNECTION_ID,
      sourceProvider: 'shopify',
      sourceExternalId: 'shopify-1',
      sourceExternalUpdatedAt: new Date('2026-07-12T00:00:00Z'),
    });
    expect(createStoreProduct.mock.calls[0][2]).toMatchObject({ status: 'active' });
    // And NOTHING patches the provenance afterwards on the create path: a second
    // statement is what this fix removed, so its absence is the assertion.
    expect(provenancePatch()).toBeUndefined();

    expect(run.status).toBe('completed');
    expect(run.countsCreated).toBe(1);
    expect(updateListing).not.toHaveBeenCalled();
  });

  it('holds a created listing as draft when the connection does not auto-publish', async () => {
    findConnection.mockResolvedValue({ ...mockConnection(), syncSettingsAutoPublish: false });
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product()] });

    await runBackfill(STORE_ID, CONNECTION_ID);

    // #221: `draft` rides the same insert as the provenance. It used to be part
    // of the same second statement, so the same failure published a listing the
    // merchant had asked to hold back — or, more often, stranded it entirely.
    expect(createStoreProduct.mock.calls[0][2]).toMatchObject({ status: 'draft' });
    expect(provenancePatch()).toBeUndefined();
  });

  it('stamps every VARIANT with its provenance through the create', async () => {
    findConnection.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({
      products: [
        product({
          variants: {
            enumeration: 'complete',
            variants: [
              {
                optionValues: [],
                price: { amount: 1999, currency: 'USD' },
                inventory: { tracked: true, available: 3 },
                externalVariantId: 'v1',
                externalInventoryItemId: 'inv1',
              },
              // A second variant the platform gave NO ids for: stamped all-NULL
              // rather than given the connection, because it is unfindable by
              // either key and recording the connection would claim a link
              // nothing can follow.
              {
                optionValues: [],
                price: { amount: 2999, currency: 'USD' },
                inventory: { tracked: true, available: 1 },
              },
            ],
          },
        }),
      ],
    });

    await runBackfill(STORE_ID, CONNECTION_ID);

    // #221: `stampVariantSources` — a post-create UPDATE pass — is GONE, so this
    // is an argument now. `updateVariantColumns` must not be reached on the
    // create path at all; its absence is what says the pass was removed rather
    // than merely duplicated.
    expect(createStoreProduct.mock.calls[0][2]).toMatchObject({
      variantSources: [
        {
          sourceConnectionId: CONNECTION_ID,
          sourceProvider: 'shopify',
          sourceExternalVariantId: 'v1',
          sourceExternalInventoryItemId: 'inv1',
        },
        {
          sourceConnectionId: null,
          sourceProvider: null,
          sourceExternalVariantId: null,
          sourceExternalInventoryItemId: null,
        },
      ],
    });
    expect(updateVariantColumns).not.toHaveBeenCalled();
  });

  it('CONVERGES on the update path when the provenance unique refuses the create', async () => {
    // The #221 retry-by-lookup, and the only test that reaches that catch: the
    // service read null, another delivery created the row underneath it, and the
    // insert lost `listings_store_id_source_key_idx`. The loser must re-read and
    // converge rather than fail the product.
    findConnection.mockResolvedValue(mockConnection());
    const winner = listingRow('listing-winner');
    // Null on the FIRST read (the create branch is entered) and the winner's row
    // on the re-read inside the catch.
    findListingBySourceExternalId
      .mockResolvedValueOnce(null)
      .mockResolvedValue(winner);
    createStoreProduct.mockRejectedValue(
      uniqueViolation('listings_store_id_source_key_idx'),
    );
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(run.countsFailed).toBe(0);
    expect(run.countsCreated).toBe(0);
    expect(run.countsUpdated).toBe(1);
    expect(updateListing).toHaveBeenCalledTimes(1);
    expect(updateListing.mock.calls[0][0]).toBe('listing-winner');
  });

  it('does NOT swallow a HANDLE collision — that is a real merchant conflict', async () => {
    // The discriminant on the catch above. Naming the constraint is what keeps
    // `listings_store_id_handle_key` surfacing as a per-product failure: two
    // genuinely different external products claiming one handle is a conflict a
    // merchant has to see, and converging it would silently attach this product's
    // updates to the other one's listing.
    findConnection.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockRejectedValue(uniqueViolation('listings_store_id_handle_key'));
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(run.countsFailed).toBe(1);
    expect(run.countsUpdated).toBe(0);
    expect(updateListing).not.toHaveBeenCalled();
  });

  it('writes an explicit NULL when the platform reports no externalUpdatedAt', async () => {
    // Behaviour change worth pinning: assigning the embedded `source` simply left
    // the key out, keeping the PREVIOUS sync's timestamp on a product whose
    // source had stopped reporting one. A flat column is written either way.
    findConnection.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product({ externalUpdatedAt: undefined })] });

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(createdProvenance()).toMatchObject({ sourceExternalUpdatedAt: null });
  });

  it('skips an inbound product that is an echo of our own push (loop prevention)', async () => {
    findConnection.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    // The push mirror moved from an embedded `externalRefs` array to its own
    // table; the echo check is the repository predicate over it.
    listingPushedToConnection.mockResolvedValue(true);
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(listingPushedToConnection).toHaveBeenCalledWith(STORE_ID, CONNECTION_ID, 'shopify-1');
    expect(createStoreProduct).not.toHaveBeenCalled();
    expect(run.countsSkipped).toBe(1);
  });
});

describe('runBackfill — update path respects overriddenFields', () => {
  it('skips a locally-pinned field but overwrites the rest', async () => {
    findConnection.mockResolvedValue(mockConnection('respect_overrides'));
    findListingBySourceExternalId.mockResolvedValue(
      listingRow('listing-existing', { overriddenFields: ['title'] }),
    );
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(createStoreProduct).not.toHaveBeenCalled();
    expect(updateListing).toHaveBeenCalledTimes(1);
    const [listingId, patch] = updateListing.mock.calls[0];
    expect(listingId).toBe('listing-existing');
    // Pinned title is NOT written; description + images (etc.) are.
    expect(patch.title).toBeUndefined();
    expect(patch.description).toBe('Imported description');
    expect(patch.imageFileIds).toEqual(['https://cdn.shopify.com/img.jpg']);
    expect(run.countsUpdated).toBe(1);
  });

  it('counts a product as skipped when every managed field is pinned', async () => {
    findConnection.mockResolvedValue(mockConnection('respect_overrides'));
    findListingBySourceExternalId.mockResolvedValue(
      listingRow('listing-existing', {
        overriddenFields: ['title', 'description', 'images', 'vendor', 'productType', 'handle', 'seo'],
      }),
    );
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateListing).not.toHaveBeenCalled();
    expect(run.countsSkipped).toBe(1);
    // Provenance (externalUpdatedAt) is still refreshed.
    expect(provenancePatch()).toMatchObject({ sourceExternalId: 'shopify-1' });
  });

  it('connector_wins overwrites even locally-edited fields', async () => {
    findConnection.mockResolvedValue(mockConnection('connector_wins'));
    findListingBySourceExternalId.mockResolvedValue(
      listingRow('listing-existing', { overriddenFields: ['title'] }),
    );
    fetchProducts.mockResolvedValue({ products: [product()] });

    await runBackfill(STORE_ID, CONNECTION_ID);

    const [, patch] = updateListing.mock.calls[0];
    expect(patch.title).toBe('Imported Title');
  });
});

describe('runBackfill — paging + guards', () => {
  it('follows the provider cursor across pages', async () => {
    findConnection.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-x');
    fetchProducts
      .mockResolvedValueOnce({ products: [product({ externalId: 'p1' })], nextCursor: 'CURSOR2' })
      .mockResolvedValueOnce({ products: [product({ externalId: 'p2' })] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(fetchProducts).toHaveBeenCalledTimes(2);
    expect(fetchProducts.mock.calls[1][1]).toBe('CURSOR2');
    expect(run.countsCreated).toBe(2);
  });

  it('rejects when product pull is disabled for the connection', async () => {
    findConnection.mockResolvedValue({ ...mockConnection(), syncSettingsProducts: 'off' as const });

    await expect(runBackfill(STORE_ID, CONNECTION_ID)).rejects.toThrow(/not enabled/);
    expect(insertSyncRun).not.toHaveBeenCalled();
  });

  it('records a failed run (does not throw) when a page fetch fails mid-run', async () => {
    findConnection.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    // What the provider ACTUALLY throws: every connector transport raises a
    // `validationError`, and a bare `Error` here would make this case assert that
    // an unclassified message reaches the merchant — which is the thing #292
    // stopped.
    fetchProducts.mockRejectedValue(validationError('shopify 500'));

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(run.status).toBe('failed');
    expect(run.error).toContain('shopify 500');
  });
});

// --- Fix 1: re-price existing variants on the update path --------------------

/**
 * A connected pull connection whose `priceRules` apply a markup.
 *
 * The embedded `priceRules` object is two independently-nullable columns, so a
 * markup-only rule is a MARKUP column with a NULL rounding — a state the embedded
 * form could not distinguish from `{ markupPercent, rounding: undefined }`, and
 * the reason the service rebuilds the object rather than reading it.
 */
function mockConnectionWithMarkup(markupPercent: number) {
  return {
    ...mockConnection('respect_overrides'),
    syncSettingsPriceRulesMarkupPercent: markupPercent,
    syncSettingsPriceRulesRounding: null,
  };
}

/**
 * An existing `product_variants` row as `repriceExistingVariants` reads it.
 *
 * `price` was ONE embedded object; it is two NULLABLE columns here, so a fixture
 * states `priceAmount`/`priceCurrency` separately — and a variant with neither is
 * now representable (see the null-price case below).
 */
function existingVariant(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'v1',
    listingId: 'listing-existing',
    sku: null,
    priceAmount: 1999,
    priceCurrency: 'USD',
    compareAtPriceAmount: null,
    compareAtPriceCurrency: null,
    inventoryTracked: true,
    inventoryAvailable: 3,
    ...overrides,
  };
}

/**
 * Point the re-price read at the given variant rows.
 *
 * `optionValues` is a CHILD TABLE now, loaded once for the whole listing rather
 * than embedded in each variant, so the stub answers both reads: the variants and
 * their option-value map (empty here — these fixtures match by SKU or by the
 * empty option tuple).
 */
function stubExistingVariants(variants: unknown[]): void {
  findVariantsByListing.mockResolvedValue(variants);
  findVariantOptionValues.mockResolvedValue(new Map());
}

describe('runBackfill — Fix 1: re-prices existing variants', () => {
  it('applies the connection price rules and updates a variant whose price changed', async () => {
    findConnection.mockResolvedValue(mockConnectionWithMarkup(100)); // ×2
    findListingBySourceExternalId.mockResolvedValue(listingRow('listing-existing'));
    stubExistingVariants([existingVariant()]); // stored at 1999
    fetchProducts.mockResolvedValue({ products: [product()] }); // incoming 1999 → ×2 = 3998

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateVariant).toHaveBeenCalledTimes(1);
    const [listingId, variantId, patch] = updateVariant.mock.calls[0];
    expect(listingId).toBe('listing-existing');
    expect(variantId).toBe('v1');
    expect(patch.price).toEqual({ amount: 3998, currency: 'USD' });
    expect(run.countsUpdated).toBe(1);
  });

  it('re-prices even when every listing field is pinned — counts the product as updated', async () => {
    findConnection.mockResolvedValue(mockConnectionWithMarkup(100));
    // All connector-managed LISTING fields pinned (so the listing patch is empty),
    // but `price` is NOT pinned — the re-price alone must bump the outcome to updated.
    findListingBySourceExternalId.mockResolvedValue(
      listingRow('listing-existing', {
        overriddenFields: ['title', 'description', 'images', 'vendor', 'productType', 'handle', 'seo'],
      }),
    );
    stubExistingVariants([existingVariant()]);
    fetchProducts.mockResolvedValue({ products: [product()] });

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateListing).not.toHaveBeenCalled(); // listing patch was empty
    expect(updateVariant).toHaveBeenCalledTimes(1);
    expect(run.countsUpdated).toBe(1);
    expect(run.countsSkipped).toBe(0);
  });

  it('skips re-pricing when `price` is pinned in overriddenFields', async () => {
    findConnection.mockResolvedValue(mockConnectionWithMarkup(100));
    findListingBySourceExternalId.mockResolvedValue(
      listingRow('listing-existing', { overriddenFields: ['price'] }),
    );
    // Even if a differing variant existed, the pin short-circuits before reading.
    stubExistingVariants([existingVariant()]);
    fetchProducts.mockResolvedValue({ products: [product()] });

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateVariant).not.toHaveBeenCalled();
    expect(findVariantsByListing).not.toHaveBeenCalled();
  });

  it('is a no-op when the incoming price already matches the stored price', async () => {
    findConnection.mockResolvedValue(mockConnection('respect_overrides')); // no markup
    findListingBySourceExternalId.mockResolvedValue(listingRow('listing-existing'));
    stubExistingVariants([existingVariant({ priceAmount: 1999, priceCurrency: 'USD' })]);
    fetchProducts.mockResolvedValue({ products: [product()] }); // incoming also 1999

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateVariant).not.toHaveBeenCalled();
  });

  it('prices a variant that has NO stored price at all — a state Mongo could not hold', async () => {
    // `price` was required on the Mongoose model; both of its columns are nullable
    // here. NULL must differ from every incoming amount, so the first re-sync
    // prices the variant rather than leaving it priceless.
    findConnection.mockResolvedValue(mockConnection('respect_overrides'));
    findListingBySourceExternalId.mockResolvedValue(listingRow('listing-existing'));
    stubExistingVariants([existingVariant({ priceAmount: null, priceCurrency: null })]);
    fetchProducts.mockResolvedValue({ products: [product()] });

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateVariant).toHaveBeenCalledTimes(1);
    const [, , patch] = updateVariant.mock.calls[0];
    expect(patch.price).toEqual({ amount: 1999, currency: 'USD' });
  });

  it('matches variants by SKU when the option tuples are ambiguous', async () => {
    findConnection.mockResolvedValue(mockConnectionWithMarkup(0)); // no price change from rules
    findListingBySourceExternalId.mockResolvedValue(listingRow('listing-existing'));
    // Stored variant keyed by SKU, at a price the incoming product will change.
    stubExistingVariants([existingVariant({ id: 'v-sku', sku: 'ABC', priceAmount: 1000 })]);
    fetchProducts.mockResolvedValue({
      products: [
        product({
          variants: {
            enumeration: 'complete',
            variants: [{ optionValues: [], sku: 'ABC', price: { amount: 2500, currency: 'USD' }, inventory: { tracked: true, available: 1 } }],
          },
        }),
      ],
    });

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(updateVariant).toHaveBeenCalledTimes(1);
    const [, variantId, patch] = updateVariant.mock.calls[0];
    expect(variantId).toBe('v-sku');
    expect(patch.price).toEqual({ amount: 2500, currency: 'USD' });
  });
});

// --- Fix 3: delete reconciliation in backfill -------------------------------

/**
 * The listing ids `setListingStatusIfIn` was asked to archive.
 *
 * The old helper read `filter['source.externalId']` off the archiving
 * `Listing.updateOne`, because the provenance key WAS the update's filter. The
 * archive is a two-step now (resolve by provenance, then a conditional status
 * write by id), so the archived set is identified by listing id — and the
 * external ids it came from are pinned by the `findListingBySourceExternalId`
 * calls asserted alongside.
 */
function archivedListingIds(): string[] {
  return setListingStatusIfIn.mock.calls
    .filter(([, next]) => next === 'archived')
    .map(([listingId]) => listingId);
}

describe('runBackfill — Fix 3: delete reconciliation', () => {
  it('archives a sourced listing NOT seen in a fully-completed backfill', async () => {
    findConnection.mockResolvedValue(mockConnection());
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product({ externalId: 'p1' })] }); // full: no cursor
    // p1 is unknown (create path); p2 is stale → must be archived.
    stubListingsByExternalId({ p2: listingRow('l2', { sourceExternalId: 'p2' }) });
    findListingsBySourceConnection.mockResolvedValue([
      listingRow('l1', { sourceExternalId: 'p1' }),
      listingRow('l2', { sourceExternalId: 'p2' }),
    ]);

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(findListingsBySourceConnection).toHaveBeenCalledWith(STORE_ID, CONNECTION_ID);
    expect(archivedListingIds()).toEqual(['l2']); // only the unseen id
    // #390: the unseen sweep records its OWN cause, not the delete webhook's.
    // Both are undone by a republish, so the distinction costs nothing here and
    // is what an operator reads to know which path archived a listing.
    expect(setListingStatusIfIn).toHaveBeenCalledWith(
      'l2',
      'archived',
      ALL_LISTING_STATUSES,
      'connector_unseen_in_backfill',
    );
    expect(run.status).toBe('completed');
    expect(run.countsCreated).toBe(1); // p1
    expect(run.countsUpdated).toBe(1); // the archive of p2
  });

  it('does NOT archive on a partial/failed fetch (guards against mass-archive)', async () => {
    findConnection.mockResolvedValue(mockConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');
    // First page ok (has a next cursor), second page fetch FAILS → partial fetch.
    fetchProducts
      .mockResolvedValueOnce({ products: [product({ externalId: 'p1' })], nextCursor: 'C2' })
      .mockRejectedValueOnce(new Error('shopify 500'));

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(run.status).toBe('failed');
    // The reconcile read is never even issued on a partial fetch.
    expect(findListingsBySourceConnection).not.toHaveBeenCalled();
    expect(archivedListingIds()).toEqual([]);
  });

  it('respects a pinned status — an unseen but status-pinned listing is not archived', async () => {
    findConnection.mockResolvedValue(mockConnection('respect_overrides'));
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product({ externalId: 'p1' })] });
    stubListingsByExternalId({ p2: listingRow('l2', { sourceExternalId: 'p2' }) });
    findListingsBySourceConnection.mockResolvedValue([
      listingRow('l2', { sourceExternalId: 'p2', overriddenFields: ['status'] }),
    ]);

    await runBackfill(STORE_ID, CONNECTION_ID);

    expect(archivedListingIds()).toEqual([]);
  });

  it('never re-archives an ALREADY-archived sourced listing', async () => {
    // The repository read is deliberately status-agnostic (the Mongo query filtered
    // `status: { $ne: 'archived' }` itself), so the service filters — and this is
    // what keeps a nightly reconcile from re-counting yesterday's archives.
    findConnection.mockResolvedValue(mockConnection());
    createStoreProduct.mockResolvedValue('listing-new');
    fetchProducts.mockResolvedValue({ products: [product({ externalId: 'p1' })] });
    stubListingsByExternalId({ p2: listingRow('l2', { sourceExternalId: 'p2', status: 'archived' }) });
    findListingsBySourceConnection.mockResolvedValue([
      listingRow('l2', { sourceExternalId: 'p2', status: 'archived' }),
    ]);

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(archivedListingIds()).toEqual([]);
    expect(run.countsUpdated).toBe(0);
  });

  it('archives ALL sourced listings when the platform catalog is now empty', async () => {
    findConnection.mockResolvedValue(mockConnection());
    fetchProducts.mockResolvedValue({ products: [] }); // full fetch, zero products
    stubListingsByExternalId({
      'gone-1': listingRow('l1', { sourceExternalId: 'gone-1' }),
      'gone-2': listingRow('l2', { sourceExternalId: 'gone-2' }),
    });
    findListingsBySourceConnection.mockResolvedValue([
      listingRow('l1', { sourceExternalId: 'gone-1' }),
      listingRow('l2', { sourceExternalId: 'gone-2' }),
    ]);

    const run = await runBackfill(STORE_ID, CONNECTION_ID);

    expect(archivedListingIds()).toEqual(['l1', 'l2']);
    expect(findListingBySourceExternalId.mock.calls.map(([, , externalId]) => externalId)).toEqual([
      'gone-1',
      'gone-2',
    ]);
    expect(run.status).toBe('completed');
    expect(run.countsUpdated).toBe(2);
  });
});
