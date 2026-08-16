/**
 * #376 — a connector's `collectionMapping`, against a REAL Postgres database.
 *
 * The mapping is the one `Map` in the source model and is stored as `jsonb`,
 * which is the right shape: its KEYS are the external platform's own open id
 * space (see `db/schema/CONVENTIONS.md`'s jsonb register). The consequence is
 * that its VALUES carry no foreign key, so nothing in the database keeps them
 * pointing at a collection that exists, belongs to this store, or is even the
 * right KIND — and two different failures follow, each silent in its own way.
 *
 * ## Why this suite needs a real server
 *
 * Every property here is one a mocked repository cannot have.
 *
 *  - `listing_collections.collection_id` is a real FOREIGN KEY, so "the import
 *    fails on a deleted collection" is a fact about Postgres raising `23503`. A
 *    mocked `insert` accepts that statement happily.
 *  - `setListingAutomatedMemberships`' delete is bounded by `position IS NULL`
 *    in SQL, and the whole automated-collection conflict is about which of two
 *    writers' NULL-`position` rows survives. There is nothing to observe without
 *    the rows.
 *  - `recomputeAutomatedMembershipForListing` runs inside `syncListingFacets`
 *    during the create, so the ORDER in which the rules engine and the connector
 *    write is a property of the real call graph against real rows.
 *
 * ## Each case fails against the code as it was
 *
 * Measured on the parent commit, all three of the load-bearing cases go red:
 * the deleted-target import is counted as a per-product FAILURE, the automated
 * collection DOES receive a connector membership, and `updateSyncSettings`
 * accepts a mapping onto an automated collection without complaint.
 *
 * The mapped-onto-a-MANUAL-collection case is the positive control and is not
 * decoration: every other assertion here is of the form "this row was not
 * written", and a filter that dropped every target — the obvious way to get the
 * fix wrong — would satisfy all of them at once.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { ExternalCollection } from '@mercaria/shared-types';
import type { ConnectorProvider, NormalizedProduct } from '../../connectors/types.js';
import { wooCommerceProvider } from '../../connectors/woocommerce/index.js';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { connections } from '../../db/schema/connectors.js';
import { collections, listingCollections } from '../../db/schema/merchandising.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { insertCategory } from '../../db/catalog/categoryRepository.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { insertLocation } from '../../db/stores/locationRepository.js';
import { insertCollection } from '../../db/merchandising/collectionRepository.js';
import { findListingBySourceExternalId } from '../../db/catalog/listingRepository.js';
import type { ConnectionRow } from '../../db/connectors/connectionRepository.js';
import {
  connectWithApiKey,
  listChannelCollections,
  runBackfill,
  updateSyncSettings,
} from '../connector-sync.service.js';

/**
 * The provider `getConnectorProvider` answers with.
 *
 * The mock is the REGISTRY and nothing below it: the installed object is the
 * shipped WooCommerce provider with only the calls this suite drives replaced,
 * so every rule the service applies to what a provider returns is production
 * code.
 */
let installed: ConnectorProvider | undefined;

vi.mock('../../connectors/registry.js', () => ({
  getConnectorProvider: () => {
    if (!installed) {
      throw new Error('a provider must be installed before the service runs');
    }
    return installed;
  },
  isImplementedProvider: () => true,
}));

/** The env a connector operation reads AT USE. */
const REQUIRED_ENV: Readonly<Record<string, string>> = {
  CONNECTOR_ENCRYPTION_KEY: 'c'.repeat(64),
  CONNECTOR_OAUTH_STATE_SECRET: 'collection-mapping-suite-state-secret',
  CONNECTOR_OAUTH_REDIRECT_BASE_URL: 'https://api.mercaria.test',
};

let db: Database;
const createdStoreIds: string[] = [];
const createdCategoryIds: string[] = [];
const previousEnv = new Map<string, string | undefined>();

/** The external grouping every product in this suite belongs to. */
const EXTERNAL_REF = 'ext-cat-42';

interface Fixture {
  readonly storeId: string;
  readonly locationId: string;
  readonly connection: ConnectionRow;
}

/** A product the fake platform publishes, in ONE external grouping. */
function normalizedProduct(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    externalId: `woo-collection-${uuidv7()}`,
    title: 'Mapped tee',
    description: '<p>Imported</p>',
    handle: `mapped-tee-${uuidv7()}`,
    options: [],
    imageUrls: ['https://cdn.example.test/mapped-tee.jpg'],
    externalUpdatedAt: new Date('2026-08-01T10:00:00Z'),
    collectionRefs: [EXTERNAL_REF],
    variants: {
      enumeration: 'complete',
      variants: [
        {
          optionValues: [],
          price: { amount: 2499, currency: 'GBP' },
          inventory: { tracked: true, available: 5 },
          sku: `MAPPED-${uuidv7()}`,
          externalVariantId: '4001',
          externalInventoryItemId: '5001',
        },
      ],
    },
    ...overrides,
  };
}

/** Install the shipped provider with only the calls this suite drives replaced. */
function installProvider(
  products: NormalizedProduct[],
  platformCollections: ExternalCollection[] = [],
): void {
  installed = {
    ...wooCommerceProvider,
    verifyConnection: () =>
      Promise.resolve({
        externalShopId: 'https://collections.example.test',
        shopDomain: 'collections.example.test',
        shopCurrency: 'GBP',
      }),
    listWebhooks: () => Promise.resolve([]),
    registerWebhooks: () =>
      Promise.resolve({ outcome: 'reconciled' as const, subscriptions: [], failures: [] }),
    fetchProducts: () => Promise.resolve({ products }),
    fetchCollections: () => Promise.resolve(platformCollections),
  };
}

/** A store with an import category, a default location and a CONNECTED pull connection. */
async function makeFixture(): Promise<Fixture> {
  installProvider([]);
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `collection-mapping-${suffix}`,
      name: 'Collection mapping store',
      description: '',
      brandColor: '#654321',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);

  const location = await insertLocation(store.id, {
    name: 'Default location',
    type: 'warehouse',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
  });

  const category = await insertCategory({
    name: 'Collection mapping imports',
    slug: `collection-mapping-imports-${suffix}`,
  });
  createdCategoryIds.push(category.id);
  process.env.CONNECTOR_DEFAULT_CATEGORY_SLUG = category.slug;

  const connection = await connectWithApiKey(store.id, 'woocommerce', {
    shopDomain: 'collections.example.test',
    consumerKey: 'ck_collections',
    consumerSecret: 'cs_collections',
  });
  const configured = await updateSyncSettings(store.id, connection.id, {
    products: 'pull',
    inventory: 'off',
    orders: 'off',
    autoPublish: true,
    conflictPolicy: 'respect_overrides',
    targetLocationId: location.id,
  });
  expect(configured, 'the connection this fixture just created must be readable').not.toBeNull();

  return {
    storeId: store.id,
    locationId: location.id,
    connection: configured as ConnectionRow,
  };
}

/** A MANUAL collection of this store. */
async function makeManualCollection(storeId: string, title: string) {
  return insertCollection(
    storeId,
    {
      title,
      handle: `manual-${uuidv7()}`,
      type: 'manual',
      isPublished: true,
    },
    [],
  );
}

/**
 * An AUTOMATED collection whose rule matches NOTHING this suite imports.
 *
 * Deliberately non-matching: if the rules engine legitimately admitted the
 * imported listing, a membership row would prove nothing about who wrote it.
 */
async function makeAutomatedCollection(storeId: string, title: string) {
  return insertCollection(
    storeId,
    {
      title,
      handle: `automated-${uuidv7()}`,
      type: 'automated',
      isPublished: true,
    },
    [{ field: 'title', operator: 'contains', value: 'no-listing-in-this-suite-says-this' }],
  );
}

/**
 * The imported listing, refusing rather than casting when it is absent.
 *
 * Every case here reaches for it after asserting the run created something, so
 * a missing row is a failed premise and must fail LOUDLY at the point the
 * premise broke — not as a confusing `undefined` two assertions later.
 */
async function importedListing(fixture: Fixture, externalId: string): Promise<{ id: string }> {
  const listing = await findListingBySourceExternalId(
    fixture.storeId,
    fixture.connection.id,
    externalId,
  );
  if (!listing) {
    throw new Error(`no listing was imported for ${externalId}`);
  }
  return listing;
}

/** Every collection membership row of one listing. */
async function membershipsOf(listingId: string) {
  return db
    .select()
    .from(listingCollections)
    .where(eq(listingCollections.listingId, listingId));
}

/** Write the mapping straight onto the row, bypassing the write-time refusal. */
async function forceStoredMapping(
  connectionId: string,
  mapping: Record<string, string>,
): Promise<void> {
  await db
    .update(connections)
    .set({ syncSettingsCollectionMapping: mapping })
    .where(eq(connections.id, connectionId));
}

beforeAll(async () => {
  for (const [name, value] of Object.entries(REQUIRED_ENV)) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  installed = undefined;
  // `listings.store_id` and `listings.source_connection_id` are both ON DELETE
  // RESTRICT, so the order is load-bearing: listings, then the connection, then
  // the store. `listing_collections` cascades from BOTH ends, and `collections`
  // cascades from the store.
  const storeIds = createdStoreIds.splice(0);
  for (const storeId of storeIds) {
    await db.delete(listings).where(eq(listings.storeId, storeId));
    await db.delete(connections).where(eq(connections.storeId, storeId));
    await db.delete(collections).where(eq(collections.storeId, storeId));
  }
  await deleteTestStores(db, storeIds);
  for (const categoryId of createdCategoryIds.splice(0)) {
    await db.delete(categories).where(eq(categories.id, categoryId));
  }
});

afterAll(async () => {
  for (const [name, value] of previousEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  await closePostgres();
});

describe('a mapping onto a MANUAL collection is applied (the positive control)', () => {
  it('writes the membership and reports the product as created', async () => {
    const fixture = await makeFixture();
    const target = await makeManualCollection(fixture.storeId, 'Mapped manual');
    await forceStoredMapping(fixture.connection.id, { [EXTERNAL_REF]: target.id });

    const product = normalizedProduct();
    installProvider([product]);
    const run = await runBackfill(fixture.storeId, fixture.connection.id);

    expect(run.countsCreated, 'the product must import').toBe(1);
    expect(run.countsFailed, 'and it must not be counted as a failure').toBe(0);

    const listing = await importedListing(fixture, product.externalId);
    const rows = await membershipsOf(listing.id);
    expect(
      rows.map((r) => r.collectionId),
      'the mapped manual collection must hold the listing',
    ).toEqual([target.id]);
    expect(
      rows[0].position,
      'a connector membership carries no hand-picked order',
    ).toBeNull();
  });
});

describe('a mapping whose target was DELETED does not fail the import', () => {
  /**
   * Against the parent commit this case is RED: `listing_collections.collection_id`
   * is a real foreign key, the insert raises `23503`, and `runBackfill` catches
   * it per product — so `failed` is 1 and the run names the PRODUCT while the
   * cause is a collection nobody has looked at.
   */
  it('imports the product and writes no membership', async () => {
    const fixture = await makeFixture();
    const doomed = await makeManualCollection(fixture.storeId, 'About to be deleted');
    await forceStoredMapping(fixture.connection.id, { [EXTERNAL_REF]: doomed.id });
    await db.delete(collections).where(eq(collections.id, doomed.id));

    const product = normalizedProduct();
    installProvider([product]);
    const run = await runBackfill(fixture.storeId, fixture.connection.id);

    expect(run.countsFailed, 'a dangling mapping target must not fail the product').toBe(0);
    expect(run.countsCreated, 'the product must still import').toBe(1);

    const listing = await importedListing(fixture, product.externalId);
    expect(
      await membershipsOf(listing.id),
      'and it belongs to no collection',
    ).toEqual([]);
  });
});

describe('a mapping onto an AUTOMATED collection never writes a membership', () => {
  /**
   * Against the parent commit this case is RED. The order is what makes it
   * deterministic rather than racy: `createStoreProduct` ends in
   * `syncListingFacets`, which runs `recomputeAutomatedMembershipForListing` and
   * removes every automated membership the rules do not justify — and THEN
   * `applyCollectionMapping` used to write one back. So the connector's row was
   * the last word, and it survived until the listing's next save, at which point
   * the rules engine removed it again. Neither writer can see the other's row as
   * foreign, because both write a NULL `position`.
   */
  it('leaves the rules engine as the sole owner of that collection', async () => {
    const fixture = await makeFixture();
    const automated = await makeAutomatedCollection(fixture.storeId, 'Rules own this');
    await forceStoredMapping(fixture.connection.id, { [EXTERNAL_REF]: automated.id });

    const product = normalizedProduct();
    installProvider([product]);
    const run = await runBackfill(fixture.storeId, fixture.connection.id);

    expect(run.countsCreated, 'the product must import').toBe(1);
    expect(run.countsFailed, 'and must not be counted as a failure').toBe(0);

    const listing = await importedListing(fixture, product.externalId);
    const rows = await membershipsOf(listing.id);
    expect(
      rows.filter((r) => r.collectionId === automated.id),
      'the connector must not write into a rules-driven collection',
    ).toEqual([]);
  });
});

describe('updateSyncSettings refuses a mapping it cannot honour', () => {
  it('refuses a target that is an AUTOMATED collection', async () => {
    const fixture = await makeFixture();
    const automated = await makeAutomatedCollection(fixture.storeId, 'Rules own this too');

    await expect(
      updateSyncSettings(fixture.storeId, fixture.connection.id, {
        collectionMapping: { [EXTERNAL_REF]: automated.id },
      }),
    ).rejects.toThrow(/automated collection/i);

    const [row] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, fixture.connection.id));
    expect(
      row.syncSettingsCollectionMapping,
      'a refused mapping must not be stored',
    ).toBeNull();
  });

  it('refuses a target that does not exist', async () => {
    const fixture = await makeFixture();

    await expect(
      updateSyncSettings(fixture.storeId, fixture.connection.id, {
        collectionMapping: { [EXTERNAL_REF]: uuidv7() },
      }),
    ).rejects.toThrow(/Unknown collection/i);
  });

  it('refuses a target belonging to ANOTHER store', async () => {
    const mine = await makeFixture();
    const theirs = await makeFixture();
    const foreign = await makeManualCollection(theirs.storeId, 'Somebody else’s');

    // Reported as unknown rather than as automated: the read is scoped to the
    // caller's store, so it genuinely cannot see the row. That is the correct
    // answer and not a leak.
    await expect(
      updateSyncSettings(mine.storeId, mine.connection.id, {
        collectionMapping: { [EXTERNAL_REF]: foreign.id },
      }),
    ).rejects.toThrow(/Unknown collection/i);
  });

  it('accepts a target that is a MANUAL collection of this store', async () => {
    const fixture = await makeFixture();
    const target = await makeManualCollection(fixture.storeId, 'Perfectly fine');

    const updated = await updateSyncSettings(fixture.storeId, fixture.connection.id, {
      collectionMapping: { [EXTERNAL_REF]: target.id },
    });
    expect(updated.syncSettingsCollectionMapping).toEqual({ [EXTERNAL_REF]: target.id });
  });
});

describe('listChannelCollections resolves both ends of every stored row', () => {
  it('names the platform’s groupings, the manual targets and each row’s state', async () => {
    const fixture = await makeFixture();
    const manual = await makeManualCollection(fixture.storeId, 'Live target');
    const automated = await makeAutomatedCollection(fixture.storeId, 'Automated target');
    const doomed = await makeManualCollection(fixture.storeId, 'Deleted target');
    const doomedId = doomed.id;
    await forceStoredMapping(fixture.connection.id, {
      [EXTERNAL_REF]: manual.id,
      'ext-gone': manual.id,
      'ext-automated': automated.id,
      'ext-deleted': doomedId,
    });
    await db.delete(collections).where(eq(collections.id, doomedId));

    installProvider([], [
      { externalId: EXTERNAL_REF, title: 'Tees', productCount: 3 },
      { externalId: 'ext-automated', title: 'Hoodies' },
      { externalId: 'ext-deleted', title: 'Caps' },
    ]);

    const view = await listChannelCollections(fixture.storeId, fixture.connection.id);

    expect(view.noun, 'WooCommerce groups products into categories').toBe('category');
    expect(view.external.outcome).toBe('listed');

    const byExternal = new Map(view.mapping.map((r) => [r.externalId, r]));
    expect(byExternal.get(EXTERNAL_REF)?.state).toBe('ok');
    expect(byExternal.get(EXTERNAL_REF)?.externalTitle).toBe('Tees');
    expect(byExternal.get(EXTERNAL_REF)?.collectionTitle).toBe('Live target');
    // The platform answered and did not name it, which is the only condition
    // under which "the platform dropped it" may be claimed.
    expect(byExternal.get('ext-gone')?.state).toBe('external_missing');
    expect(byExternal.get('ext-automated')?.state).toBe('target_automated');
    expect(byExternal.get('ext-deleted')?.state).toBe('target_missing');

    const targetIds = view.targets.map((t) => t.id);
    expect(targetIds, 'a manual collection is offerable').toContain(manual.id);
    expect(targetIds, 'an automated one never is').not.toContain(automated.id);
  });

  it('reports the platform half as unavailable without failing the whole read', async () => {
    const fixture = await makeFixture();
    const manual = await makeManualCollection(fixture.storeId, 'Still readable');
    await forceStoredMapping(fixture.connection.id, { [EXTERNAL_REF]: manual.id });

    installProvider([]);
    installed = {
      ...wooCommerceProvider,
      verifyConnection: () =>
        Promise.resolve({
          externalShopId: 'https://collections.example.test',
          shopDomain: 'collections.example.test',
          shopCurrency: 'GBP',
        }),
      fetchCollections: () => Promise.reject(new Error('the shop is down')),
    };

    const view = await listChannelCollections(fixture.storeId, fixture.connection.id);

    expect(view.external.outcome).toBe('unavailable');
    expect(
      view.external.outcome === 'unavailable' ? view.external.reason : undefined,
    ).toBe('platform_unavailable');
    // The stored rows are Mercaria's own facts and stay answerable.
    expect(view.mapping).toHaveLength(1);
    expect(
      view.mapping[0].state,
      'an unreachable platform must not read as a deleted grouping',
    ).toBe('ok');
    expect(view.targets.map((t) => t.id)).toContain(manual.id);
  });

  it('answers 404 for a connection of another store', async () => {
    const mine = await makeFixture();
    const theirs = await makeFixture();

    // The tenant gate on every channel route answers 404 and never 403, so a
    // caller cannot use it to learn that a connection id exists.
    await expect(
      listChannelCollections(mine.storeId, theirs.connection.id),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe('an unmapped connection pays nothing and behaves exactly as before', () => {
  it('imports with no membership and no mapping read', async () => {
    const fixture = await makeFixture();
    const product = normalizedProduct();
    installProvider([product]);

    const run = await runBackfill(fixture.storeId, fixture.connection.id);

    expect(run.countsCreated).toBe(1);
    const listing = await importedListing(fixture, product.externalId);
    expect(await membershipsOf(listing.id)).toEqual([]);
  });
});

describe('a NATIVE membership survives a connector re-sync', () => {
  /**
   * The property `setListingAutomatedMemberships`' `position IS NULL` guard
   * exists for, re-measured through the #376 filter: a hand-picked membership
   * in a collection the mapping's codomain NAMES must not be deleted when the
   * platform stops sending the ref.
   */
  it('keeps a hand-picked row when the platform drops the ref', async () => {
    const fixture = await makeFixture();
    const target = await makeManualCollection(fixture.storeId, 'Hand-picked and mapped');
    await forceStoredMapping(fixture.connection.id, { [EXTERNAL_REF]: target.id });

    const product = normalizedProduct();
    installProvider([product]);
    await runBackfill(fixture.storeId, fixture.connection.id);
    const listingId = (await importedListing(fixture, product.externalId)).id;

    // Promote the connector's row to a HAND-PICKED one, as setting the
    // collection's product list would.
    await db
      .update(listingCollections)
      .set({ position: 0 })
      .where(
        and(
          eq(listingCollections.listingId, listingId),
          eq(listingCollections.collectionId, target.id),
        ),
      );

    // The platform now sends the product in NO grouping.
    installProvider([normalizedProduct({ externalId: product.externalId, collectionRefs: [] })]);
    await runBackfill(fixture.storeId, fixture.connection.id);

    const rows = await membershipsOf(listingId);
    expect(
      rows.map((r) => r.collectionId),
      'a hand-picked membership is not the connector’s to delete',
    ).toEqual([target.id]);
  });
});
