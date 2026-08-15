/**
 * Unit tests for `channel-ingest.service` — the `push_in` receive side.
 *
 * No DB / no network. EVERY store this service touches is mocked at the
 * REPOSITORY boundary — connections and sync runs alongside the listing/variant
 * reads and the provenance write — so each stub is a plain async function
 * returning rows, with no query chains anywhere. The catalog-write funnels, the
 * inventory service and the shared connector-sync resolvers are mocked too.
 *
 * The tests drive the service with `IngestProduct`/inventory DTOs and assert: the
 * create path (+ provenance + draft), the override-respecting merge, the
 * all-pinned "skipped" path, `connector_wins`, per-item failure isolation,
 * idempotency (same externalId twice never double-creates), cross-store isolation
 * + the non-push_in rejection, connect-push upsert/conflict, and the inventory
 * mapping (single-variant, by-SKU, unmapped skip).
 *
 * Provenance is FOUR FLAT COLUMNS now (`sourceConnectionId`, `sourceProvider`,
 * `sourceExternalId`, `sourceExternalUpdatedAt`) applied with
 * `updateListingColumns`, not a `$set: { source: {...} }` sub-document — and the
 * timestamp is written explicitly `null` when the platform sends none, which the
 * embedded version could not express (it left the key out, silently keeping the
 * previous push's value). Both are pinned below.
 *
 * A connection is FLAT columns too, `connectPushIn` is ONE upsert on
 * `UNIQUE(store_id, provider)` rather than a read-then-upsert pair, and a
 * `SyncRun` is opened and closed in two statements instead of being mutated in
 * memory — so the run's outcome is read off `finishSyncRun`'s argument.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  IngestInventoryInput,
  IngestProduct,
  IngestProductsInput,
  SyncRunCounts,
} from '@mercaria/shared-types';

const findConnection = vi.fn();
const findConnectionByProvider = vi.fn();
const upsertConnection = vi.fn();
const touchConnectionLastSync = vi.fn();
const insertSyncRun = vi.fn();
const finishSyncRun = vi.fn();
const findListingBySourceExternalId = vi.fn();
const updateListingColumns = vi.fn();
const findVariantsByListingAndSku = vi.fn();
const findVariantsByListing = vi.fn();
const createStoreProduct = vi.fn();
const updateListing = vi.fn();
const setAvailable = vi.fn();
const resolveImportCategorySlug = vi.fn();
const resolveImportLocationId = vi.fn();
const resolveInventoryLocationId = vi.fn();
const toPriceRules = vi.fn();

vi.mock('../../db/connectors/connectionRepository.js', () => ({
  findConnection: (...args: unknown[]) => findConnection(...args),
  findConnectionByProvider: (...args: unknown[]) => findConnectionByProvider(...args),
  upsertConnection: (...args: unknown[]) => upsertConnection(...args),
  touchConnectionLastSync: (...args: unknown[]) => touchConnectionLastSync(...args),
}));
vi.mock('../../db/connectors/syncRunRepository.js', () => ({
  insertSyncRun: (...args: unknown[]) => insertSyncRun(...args),
  finishSyncRun: (...args: unknown[]) => finishSyncRun(...args),
}));
vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingBySourceExternalId: (...args: unknown[]) => findListingBySourceExternalId(...args),
  updateListingColumns: (...args: unknown[]) => updateListingColumns(...args),
}));
vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantsByListingAndSku: (...args: unknown[]) => findVariantsByListingAndSku(...args),
  findVariantsByListing: (...args: unknown[]) => findVariantsByListing(...args),
}));
vi.mock('../catalog-write.service.js', () => ({
  createStoreProduct: (...args: unknown[]) => createStoreProduct(...args),
  updateListing: (...args: unknown[]) => updateListing(...args),
}));
vi.mock('../inventory.service.js', () => ({
  setAvailable: (...args: unknown[]) => setAvailable(...args),
}));
vi.mock('../connector-sync.service.js', () => ({
  resolveImportCategorySlug: (...args: unknown[]) => resolveImportCategorySlug(...args),
  resolveImportLocationId: (...args: unknown[]) => resolveImportLocationId(...args),
  resolveInventoryLocationId: (...args: unknown[]) => resolveInventoryLocationId(...args),
  // The price transform is shared with the pull side (one implementation reading
  // the same two columns), so it is stubbed here alongside the other resolvers;
  // its own behaviour is pinned by the pull-side suite.
  toPriceRules: (...args: unknown[]) => toPriceRules(...args),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  connectPushIn,
  ingestInventory,
  ingestProducts,
  isKnownConnectorProvider,
} from '../channel-ingest.service.js';
import { conflict } from '../../lib/errors/error-codes.js';
import { MERCHANT_FACING_MESSAGE_MAX_LENGTH } from '../../lib/errors/merchant-facing.js';

const STORE_ID = 'store-1';
const CONNECTION_ID = 'conn-1';

/**
 * The outcome the service reported when it CLOSED the run.
 *
 * A run is opened and then closed in two statements now, so the tallies and the
 * status the service computed live in `finishSyncRun`'s argument — what the old
 * tests read off the document they had watched the service mutate.
 */
function closedRun(): { status: string; counts: SyncRunCounts } {
  const call = finishSyncRun.mock.calls[0] as
    | [string, { status: string; counts: SyncRunCounts }]
    | undefined;
  if (!call) {
    throw new Error('the run was never closed');
  }
  return call[1];
}

/**
 * A connected `push_in` WooCommerce connection with the given conflict policy —
 * FLAT columns, the embedded `syncSettings` sub-document having become eight of
 * them, with the two `priceRules` halves independently nullable.
 */
function pushInConnection(
  overrides: {
    mode?: 'pull' | 'push_in';
    conflictPolicy?: 'respect_overrides' | 'connector_wins';
    autoPublish?: boolean;
  } = {},
) {
  return {
    id: CONNECTION_ID,
    storeId: STORE_ID,
    provider: 'woocommerce' as const,
    mode: overrides.mode ?? ('push_in' as const),
    status: 'connected' as const,
    hasCredentials: false,
    syncSettingsProducts: 'off' as const,
    syncSettingsInventory: 'off' as const,
    syncSettingsOrders: 'off' as const,
    syncSettingsAutoPublish: overrides.autoPublish ?? false,
    syncSettingsConflictPolicy: overrides.conflictPolicy ?? ('respect_overrides' as const),
    syncSettingsPriceRulesMarkupPercent: null,
    syncSettingsPriceRulesRounding: null,
    syncSettingsCollectionMapping: null,
    syncSettingsTargetLocationId: null,
  };
}

/** A canned ingest product. */
function ingestProduct(overrides: Partial<IngestProduct> = {}): IngestProduct {
  return {
    externalId: 'woo-1',
    externalUpdatedAt: '2026-07-12T00:00:00Z',
    title: 'Woo Title',
    description: 'Woo description',
    images: ['https://cdn.woo.com/img.jpg'],
    options: [],
    variants: [
      { optionValues: [], price: { amount: 2500, currency: 'EUR' }, inventory: { available: 5 }, sku: 'SKU-1' },
    ],
    vendor: 'Acme',
    productType: 'Widget',
    handle: 'woo-title',
    ...overrides,
  };
}

/**
 * A `listings` row as `findListingBySourceExternalId` returns it — flat, with the
 * two columns the ingest merge reads.
 */
function sourcedListingRow(id: string, overriddenFields: string[] = []): unknown {
  return {
    id,
    storeId: STORE_ID,
    status: 'active',
    sourceConnectionId: CONNECTION_ID,
    sourceProvider: 'woocommerce',
    sourceExternalId: 'woo-1',
    overriddenFields,
  };
}

/** The `updateListingColumns` patch that carries the provenance columns. */
function provenancePatch(): Record<string, unknown> | undefined {
  const call = updateListingColumns.mock.calls.find(([, patch]) => 'sourceExternalId' in patch);
  return call?.[1];
}

/**
 * The provenance the CREATE path handed `createStoreProduct`, if any.
 *
 * #221: the push-in path had the pull path's create-then-stamp window, and the
 * fix is the same — the four `source_*` columns and the initial status are
 * arguments to the create, written by the listing's own insert. The update path
 * still patches, so it still reads {@link provenancePatch}.
 */
function createdProvenance(): Record<string, unknown> | undefined {
  const call = createStoreProduct.mock.calls[0];
  return (call?.[2] as { source?: Record<string, unknown> } | undefined)?.source;
}

const productsBody = (products: IngestProduct[]): IngestProductsInput => ({ products });

beforeEach(() => {
  vi.clearAllMocks();
  resolveImportCategorySlug.mockResolvedValue('home');
  insertSyncRun.mockImplementation((connectionId: string, kind: string) =>
    Promise.resolve({ id: 'run-1', connectionId, kind }),
  );
  finishSyncRun.mockResolvedValue({ id: 'run-1' });
  touchConnectionLastSync.mockResolvedValue(undefined);
  updateListingColumns.mockResolvedValue(null);
  resolveImportLocationId.mockResolvedValue(undefined);
  resolveInventoryLocationId.mockResolvedValue('loc-1');
  // No price rules on these fixtures — both columns NULL means no transform.
  toPriceRules.mockReturnValue(undefined);
  setAvailable.mockResolvedValue(undefined);
});

describe('isKnownConnectorProvider', () => {
  it('accepts the known provider ids and rejects unknowns', () => {
    expect(isKnownConnectorProvider('woocommerce')).toBe(true);
    expect(isKnownConnectorProvider('shopify')).toBe(true);
    expect(isKnownConnectorProvider('bigcommerce')).toBe(false);
    expect(isKnownConnectorProvider('')).toBe(false);
  });
});

describe('ingestProducts — create path', () => {
  it('creates a store product, stamps provenance, holds as draft, and echoes the result', async () => {
    findConnection.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');

    const result = await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));

    expect(createStoreProduct).toHaveBeenCalledTimes(1);
    const [storeArg, input] = createStoreProduct.mock.calls[0];
    expect(storeArg).toBe(STORE_ID);
    expect(input.category).toBe('home');
    expect(input.variants[0].price).toEqual({ amount: 2500, currency: 'EUR' });
    expect(input.variants[0].inventory).toEqual({ tracked: true, available: 5 });

    // #221: provenance + `draft` (autoPublish false) go INTO the create, so the
    // listing's own insert writes them. They used to be a second statement, and
    // a failure between the two left a listing no later push could match and
    // whose handle blocked every re-import.
    expect(createdProvenance()).toEqual({
      sourceConnectionId: CONNECTION_ID,
      sourceProvider: 'woocommerce',
      sourceExternalId: 'woo-1',
      sourceExternalUpdatedAt: new Date('2026-07-12T00:00:00Z'),
    });
    expect(createStoreProduct.mock.calls[0][2]).toMatchObject({ status: 'draft' });
    // Nothing patches the provenance afterwards on the create path — the removal
    // of that second statement IS the fix, so its absence is the assertion.
    expect(provenancePatch()).toBeUndefined();

    expect(result.results).toEqual([{ externalId: 'woo-1', action: 'created', listingId: 'listing-new' }]);
    expect(closedRun().status).toBe('completed');
    expect(closedRun().counts.created).toBe(1);
    expect(updateListing).not.toHaveBeenCalled();
    expect(touchConnectionLastSync).toHaveBeenCalledWith(CONNECTION_ID);
  });

  it('publishes (no draft) when the connection autoPublishes', async () => {
    findConnection.mockResolvedValue(pushInConnection({ autoPublish: true }));
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');

    await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));

    expect(createStoreProduct.mock.calls[0][2]).toMatchObject({ status: 'active' });
  });

  it('writes an explicit NULL when the platform reports no externalUpdatedAt', async () => {
    // Behaviour change worth pinning: the embedded `source` simply omitted the key,
    // so a re-push from a platform that had STOPPED sending a timestamp kept the
    // previous push's value on the listing. A flat column is written either way.
    findConnection.mockResolvedValue(pushInConnection({ autoPublish: true }));
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockResolvedValue('listing-new');

    await ingestProducts(
      STORE_ID,
      CONNECTION_ID,
      productsBody([ingestProduct({ externalUpdatedAt: undefined })]),
    );

    expect(createdProvenance()).toMatchObject({ sourceExternalUpdatedAt: null });
  });
});

describe('ingestProducts — update path respects overriddenFields', () => {
  it('skips a locally-pinned field but overwrites the rest', async () => {
    findConnection.mockResolvedValue(pushInConnection({ conflictPolicy: 'respect_overrides' }));
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-existing', ['title']));

    const result = await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));

    expect(createStoreProduct).not.toHaveBeenCalled();
    expect(updateListing).toHaveBeenCalledTimes(1);
    const [listingId, patch] = updateListing.mock.calls[0];
    expect(listingId).toBe('listing-existing');
    expect(patch.title).toBeUndefined();
    expect(patch.description).toBe('Woo description');
    expect(patch.imageFileIds).toEqual(['https://cdn.woo.com/img.jpg']);
    expect(result.results[0]).toEqual({
      externalId: 'woo-1',
      action: 'updated',
      listingId: 'listing-existing',
    });
  });

  it('counts a product as skipped when every managed field is pinned', async () => {
    findConnection.mockResolvedValue(pushInConnection({ conflictPolicy: 'respect_overrides' }));
    findListingBySourceExternalId.mockResolvedValue(
      sourcedListingRow('listing-existing', [
        'title',
        'description',
        'images',
        'vendor',
        'productType',
        'handle',
        'seo',
      ]),
    );

    const result = await ingestProducts(
      STORE_ID,
      CONNECTION_ID,
      productsBody([ingestProduct({ seo: { title: 'S', description: 'D' } })]),
    );

    expect(updateListing).not.toHaveBeenCalled();
    expect(result.results[0].action).toBe('skipped');
    expect(closedRun().counts.skipped).toBe(1);
    // Provenance is still refreshed.
    expect(provenancePatch()).toMatchObject({ sourceExternalId: 'woo-1' });
  });

  it('connector_wins overwrites even locally-edited fields', async () => {
    findConnection.mockResolvedValue(pushInConnection({ conflictPolicy: 'connector_wins' }));
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-existing', ['title']));

    await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));

    const [, patch] = updateListing.mock.calls[0];
    expect(patch.title).toBe('Woo Title');
  });
});

describe('ingestProducts — idempotency + failure isolation', () => {
  it('never double-creates the same externalId across two pushes', async () => {
    findConnection.mockResolvedValue(pushInConnection());
    createStoreProduct.mockResolvedValue('listing-new');
    // First push: not found → create. Second push: found → update.
    findListingBySourceExternalId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sourcedListingRow('listing-new'));

    const first = await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));
    const second = await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));

    expect(createStoreProduct).toHaveBeenCalledTimes(1);
    expect(first.results[0].action).toBe('created');
    expect(second.results[0].action).toBe('updated');
    expect(second.results[0].listingId).toBe('listing-new');
  });

  it('isolates a per-product failure (counts + reports it, keeps going)', async () => {
    findConnection.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct
      // A `MercariaError`, because that is what `createStoreProduct` throws — a
      // handle collision now arrives as the named refusal `asNamedHandleCollision`
      // composes (#292). A bare `Error` here would assert that an unclassified
      // upstream message reaches the merchant, which it deliberately no longer does.
      .mockRejectedValueOnce(conflict('duplicate handle'))
      .mockResolvedValueOnce('listing-ok');

    const result = await ingestProducts(
      STORE_ID,
      CONNECTION_ID,
      productsBody([ingestProduct({ externalId: 'bad' }), ingestProduct({ externalId: 'good' })]),
    );

    expect(result.results[0]).toMatchObject({ externalId: 'bad', action: 'failed' });
    expect(result.results[0].error).toContain('duplicate handle');
    expect(result.results[1]).toMatchObject({ externalId: 'good', action: 'created' });
    expect(closedRun().counts.failed).toBe(1);
    expect(closedRun().counts.created).toBe(1);
    // Partial success is still a completed run.
    expect(closedRun().status).toBe('completed');
  });

  it('marks the run failed only when every product fails', async () => {
    findConnection.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(null);
    createStoreProduct.mockRejectedValue(new Error('boom'));

    await ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()]));

    expect(closedRun().status).toBe('failed');
  });
});

describe('ingestProducts — connection guards (cross-store isolation)', () => {
  it('rejects when the connection does not belong to the store (404)', async () => {
    // `{ _id, storeId }` never matches another store's connection.
    findConnection.mockResolvedValue(null);

    await expect(
      ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()])),
    ).rejects.toThrow(/not found/i);
    expect(createStoreProduct).not.toHaveBeenCalled();
    expect(insertSyncRun).not.toHaveBeenCalled();
  });

  it('rejects a non-push_in connection (400)', async () => {
    findConnection.mockResolvedValue(pushInConnection({ mode: 'pull' }));

    await expect(
      ingestProducts(STORE_ID, CONNECTION_ID, productsBody([ingestProduct()])),
    ).rejects.toThrow(/not a push-in channel/i);
    expect(createStoreProduct).not.toHaveBeenCalled();
  });
});

describe('connectPushIn', () => {
  it('upserts a push_in connection and returns it', async () => {
    findConnectionByProvider.mockResolvedValue(null);
    upsertConnection.mockResolvedValue(pushInConnection());

    const conn = await connectPushIn(STORE_ID, 'woocommerce', { shopDomain: 'shop.example.com' });

    expect(conn.mode).toBe('push_in');
    // The `findOneAndUpdate` FILTER + `$set` + `{upsert, new, setDefaultsOnInsert}`
    // triple became the repository's own arguments: the conflict key is stated
    // positionally, the whitelist is the values, and the "defaults on insert" half
    // is the columns' own DDL defaults rather than a query option.
    const [storeId, provider, values] = upsertConnection.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(storeId).toBe(STORE_ID);
    expect(provider).toBe('woocommerce');
    expect(values).toMatchObject({
      mode: 'push_in',
      status: 'connected',
      shopDomain: 'shop.example.com',
    });
    expect(values.connectedAt).toBeInstanceOf(Date);
  });

  it('refuses to hijack an existing connection in a different mode (conflict)', async () => {
    findConnectionByProvider.mockResolvedValue(pushInConnection({ mode: 'pull' }));

    await expect(connectPushIn(STORE_ID, 'woocommerce', {})).rejects.toThrow(/different mode/i);
    // The clash is why a READ still precedes the upsert: an upsert on its own
    // would have silently taken the pull connection over.
    expect(upsertConnection).not.toHaveBeenCalled();
  });

  it('is idempotent when a push_in connection already exists', async () => {
    findConnectionByProvider.mockResolvedValue(pushInConnection());
    upsertConnection.mockResolvedValue(pushInConnection());

    await expect(connectPushIn(STORE_ID, 'woocommerce', {})).resolves.toMatchObject({
      mode: 'push_in',
    });
  });
});

describe('ingestInventory', () => {
  const inventoryBody = (
    items: IngestInventoryInput['items'],
  ): IngestInventoryInput => ({ items });

  it('sets stock on a single-variant listing at the default location', async () => {
    findConnection.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-1'));
    findVariantsByListing.mockResolvedValue([{ id: 'var-1', listingId: 'listing-1' }]);

    const result = await ingestInventory(
      STORE_ID,
      CONNECTION_ID,
      inventoryBody([{ externalId: 'woo-1', available: 7 }]),
    );

    expect(setAvailable).toHaveBeenCalledWith('var-1', 'listing-1', 'loc-1', 7);
    expect(result.results[0]).toEqual({ externalId: 'woo-1', action: 'updated', variantId: 'var-1' });
  });

  it('maps a multi-variant listing by SKU', async () => {
    findConnection.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-1'));
    findVariantsByListingAndSku.mockResolvedValue([{ id: 'var-2', listingId: 'listing-1' }]);

    await ingestInventory(
      STORE_ID,
      CONNECTION_ID,
      inventoryBody([{ externalId: 'woo-1', sku: 'SKU-2', available: 3 }]),
    );

    expect(findVariantsByListingAndSku).toHaveBeenCalledWith('listing-1', 'SKU-2');
    expect(setAvailable).toHaveBeenCalledWith('var-2', 'listing-1', 'loc-1', 3);
    expect(findVariantsByListing).not.toHaveBeenCalled();
  });

  it('skips an item whose SKU matches no variant of the mapped listing', async () => {
    findConnection.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-1'));
    findVariantsByListingAndSku.mockResolvedValue([]);

    const result = await ingestInventory(
      STORE_ID,
      CONNECTION_ID,
      inventoryBody([{ externalId: 'woo-1', sku: 'NOPE', available: 3 }]),
    );

    expect(setAvailable).not.toHaveBeenCalled();
    expect(result.results[0]).toEqual({ externalId: 'woo-1', action: 'skipped' });
  });

  it('skips an item that maps to no listing', async () => {
    findConnection.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(null);

    const result = await ingestInventory(
      STORE_ID,
      CONNECTION_ID,
      inventoryBody([{ externalId: 'missing', available: 1 }]),
    );

    expect(setAvailable).not.toHaveBeenCalled();
    expect(result.results[0]).toEqual({ externalId: 'missing', action: 'skipped' });
  });

  it('REFUSES an item whose SKU matches several variants, and says so distinguishably', async () => {
    // #296. `product_variants_sku_key` used to make this state unreachable, so
    // the SKU lookup could take the first row `.limit(1)` returned and be right
    // by construction. With the index gone the same code would set one arbitrary
    // variant's stock from another variant's count — silently, and only on the
    // catalogues the constraint used to refuse outright.
    findConnection.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-1'));
    findVariantsByListingAndSku.mockResolvedValue([
      { id: 'var-a', listingId: 'listing-1' },
      { id: 'var-b', listingId: 'listing-1' },
    ]);

    const result = await ingestInventory(
      STORE_ID,
      CONNECTION_ID,
      inventoryBody([{ externalId: 'woo-1', sku: 'SHARED', available: 3 }]),
    );

    expect(setAvailable).not.toHaveBeenCalled();
    // Its own action, NOT `skipped`: "we could not find it" and "we found
    // several and will not guess" send a merchant to opposite places.
    expect(result.results[0].action).toBe('ambiguous');
    // And it names them, so the merchant can go and de-duplicate exactly those.
    expect(result.results[0].error).toContain('SHARED');
    expect(result.results[0].error).toContain('var-a');
    expect(result.results[0].error).toContain('var-b');
    // Counted as a failure rather than a skip — nothing was applied and a person
    // has to act — which is also what makes an all-ambiguous run report `failed`.
    expect(closedRun()).toEqual({
      status: 'failed',
      counts: { created: 0, updated: 0, skipped: 0, failed: 1 },
    });
  });

  it('bounds the ambiguous message, which is unbounded in its CANDIDATE list', async () => {
    // The `sku` is capped at 120 by `ingestInventorySchema`; the candidate list is
    // not capped by anything but `maxVariantsPerProduct`, which defaults to 100.
    // So this is a shape a merchant can legitimately have — one listing whose
    // variants all carry one SKU — and it composes ~3,900 characters straight into
    // the ingest response, nearly four times the 1065-character `sync_runs` rows
    // #292 exists to stop.
    const candidates = Array.from({ length: 100 }, (_, i) => ({
      id: `01a0041c-8a6c-79f0-9770-57acecb7${String(i).padStart(4, '0')}`,
      listingId: 'listing-1',
    }));
    findConnection.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-1'));
    findVariantsByListingAndSku.mockResolvedValue(candidates);

    const result = await ingestInventory(
      STORE_ID,
      CONNECTION_ID,
      inventoryBody([{ externalId: 'woo-1', sku: 'SHARED', available: 3 }]),
    );

    const message = result.results[0].error as string;
    // POSITIVE CONTROL: the unbounded composition really would have been enormous,
    // so the ceiling below is measuring a cut rather than a short message.
    expect(candidates.map((c) => c.id).join(', ').length).toBeGreaterThan(3000);
    expect(result.results[0].action).toBe('ambiguous');
    expect(message.length).toBe(MERCHANT_FACING_MESSAGE_MAX_LENGTH);
    expect(message.endsWith('…')).toBe(true);
    // Still useful after the cut: the count and the SKU lead the sentence, so the
    // merchant learns what happened even when the id list is truncated.
    expect(message).toContain('100 variants');
    expect(message).toContain('SHARED');
  });

  it('skips a multi-variant listing when no SKU disambiguates it', async () => {
    findConnection.mockResolvedValue(pushInConnection());
    findListingBySourceExternalId.mockResolvedValue(sourcedListingRow('listing-1'));
    findVariantsByListing.mockResolvedValue([
      { id: 'a', listingId: 'listing-1' },
      { id: 'b', listingId: 'listing-1' },
    ]);

    const result = await ingestInventory(
      STORE_ID,
      CONNECTION_ID,
      inventoryBody([{ externalId: 'woo-1', available: 2 }]),
    );

    expect(setAvailable).not.toHaveBeenCalled();
    // `skipped` and deliberately NOT `ambiguous`, which is the case above. This
    // item named a product and said nothing about which of its variants it
    // meant, so the merchant's fix is to send a SKU; `ambiguous` says the
    // CATALOGUE cannot tell two rows apart, whose fix is to de-duplicate it.
    expect(result.results[0].action).toBe('skipped');
  });
});
