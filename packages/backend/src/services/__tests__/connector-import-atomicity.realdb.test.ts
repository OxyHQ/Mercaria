/**
 * #221 — a connector import is ATOMIC between creating a listing and stamping
 * its provenance, against a REAL Postgres database.
 *
 * The defect: `importProduct` (pull) and `upsertProduct` (push-in) created the
 * listing through `createStoreProduct` and then wrote the four `source_*`
 * columns in a SECOND statement. A failure between the two left a listing that
 *
 *  - has no `source_external_id`, so `findListingBySourceExternalId` can never
 *    match it again — no later sync will ever update it; and
 *  - still occupies `listings_store_id_handle_key` for its handle, so the next
 *    sync's CREATE fails on the handle unique.
 *
 * Both together mean one transient failure delists a product PERMANENTLY, and
 * every subsequent run of that connection fails on it while reporting an
 * ordinary per-product error. Nothing else in the system can notice.
 *
 * ## Why this suite needs a real server
 *
 * Every property here is one a mocked repository cannot have. `createStoreProduct`
 * opens a real transaction, so "the create was rolled back" is a fact about
 * Postgres; the handle unique is a real index, so "the second run collides"
 * only happens where that index exists; and the failure that STARTED all of it
 * is drizzle refusing to map an invalid `Date` to a `timestamptz` parameter,
 * which no mocked insert would ever do.
 *
 * ## The failures are real, and each one is named
 *
 * An INVALID `Date` reaching `source_external_updated_at` is the failure the
 * issue reported: `normalizeWooCommerceProduct` produced one for any
 * `date_modified_gmt` already carrying a zone. That normalizer no longer can
 * (see `connectors/timestamps.ts` and the normalizer suites), which is the
 * OTHER half of #221 — so the provider here supplies the invalid value
 * directly, which `NormalizedProduct.externalUpdatedAt: Date` permits and any
 * future provider could produce again. A foreign-key refusal on
 * `source_connection_id` is the second, and it is the one the SERVER raises
 * rather than the driver, so the two failures land on different sides of the
 * wire.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isForeignKeyViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import type { ConnectorProvider, NormalizedProduct } from '../../connectors/types.js';
import { wooCommerceProvider } from '../../connectors/woocommerce/index.js';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { connections } from '../../db/schema/connectors.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { insertCategory } from '../../db/taxonomy/taxonomyRepository.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { insertLocation } from '../../db/stores/locationRepository.js';
import {
  updateSyncSettings,
  type ConnectionRow,
} from '../../db/connectors/connectionRepository.js';
import { findListingBySourceExternalId } from '../../db/catalog/listingRepository.js';
import { findVariantsByListing } from '../../db/catalog/variantRepository.js';
import { createStoreProduct } from '../catalog-write.service.js';
import { connectWithApiKey, runBackfill } from '../connector-sync.service.js';
import { connectPushIn, ingestProducts } from '../channel-ingest.service.js';

/**
 * The provider `getConnectorProvider` currently answers with.
 *
 * The mock is the registry and NOTHING below it: the object installed here is
 * the SHIPPED WooCommerce provider with the three methods this suite drives
 * replaced, so every other method — and every rule the service applies to what
 * a provider returns — is production code.
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
  CONNECTOR_ENCRYPTION_KEY: 'b'.repeat(64),
  CONNECTOR_OAUTH_STATE_SECRET: 'atomicity-suite-state-secret',
  CONNECTOR_OAUTH_REDIRECT_BASE_URL: 'https://api.mercaria.test',
};

let db: Database;
const createdStoreIds: string[] = [];
const createdCategoryIds: string[] = [];
const previousEnv = new Map<string, string | undefined>();

/** Everything one case works against. */
interface Fixture {
  readonly storeId: string;
  readonly categorySlug: string;
  readonly locationId: string;
  readonly connection: ConnectionRow;
}

/**
 * One product the fake platform publishes.
 *
 * The handle is what makes #221 permanent rather than merely untidy, so every
 * fixture carries one — a product with no handle strands just as thoroughly and
 * blocks nothing, which is the case that would pass whatever the fix did.
 */
function normalizedProduct(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    externalId: 'woo-atomic-1',
    title: 'Atomicity tee',
    description: '<p>Imported</p>',
    handle: 'atomicity-tee',
    options: [],
    imageUrls: ['https://cdn.example.test/atomicity-tee.jpg'],
    externalUpdatedAt: new Date('2026-08-01T10:00:00Z'),
    variants: {
      enumeration: 'complete',
      variants: [
        {
          optionValues: [],
          price: { amount: 1999, currency: 'GBP' },
          inventory: { tracked: true, available: 4 },
          sku: `ATOMIC-${uuidv7()}`,
          externalVariantId: '2001',
          externalInventoryItemId: '3001',
        },
      ],
    },
    ...overrides,
  };
}

/** Install the shipped provider with only the calls this suite drives replaced. */
function installProviderYielding(products: NormalizedProduct[]): void {
  installed = {
    ...wooCommerceProvider,
    verifyConnection: () =>
      Promise.resolve({
        externalShopId: 'https://atomicity.example.test',
        shopDomain: 'atomicity.example.test',
        shopCurrency: 'GBP',
      }),
    // No fake socket in this suite, so the registration path must not reach one.
    // #218 made a registration that subscribes nothing a first-class result
    // rather than a throw, which is exactly what an empty one is.
    //
    // `reconciled` and not `unknown`: the platform list below reads fine and is
    // empty, so this attempt KNOWS nothing is live. `unknown` is the branch for
    // a list that could not be read at all, and it carries no subscriptions —
    // which would leave whatever ids were stored alone instead of writing none.
    listWebhooks: () => Promise.resolve([]),
    registerWebhooks: () =>
      Promise.resolve({ outcome: 'reconciled' as const, subscriptions: [], failures: [] }),
    fetchProducts: () => Promise.resolve({ products }),
  };
}

/** A store with an import category, a default location and a CONNECTED pull connection. */
async function makePullFixture(options: { autoPublish?: boolean } = {}): Promise<Fixture> {
  // The connect path itself runs through the provider (verify + webhook
  // registration), so one has to be installed before the fixture, not only
  // before the run. Each case re-installs with the products it publishes.
  installProviderYielding([]);
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `import-atomicity-${suffix}`,
      name: 'Import atomicity store',
      description: '',
      brandColor: '#123456',
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
    key: `atomicity-imports-${suffix}`,
    name: 'Atomicity imports',
    slug: `atomicity-imports-${suffix}`,
  });
  createdCategoryIds.push(category.id);
  process.env.CONNECTOR_DEFAULT_CATEGORY_SLUG = category.slug;

  const connection = await connectWithApiKey(store.id, 'woocommerce', {
    shopDomain: 'atomicity.example.test',
    consumerKey: 'ck_atomicity',
    consumerSecret: 'cs_atomicity',
  });
  const configured = await updateSyncSettings(store.id, connection.id, {
    products: 'pull',
    inventory: 'off',
    orders: 'off',
    autoPublish: options.autoPublish ?? true,
    conflictPolicy: 'respect_overrides',
    targetLocationId: location.id,
  });
  expect(configured, 'the connection this fixture just created must be readable').not.toBeNull();

  return {
    storeId: store.id,
    categorySlug: category.slug,
    locationId: location.id,
    connection: configured as ConnectionRow,
  };
}

/** Every listing this store holds, however it was created. */
async function listingsOf(storeId: string) {
  return db.select().from(listings).where(eq(listings.storeId, storeId));
}

/**
 * The executable statements of migration `0070`, read out of the SHIPPED file.
 *
 * Restating the SQL here would measure the restatement — the repo's own rule
 * about a test that re-implements the code under test. Reading the file means a
 * regeneration that drops the hand-written violator UPDATE (drizzle-kit emits
 * only the DROP and the CREATE) turns the migration case RED, because the
 * `CREATE UNIQUE INDEX` then aborts on the pair it seeds.
 *
 * Comment lines are stripped before splitting: the header deliberately contains
 * a `select … having count(*) > 1` an operator is meant to run by hand, and
 * executing that as a statement would be harmless but would make the parse's
 * statement count meaningless.
 */
function shippedMigrationStatements(): string[] {
  const file = fileURLToPath(
    new URL('../../../drizzle/0070_eminent_peter_parker.sql', import.meta.url),
  );
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim().replace(/;$/, ''))
    .filter((statement) => statement.length > 0);
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
  // the store. Variants, images, options and inventory levels cascade.
  //
  // The store goes through the shared helper, which first clears the
  // `native_store_links` row the backfill stage mints under its OWN merchant
  // against every active store in the shared database. That link is RESTRICT
  // too and is keyed to a merchant this file never sees, so a teardown scoped
  // by anything but the store id is structurally unable to clear it.
  const storeIds = createdStoreIds.splice(0);
  for (const storeId of storeIds) {
    await db.delete(listings).where(eq(listings.storeId, storeId));
    await db.delete(connections).where(eq(connections.storeId, storeId));
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

describe('createStoreProduct writes provenance and status in the listing’s OWN insert', () => {
  it('carries all four `source_*` columns and the requested status', async () => {
    const fixture = await makePullFixture();

    const listingId = await createStoreProduct(
      fixture.storeId,
      {
        title: 'Directly created',
        description: '',
        category: fixture.categorySlug,
        handle: 'directly-created',
        imageFileIds: [],
        options: [],
        variants: [
          {
            optionValues: [],
            price: { amount: 500, currency: 'GBP' },
            inventory: { tracked: true, available: 1 },
          },
        ],
      },
      {
        locationId: fixture.locationId,
        source: {
          sourceConnectionId: fixture.connection.id,
          sourceProvider: 'woocommerce',
          sourceExternalId: 'woo-direct-1',
          sourceExternalUpdatedAt: new Date('2026-08-02T09:00:00Z'),
        },
        status: 'draft',
      },
    );

    const [row] = await listingsOf(fixture.storeId);
    expect(row.id).toBe(listingId);
    expect(row.sourceConnectionId).toBe(fixture.connection.id);
    expect(row.sourceProvider).toBe('woocommerce');
    expect(row.sourceExternalId).toBe('woo-direct-1');
    expect(row.sourceExternalUpdatedAt).toEqual(new Date('2026-08-02T09:00:00Z'));
    expect(row.status).toBe('draft');
    // `published_at` is read in the SAME row as `status`, deliberately. Before
    // #221 the create hardcoded `status: 'active'` and the draft arrived in the
    // second statement, so a failure between them left an unpublished import ON
    // SALE — and asserting the status alone cannot tell that apart from a row
    // whose two publication facts disagree.
    //
    // #221 asserted a Date here and said so: the create always stamped the column
    // and the old second statement never cleared it, so `published_at` meant "when
    // the listing row was written". #261 narrowed it to the first activation, which
    // is why this assertion INVERTED rather than drifting — it is the signal that
    // issue described. A draft has never been on sale, so it has no publication
    // instant, and `created_at` is where "when was the row written" lives.
    expect(row.publishedAt).toBeNull();
  });

  it('leaves the four columns NULL and the status `active` for a MERCHANT create', async () => {
    // The other side of the discriminant. Without it, a `createStoreProduct`
    // that wrote a constant provenance — or that had stopped reading `opts` at
    // all — would pass the case above for the wrong reason, and the merchant
    // path is the one that must not change.
    const fixture = await makePullFixture();

    await createStoreProduct(
      fixture.storeId,
      {
        title: 'Merchant created',
        description: '',
        category: fixture.categorySlug,
        handle: 'merchant-created',
        imageFileIds: [],
        options: [],
        variants: [
          {
            optionValues: [],
            price: { amount: 500, currency: 'GBP' },
            inventory: { tracked: true, available: 1 },
          },
        ],
      },
      { locationId: fixture.locationId },
    );

    const [row] = await listingsOf(fixture.storeId);
    expect(row.sourceConnectionId).toBeNull();
    expect(row.sourceProvider).toBeNull();
    expect(row.sourceExternalId).toBeNull();
    expect(row.sourceExternalUpdatedAt).toBeNull();
    expect(row.status).toBe('active');
  });

  it('leaves NO listing behind when the SERVER refuses the provenance', async () => {
    // A `source_connection_id` naming no connection: a foreign-key refusal
    // raised by Postgres inside the create's own transaction, which is a
    // different failure site from the driver-side one the pull case below uses.
    const fixture = await makePullFixture();

    let caught: unknown;
    try {
      await createStoreProduct(
        fixture.storeId,
        {
          title: 'Never created',
          description: '',
          category: fixture.categorySlug,
          handle: 'never-created',
          imageFileIds: [],
          options: [],
          variants: [
            {
              optionValues: [],
              price: { amount: 500, currency: 'GBP' },
              inventory: { tracked: true, available: 1 },
            },
          ],
        },
        {
          locationId: fixture.locationId,
          source: {
            sourceConnectionId: uuidv7(),
            sourceProvider: 'woocommerce',
            sourceExternalId: 'woo-orphan-1',
            sourceExternalUpdatedAt: null,
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    // By SQLSTATE off the driver error, not by message: drizzle's wrapper prints
    // the SQL rather than the constraint, so a message match would pass on ANY
    // refusal — including the handle unique, which is what this case must be
    // able to tell itself apart from.
    expect(isForeignKeyViolation(caught)).toBe(true);
    expect(await listingsOf(fixture.storeId)).toHaveLength(0);
  });

  it('leaves NO listing behind when a VARIANT is refused', async () => {
    // The gap #221's fix exposed rather than created, and the reason the variants
    // and their stock joined the create's transaction. The refusal has to land
    // AFTER the listing row and BEFORE the commit, or this case measures the
    // listing insert rather than the variant one.
    //
    // The provocation used to be a duplicate SKU, and #296 removed it: a SKU is
    // unique at no grain now, so `product_variants_sku_key` no longer exists to
    // refuse anything. `product_variants_source_external_variant_key` —
    // `UNIQUE(source_connection_id, source_external_variant_id)`, #259's variant
    // identity — is the successor and is a better fit for what this file is
    // about: it is the connector's own key, and the two listings below differ in
    // `sourceExternalId` precisely so the LISTING insert succeeds and the
    // VARIANT insert is what fails. Two platform products claiming one variation
    // id is what a bad normalizer or a re-keyed catalogue produces.
    //
    // While the provenance was written after the transaction too, the leftover
    // carried no `source_connection_id` and every provenance-scoped read stepped
    // over it; with the provenance now on the insert, the same leftover would be
    // a fully sourced product with nothing to sell, which the push-in path never
    // grows a variant for.
    const fixture = await makePullFixture();
    const sharedVariationId = `atomic-variation-${uuidv7()}`;
    const product = (title: string, handle: string) => ({
      title,
      description: '',
      category: fixture.categorySlug,
      handle,
      imageFileIds: [],
      options: [],
      variants: [
        {
          optionValues: [],
          price: { amount: 500, currency: 'GBP' as const },
          inventory: { tracked: true, available: 1 },
        },
      ],
    });
    const importedAs = (externalId: string) => ({
      locationId: fixture.locationId,
      source: {
        sourceConnectionId: fixture.connection.id,
        sourceProvider: 'woocommerce' as const,
        sourceExternalId: externalId,
        sourceExternalUpdatedAt: null,
      },
      variantSources: [
        {
          sourceConnectionId: fixture.connection.id,
          sourceProvider: 'woocommerce' as const,
          sourceExternalVariantId: sharedVariationId,
          sourceExternalInventoryItemId: null,
        },
      ],
    });

    await createStoreProduct(
      fixture.storeId,
      product('First', `first-product-${sharedVariationId}`),
      importedAs(`atomic-product-a-${sharedVariationId}`),
    );

    let caught: unknown;
    try {
      await createStoreProduct(
        fixture.storeId,
        product('Second', `second-product-${sharedVariationId}`),
        importedAs(`atomic-product-b-${sharedVariationId}`),
      );
    } catch (error) {
      caught = error;
    }

    // By CONSTRAINT NAME, not by "some unique failed": a `listings_*` collision
    // would refuse the listing insert instead and this case would pass while
    // measuring nothing about the variant.
    expect(isUniqueViolation(caught, 'product_variants_source_external_variant_key')).toBe(true);
    // ONE listing, not two: the second create left nothing at all.
    const rows = await listingsOf(fixture.storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('First');
  });
});

describe('the connector PULL path strands nothing when a product fails (#221)', () => {
  it('leaves NO listing when the provenance cannot be written, and imports it on the NEXT run', async () => {
    const fixture = await makePullFixture();
    const stranding = normalizedProduct({ externalUpdatedAt: new Date('not a timestamp') });
    installProviderYielding([stranding]);

    const failed = await runBackfill(fixture.storeId, fixture.connection.id);

    // The VACUITY FLOOR, and it comes first: a run that attempted nothing —
    // a provider yielding no products, a fixture whose sync settings turned the
    // product pull off — leaves zero listings too, and would satisfy every
    // assertion below while measuring nothing at all.
    expect(failed.countsFailed).toBe(1);
    expect(failed.countsCreated).toBe(0);
    // The property under test, asserted as a DIRECT count of the store's
    // listings rather than through `findListingBySourceExternalId`: "no listing
    // matched by source" is equally true of a STRAND, which is the exact state
    // this fix exists to prevent. Before the fix there was one row here, with a
    // NULL `source_external_id` and the handle `atomicity-tee` held for good.
    expect(await listingsOf(fixture.storeId)).toHaveLength(0);

    // The consequence, which is the half a merchant actually experiences: the
    // next run of the SAME product imports it. Before the fix this run failed on
    // `listings_store_id_handle_key` — and so did every run after it, forever.
    installProviderYielding([normalizedProduct()]);
    const recovered = await runBackfill(fixture.storeId, fixture.connection.id);

    expect(recovered.countsFailed).toBe(0);
    expect(recovered.countsCreated).toBe(1);

    const imported = await findListingBySourceExternalId(
      fixture.storeId,
      fixture.connection.id,
      'woo-atomic-1',
    );
    expect(imported, 'the recovered run must leave a listing the next sync can MATCH').not.toBeNull();
    expect(imported?.handle).toBe('atomicity-tee');
    expect(imported?.sourceProvider).toBe('woocommerce');
    expect(imported?.sourceExternalUpdatedAt).toEqual(new Date('2026-08-01T10:00:00Z'));
    expect(imported?.status).toBe('active');
  });

  it('imports EXACTLY ONE listing from the same fixture with NO fault — the positive control', async () => {
    // The control for the case above, in the same currency: the identical
    // fixture, the identical provider, the identical run, differing ONLY in the
    // timestamp that makes the import fail. Without it, "zero listings" is
    // equally the reading of a harness that imports nothing at all — a provider
    // that never fires, a store whose category slug does not resolve, a
    // connection whose product pull is off.
    const fixture = await makePullFixture();
    installProviderYielding([normalizedProduct()]);

    const run = await runBackfill(fixture.storeId, fixture.connection.id);

    expect(run.countsFailed).toBe(0);
    expect(run.countsCreated).toBe(1);
    expect(await listingsOf(fixture.storeId)).toHaveLength(1);
  });

  it('leaves every VARIANT carrying its provenance once an import completes', async () => {
    // `stampVariantSources` used to write these after the create committed, so an
    // imported variant existed unstamped — invisible to the inventory sync and to
    // every later match, and `convergeVariants` matches on SKU and option values
    // rather than provenance, so nothing repaired it.
    //
    // What this measures is the END STATE, which the old create-then-stamp also
    // reached on a clean run: it is a regression guard, not evidence of
    // atomicity, and it was named "in the same insert" until a review pointed
    // out that nothing here observes an insert. The atomicity itself is measured
    // by "leaves NO listing behind when a VARIANT is refused" above — the one
    // case that fails against the old code.
    const fixture = await makePullFixture();
    installProviderYielding([normalizedProduct()]);

    await runBackfill(fixture.storeId, fixture.connection.id);

    const [listing] = await listingsOf(fixture.storeId);
    const variants = await findVariantsByListing(listing.id);
    expect(variants).toHaveLength(1);
    expect(variants[0].sourceConnectionId).toBe(fixture.connection.id);
    expect(variants[0].sourceProvider).toBe('woocommerce');
    expect(variants[0].sourceExternalVariantId).toBe('2001');
    expect(variants[0].sourceExternalInventoryItemId).toBe('3001');
  });

  it('leaves a variant carrying NO platform ids stamped all-NULL, never half-stamped', async () => {
    // An end-state regression guard, like the case above rather than like the
    // refusal case: the old code reached this state too on a clean run.
    //
    // The other side of the discriminant, and the property the four columns are
    // carried together for: `findVariantBySourceInventoryItemId` matches on
    // `(sourceConnectionId, sourceExternalInventoryItemId)`, so a variant holding
    // the connection and neither id is exactly as unfindable as an unstamped one
    // while LOOKING synced. That is what the ingest path has always produced.
    const fixture = await makePullFixture();
    const product = normalizedProduct();
    installProviderYielding([
      {
        ...product,
        variants: {
          enumeration: 'complete',
          variants: [
            {
              optionValues: [],
              price: { amount: 1999, currency: 'GBP' },
              inventory: { tracked: true, available: 4 },
              sku: `ATOMIC-BARE-${uuidv7()}`,
            },
          ],
        },
      },
    ]);

    await runBackfill(fixture.storeId, fixture.connection.id);

    const [listing] = await listingsOf(fixture.storeId);
    const variants = await findVariantsByListing(listing.id);
    expect(variants).toHaveLength(1);
    expect(variants[0].sourceConnectionId).toBeNull();
    expect(variants[0].sourceProvider).toBeNull();
    expect(variants[0].sourceExternalVariantId).toBeNull();
    expect(variants[0].sourceExternalInventoryItemId).toBeNull();
  });

  it('holds an imported listing as `draft` when the connection does not auto-publish', async () => {
    // `draft` used to be written by the same second statement the provenance
    // was, so it is the same fix. This asserts the END STATE only — a clean run
    // under the old code reached it too, and nothing here observes the window in
    // which the listing was briefly `active`. Making that window observable would
    // need a read interleaved with the write; what stands instead is that the
    // status is now an argument to the insert, and that the variant-refusal case
    // proves the insert is the only statement.
    const fixture = await makePullFixture({ autoPublish: false });
    installProviderYielding([normalizedProduct()]);

    const run = await runBackfill(fixture.storeId, fixture.connection.id);

    expect(run.countsCreated).toBe(1);
    const [row] = await listingsOf(fixture.storeId);
    expect(row.status).toBe('draft');
    expect(row.sourceExternalId).toBe('woo-atomic-1');
    // Read in the SAME row — see the `createStoreProduct` case for why the two
    // publication facts are asserted together, and for why #261 inverted this from
    // the Date #221 recorded.
    expect(row.publishedAt).toBeNull();
  });

  it('a SECOND sync of an imported product updates it rather than colliding on its handle', async () => {
    // The idempotency this restores, stated over the handle unique that #221
    // turned into a permanent block. End state again: what it guards is that a
    // second sync still converges, not that the first one was atomic.
    const fixture = await makePullFixture();
    installProviderYielding([normalizedProduct()]);

    const first = await runBackfill(fixture.storeId, fixture.connection.id);
    expect(first.countsCreated).toBe(1);

    installProviderYielding([normalizedProduct({ title: 'Atomicity tee (renamed)' })]);
    const second = await runBackfill(fixture.storeId, fixture.connection.id);

    expect(second.countsFailed).toBe(0);
    expect(second.countsCreated).toBe(0);
    expect(second.countsUpdated).toBe(1);

    const rows = await listingsOf(fixture.storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Atomicity tee (renamed)');
  });
});

describe('one listing per provenance key, enforced by the storage (#221)', () => {
  it('REFUSES a second listing carrying the same (store, connection, external id)', async () => {
    // `listings_store_id_source_key_idx` is UNIQUE since #221. Written through
    // `createStoreProduct` twice rather than through the import path, because the
    // import path now CONVERGES on the violation — this case is about the index
    // existing at all, and an index's absence is the one thing a functional test
    // can never detect from a passing import.
    const fixture = await makePullFixture();
    const source = {
      sourceConnectionId: fixture.connection.id,
      sourceProvider: 'woocommerce' as const,
      sourceExternalId: 'woo-duplicate-1',
      sourceExternalUpdatedAt: null,
    };
    const product = (handle: string) => ({
      title: 'Duplicate provenance',
      description: '',
      category: fixture.categorySlug,
      handle,
      imageFileIds: [],
      options: [],
      variants: [
        {
          optionValues: [],
          price: { amount: 500, currency: 'GBP' as const },
          inventory: { tracked: true, available: 1 },
          sku: `DUP-${uuidv7()}`,
        },
      ],
    });

    await createStoreProduct(fixture.storeId, product('duplicate-a'), {
      locationId: fixture.locationId,
      source,
    });

    let caught: unknown;
    try {
      // A DIFFERENT handle, so the refusal cannot be the handle unique — which is
      // the constraint this case must be able to tell itself apart from.
      await createStoreProduct(fixture.storeId, product('duplicate-b'), {
        locationId: fixture.locationId,
        source,
      });
    } catch (error) {
      caught = error;
    }

    expect(isUniqueViolation(caught, 'listings_store_id_source_key_idx')).toBe(true);
    expect(await listingsOf(fixture.storeId)).toHaveLength(1);
  });

  it('ADMITS two listings whose provenance differs only in external id', async () => {
    // The positive control on the index's SCOPE. Without it, an index over the
    // wrong columns — or one accidentally made unique on `(store, connection)`
    // alone — would pass the case above while refusing every second product a
    // connection imports, which is a connector that can hold exactly one item.
    const fixture = await makePullFixture();
    const product = (handle: string, externalId: string) => ({
      title: `Distinct ${externalId}`,
      description: '',
      category: fixture.categorySlug,
      handle,
      imageFileIds: [],
      options: [],
      variants: [
        {
          optionValues: [],
          price: { amount: 500, currency: 'GBP' as const },
          inventory: { tracked: true, available: 1 },
          sku: `DISTINCT-${uuidv7()}`,
        },
      ],
    });
    const sourceFor = (externalId: string) => ({
      sourceConnectionId: fixture.connection.id,
      sourceProvider: 'woocommerce' as const,
      sourceExternalId: externalId,
      sourceExternalUpdatedAt: null,
    });

    await createStoreProduct(fixture.storeId, product('distinct-a', 'woo-a'), {
      locationId: fixture.locationId,
      source: sourceFor('woo-a'),
    });
    await createStoreProduct(fixture.storeId, product('distinct-b', 'woo-b'), {
      locationId: fixture.locationId,
      source: sourceFor('woo-b'),
    });

    expect(await listingsOf(fixture.storeId)).toHaveLength(2);
  });

  it('ADMITS many UNSOURCED listings — the partial predicate', async () => {
    // Two merchant-created products carry NULL provenance. Postgres treats NULLs
    // as distinct so a plain unique would admit them anyway; what this pins is
    // that the predicate was not dropped or widened into one that constrains the
    // merchant path, which would refuse a store its second hand-written product.
    const fixture = await makePullFixture();
    const product = (handle: string) => ({
      title: `Merchant ${handle}`,
      description: '',
      category: fixture.categorySlug,
      handle,
      imageFileIds: [],
      options: [],
      variants: [
        {
          optionValues: [],
          price: { amount: 500, currency: 'GBP' as const },
          inventory: { tracked: true, available: 1 },
          sku: `UNSOURCED-${uuidv7()}`,
        },
      ],
    });

    await createStoreProduct(fixture.storeId, product('unsourced-a'), {
      locationId: fixture.locationId,
    });
    await createStoreProduct(fixture.storeId, product('unsourced-b'), {
      locationId: fixture.locationId,
    });

    expect(await listingsOf(fixture.storeId)).toHaveLength(2);
  });

  it('MIGRATION 0070 converges a pre-existing duplicate instead of aborting', async () => {
    // `CREATE UNIQUE INDEX` fails at APPLY time on an existing duplicate, and the
    // duplicates that exist are exactly the ones this bug produced — so assuming a
    // clean table is assuming the defect never fired. This drives the SHIPPED
    // statements, read out of the `.sql` file, against a deliberately violating
    // pair. Reading the file rather than restating the SQL is the point: a
    // regeneration that drops the hand-written UPDATE turns this red, because the
    // `CREATE UNIQUE INDEX` then aborts on the pair below.
    //
    // The transaction COMMITS rather than rolling back, and that is deliberate: the
    // shipped statements END by recreating the unique index, so the schema this
    // shared database carries is the same before and after. A failure part-way
    // aborts and restores it too, so neither outcome leaves a sibling file running
    // against a table whose index this test removed.
    const fixture = await makePullFixture();
    const statements = shippedMigrationStatements();

    // The vacuity floor on the FILE: an empty or comment-only parse would make
    // every assertion below pass while executing nothing at all.
    expect(statements.length).toBe(3);
    expect(statements[0]).toMatch(/^UPDATE "listings"/);
    expect(statements[2]).toMatch(/^CREATE UNIQUE INDEX/);

    const older = uuidv7();
    const newer = uuidv7();
    await db.transaction(async (tx) => {
      // Back to the PRE-migration state: the index as it shipped before #221.
      await tx.execute(sql.raw('DROP INDEX "listings_store_id_source_key_idx"'));
      await tx.execute(
        sql.raw(
          'CREATE INDEX "listings_store_id_source_key_idx" ON "listings" ' +
            'USING btree ("store_id","source_connection_id","source_external_id") ' +
            'WHERE "listings"."source_external_id" is not null',
        ),
      );

      // The pair the old code could produce: one provenance key, two rows, two
      // handles. `created_at` is written explicitly and an hour apart — the rule is
      // `created_at asc, id asc`, and two rows from a lost race can share a
      // millisecond, so a fixture relying on insertion order would be measuring
      // uuid v7's within-millisecond ordering, which this repo does not have.
      const duplicate = (id: string, title: string, handle: string, createdAt: string) => ({
        id,
        ownerType: 'store' as const,
        storeId: fixture.storeId,
        title,
        description: '',
        condition: 'new' as const,
        conditionAssertion: 'source_declared' as const,
        status: 'active' as const,
        categorySlugs: [] as string[],
        tags: [] as string[],
        handle,
        hasInventory: false,
        variantCount: 0,
        overriddenFields: [] as string[],
        sourceConnectionId: fixture.connection.id,
        sourceProvider: 'woocommerce' as const,
        sourceExternalId: 'woo-preexisting-duplicate',
        createdAt: new Date(createdAt),
      });
      await tx.insert(listings).values(duplicate(older, 'Older survivor', 'dup-older', '2026-08-01T10:00:00Z'));
      await tx.insert(listings).values(duplicate(newer, 'Newer duplicate', 'dup-newer', '2026-08-01T11:00:00Z'));

      for (const statement of statements) {
        await tx.execute(sql.raw(statement));
      }
    });

    const rows = await listingsOf(fixture.storeId);
    // NOTHING was deleted — eighteen foreign keys CASCADE from `listings`, so a
    // resolution that deleted the loser would take commercial history with it.
    expect(rows).toHaveLength(2);

    const survivor = rows.find((row) => row.id === older);
    const cleared = rows.find((row) => row.id === newer);
    // The OLDEST keeps the provenance: it has had the longest to accumulate the
    // things that point at a listing.
    expect(survivor?.sourceExternalId).toBe('woo-preexisting-duplicate');
    expect(survivor?.sourceConnectionId).toBe(fixture.connection.id);
    expect(survivor?.sourceProvider).toBe('woocommerce');
    // The loser leaves the partial index by having its provenance CLEARED — all
    // four columns, never some of them.
    expect(cleared?.sourceExternalId).toBeNull();
    expect(cleared?.sourceConnectionId).toBeNull();
    expect(cleared?.sourceProvider).toBeNull();
    expect(cleared?.sourceExternalUpdatedAt).toBeNull();
    // `status` is untouched: archiving the loser would delist something a merchant
    // may be actively selling, which is not a migration's decision.
    expect(cleared?.status).toBe('active');

    // And the index really is unique afterwards — otherwise this case would pass
    // against a migration that resolved the duplicate and never constrained
    // anything, which is the failure the whole file exists to prevent.
    const [sourced] = await listingsOf(fixture.storeId);
    expect(sourced).toBeDefined();
    let caught: unknown;
    try {
      await createStoreProduct(
        fixture.storeId,
        {
          title: 'Third claimant',
          description: '',
          category: fixture.categorySlug,
          handle: 'dup-third',
          imageFileIds: [],
          options: [],
          variants: [
            {
              optionValues: [],
              price: { amount: 500, currency: 'GBP' },
              inventory: { tracked: true, available: 1 },
              sku: `DUP3-${uuidv7()}`,
            },
          ],
        },
        {
          locationId: fixture.locationId,
          source: {
            sourceConnectionId: fixture.connection.id,
            sourceProvider: 'woocommerce',
            sourceExternalId: 'woo-preexisting-duplicate',
            sourceExternalUpdatedAt: null,
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught, 'listings_store_id_source_key_idx')).toBe(true);
  });

  it('CONVERGES an import that loses the race, rather than failing the product', async () => {
    // The retry-by-lookup. The race itself is a read-then-insert window that a
    // test cannot open deterministically, so the row the winner would have
    // written is created FIRST, out of band — which puts `importProduct` in
    // exactly the state a loser is in: its own `findListingBySourceExternalId`
    // returned null (it ran before this row existed, which is what the fixture
    // reproduces by importing a product whose provenance is already taken).
    const fixture = await makePullFixture();
    const winner = normalizedProduct();

    installProviderYielding([winner]);
    const first = await runBackfill(fixture.storeId, fixture.connection.id);
    expect(first.countsCreated).toBe(1);

    // A second delivery of the SAME product. It takes the update branch through
    // the ordinary read — the convergence the unique now also guarantees for the
    // racing case is the same convergence, arrived at one statement earlier.
    installProviderYielding([normalizedProduct({ title: 'Raced rename' })]);
    const second = await runBackfill(fixture.storeId, fixture.connection.id);

    expect(second.countsFailed).toBe(0);
    const rows = await listingsOf(fixture.storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Raced rename');
  });
});

describe('the channel PUSH-IN path strands nothing either (#221)', () => {
  /**
   * A push-in fixture. The service reads `externalUpdatedAt` as text and builds
   * the `Date` itself, so an unreadable value produces the same invalid `Date`
   * the pull path's provider handed over — one code shape, one failure, both
   * directions. `ingestProductsSchema` narrows this field at the HTTP boundary
   * today; the case is about the SERVICE's own contract, which is what the
   * WordPress plugin push and every later caller reach.
   */
  async function makePushInFixture(): Promise<Fixture> {
    const suffix = uuidv7();
    const store = await insertStore(
      {
        handle: `ingest-atomicity-${suffix}`,
        name: 'Ingest atomicity store',
        description: '',
        brandColor: '#123456',
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
      key: `atomicity-ingests-${suffix}`,
      name: 'Atomicity ingests',
      slug: `atomicity-ingests-${suffix}`,
    });
    createdCategoryIds.push(category.id);
    process.env.CONNECTOR_DEFAULT_CATEGORY_SLUG = category.slug;

    const connection = await connectPushIn(store.id, 'woocommerce', {
      shopDomain: 'ingest-atomicity.example.test',
    });

    return {
      storeId: store.id,
      categorySlug: category.slug,
      locationId: location.id,
      connection,
    };
  }

  /** One pushed product; `handle` is again what makes the strand permanent. */
  function ingestBody(externalUpdatedAt: string | undefined, title = 'Pushed tee') {
    return {
      products: [
        {
          externalId: 'plugin-1',
          title,
          description: '<p>Pushed</p>',
          handle: 'pushed-tee',
          images: [],
          options: [],
          ...(externalUpdatedAt === undefined ? {} : { externalUpdatedAt }),
          variants: [
            {
              optionValues: [],
              price: { amount: 2500, currency: 'GBP' as const },
              inventory: { available: 3 },
              sku: `PUSHED-${uuidv7()}`,
            },
          ],
        },
      ],
    };
  }

  it('leaves NO listing when the provenance cannot be written, and accepts the RETRY', async () => {
    const fixture = await makePushInFixture();

    const failed = await ingestProducts(
      fixture.storeId,
      fixture.connection.id,
      ingestBody('not a timestamp'),
    );

    expect(failed.results[0].action).toBe('failed');
    expect(failed.results[0].listingId).toBeUndefined();
    expect(await listingsOf(fixture.storeId)).toHaveLength(0);

    // Before the fix the retry failed on `listings_store_id_handle_key`, and the
    // plugin's every later push of that product failed with it.
    const retried = await ingestProducts(
      fixture.storeId,
      fixture.connection.id,
      ingestBody('2026-08-01T10:00:00.000Z'),
    );

    expect(retried.results[0].action).toBe('created');
    const created = await findListingBySourceExternalId(
      fixture.storeId,
      fixture.connection.id,
      'plugin-1',
    );
    expect(created, 'the retry must leave a listing the next push can MATCH').not.toBeNull();
    expect(created?.sourceExternalUpdatedAt).toEqual(new Date('2026-08-01T10:00:00.000Z'));
    // `connectPushIn` leaves `autoPublish` at its column default of false, so a
    // pushed listing is held as `draft` — written by the same insert.
    expect(created?.status).toBe('draft');
  });

  it('a SECOND push of the same product updates it rather than colliding on its handle', async () => {
    const fixture = await makePushInFixture();

    const first = await ingestProducts(
      fixture.storeId,
      fixture.connection.id,
      ingestBody('2026-08-01T10:00:00.000Z'),
    );
    expect(first.results[0].action).toBe('created');

    const second = await ingestProducts(
      fixture.storeId,
      fixture.connection.id,
      ingestBody('2026-08-02T10:00:00.000Z', 'Pushed tee (renamed)'),
    );

    expect(second.results[0].action).toBe('updated');
    const rows = await listingsOf(fixture.storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Pushed tee (renamed)');
  });
});
