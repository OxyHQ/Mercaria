/**
 * NAMING A HANDLE COLLISION, AND NOT PUBLISHING RAW SQL (#292).
 *
 * Two properties, and neither exists without a real Postgres server: one is what
 * a UNIQUE INDEX does when two rows claim `listings_store_id_handle_key`, and the
 * other is what the DRIVER puts in an error when it refuses. A mocked `update`
 * accepts the statement the server rejects, and a hand-built `Error` carries
 * whatever the test author typed — which for the second property would mean
 * measuring the fixture instead of the defect.
 *
 * ## What #292 actually turned out to be
 *
 * The issue reports that a merchant on the WooCommerce PULL connector who then
 * installs the plugin gets a push where every product fails on
 * `listings_store_id_handle_key`. That mechanism is UNREACHABLE: `connections` is
 * `UNIQUE(store_id, provider)` with `mode` a column on that same row, so one store
 * cannot hold two WooCommerce connections; no production code deletes a
 * connection; and both rails write the same `source_external_id`, so a push
 * converges on the pulled listing through `findListingBySourceExternalId`. The
 * failure the #69 run actually hit was the table-wide SKU/barcode uniques, across
 * two stores — which is #296, and is fixed.
 *
 * What #292 asks for beyond that mechanism is real and was unmet: "at minimum the
 * failure should name the collision and the connection holding the incumbent
 * handle, rather than surfacing as a generic per-product error." A collision IS
 * reachable, by the three routes below, and until now every one of them surfaced
 * as a bare `23505` or as a drizzle statement dump.
 *
 * ## The vacuity floor on the raw-SQL cases
 *
 * "The stored message contains no `insert into`" is also what a test passes with
 * when its fixture never produced one. Every such case first asserts the POSITIVE
 * control — that the driver error it is about to hand over really does carry the
 * statement and its bound parameters — so a zero means the classifier removed it
 * rather than that there was nothing to remove.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { CurrencyCode } from '@mercaria/shared-types';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { connections, syncRuns } from '../../db/schema/connectors.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { insertCategory } from '../../db/taxonomy/taxonomyRepository.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { insertLocation } from '../../db/stores/locationRepository.js';
import { updateListingColumns } from '../../db/catalog/listingRepository.js';
import {
  finishSyncRun,
  insertSyncRun,
  type SyncRunRecord,
} from '../../db/connectors/syncRunRepository.js';
import { upsertConnection, type ConnectionRow } from '../../db/connectors/connectionRepository.js';
import { createStoreProduct, updateListing } from '../catalog-write.service.js';
import { ingestProducts } from '../channel-ingest.service.js';
import { validationError } from '../../lib/errors/error-codes.js';
import {
  MERCHANT_FACING_MESSAGE_MAX_LENGTH,
  UNCLASSIFIED_FAILURE_MESSAGE,
} from '../../lib/errors/merchant-facing.js';

const OWNER_USER = 'oxy-user-handle-identity';

let db: Database;
const createdStoreIds: string[] = [];
const createdCategoryIds: string[] = [];

beforeAll(async () => {
  process.env.CONNECTOR_ENCRYPTION_KEY = 'c'.repeat(64);
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    // Order is load-bearing: `listings.store_id` and `connections.store_id` are
    // `ON DELETE RESTRICT` so a live connection cannot be dropped out from under
    // the provenance pointing at it. Runs cascade from their connection.
    await db.delete(listings).where(eq(listings.storeId, storeId));
    await db.delete(connections).where(eq(connections.storeId, storeId));
    await deleteTestStores(db, [storeId]);
  }
  for (const categoryId of createdCategoryIds.splice(0)) {
    await db.delete(categories).where(eq(categories.id, categoryId));
  }
});

afterAll(async () => {
  await closePostgres();
});

/** A store with a default location and an import category — what a create needs. */
async function makeStore(): Promise<string> {
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `handle-identity-${suffix}`,
      name: 'Handle identity store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: OWNER_USER, role: 'owner', permissions: ['store:manage', 'channels:write'] }],
  );
  createdStoreIds.push(store.id);
  await insertLocation(store.id, {
    name: 'Default location',
    type: 'warehouse',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
  });
  const category = await insertCategory({
    key: `handle-identity-${suffix}`,
    name: 'Handle identity imports',
    slug: `handle-identity-${suffix}`,
  });
  createdCategoryIds.push(category.id);
  process.env.CONNECTOR_DEFAULT_CATEGORY_SLUG = category.slug;
  return category.slug;
}

/** A connected push-in connection for one provider of a store. */
async function makeConnection(
  storeId: string,
  provider: 'woocommerce' | 'shopify',
  shopDomain: string,
): Promise<ConnectionRow> {
  return upsertConnection(storeId, provider, {
    mode: 'push_in',
    status: 'connected',
    connectedAt: new Date(),
    shopDomain,
    shopCurrency: 'EUR',
  });
}

/** The minimal store-product input, with whatever handle a case needs. */
function productInput(categorySlug: string, handle: string, title = 'A product') {
  return {
    title,
    description: 'A product',
    category: categorySlug,
    imageFileIds: [],
    options: [],
    handle,
    variants: [
      {
        optionValues: [],
        price: { amount: 1500, currency: 'EUR' as const },
        inventory: { tracked: true, available: 4 },
      },
    ],
  };
}

/** The message of whatever `run` threw, or a marker if it did not throw at all. */
async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return 'DID NOT THROW';
}

describe('a handle collision names the incumbent (#292 part A)', () => {
  it('route 1: a re-sync moving a handle onto a sibling of the SAME connection', async () => {
    const categorySlug = await makeStore();
    const storeId = createdStoreIds[0];
    const conn = await makeConnection(storeId, 'woocommerce', 'shop.example.test');
    const source = {
      sourceConnectionId: conn.id,
      sourceProvider: conn.provider,
      sourceExternalId: 'ext-incumbent',
      sourceExternalUpdatedAt: null,
    };

    await createStoreProduct(storeId, productInput(categorySlug, 'incumbent-handle'), { source });
    const moverId = await createStoreProduct(storeId, productInput(categorySlug, 'mover-handle'), {
      source: { ...source, sourceExternalId: 'ext-mover' },
    });

    // Exactly what both rails' `toUpdatePatch` produces when the platform renames
    // a product onto a slug a sibling already holds.
    const message = await refusalOf(() =>
      updateListing(moverId, { handle: 'incumbent-handle' }, { kind: 'source' }),
    );

    expect(message).toContain('incumbent-handle');
    expect(message).toContain('ext-incumbent');
    expect(message).toContain('woocommerce');
    expect(message).toContain('shop.example.test');
    expect(message).toContain(conn.id);
    // The refusal never claims the incumbent is on ANOTHER channel: on this route
    // it is a sibling of the very connection syncing, and `updateListing` is not
    // told which connection that is, so such a claim would be a false one.
    expect(message).not.toContain('another channel');
  });

  it('route 2: a merchant-created product, which no sync can ever reconcile', async () => {
    const categorySlug = await makeStore();
    const storeId = createdStoreIds[0];
    const conn = await makeConnection(storeId, 'woocommerce', 'shop.example.test');

    // No `source`: all four `source_*` columns land NULL, which is the whole
    // reason this collision is permanent rather than self-healing.
    const merchantListingId = await createStoreProduct(
      storeId,
      productInput(categorySlug, 'merchant-handle', 'Made in Mercaria'),
      {},
    );

    const message = await refusalOf(() =>
      createStoreProduct(storeId, productInput(categorySlug, 'merchant-handle'), {
        source: {
          sourceConnectionId: conn.id,
          sourceProvider: conn.provider,
          sourceExternalId: 'ext-incoming',
          sourceExternalUpdatedAt: null,
        },
      }),
    );

    expect(message).toContain('merchant-handle');
    expect(message).toContain(merchantListingId);
    expect(message).toContain('created directly in Mercaria');
    expect(message).toContain('no sync will ever');
    // It must NOT invent a channel for a listing that has none.
    expect(message).not.toContain('woocommerce');
    expect(message).not.toContain(conn.id);
  });

  it('route 3: two connections of DIFFERENT providers on one store', async () => {
    const categorySlug = await makeStore();
    const storeId = createdStoreIds[0];
    // `connections_store_id_provider_key` bars a second connection of the SAME
    // provider and nothing else, which is what makes this route reachable.
    const shopify = await makeConnection(storeId, 'shopify', 'incumbent.myshopify.test');
    const woo = await makeConnection(storeId, 'woocommerce', 'rival.example.test');
    expect(shopify.id).not.toBe(woo.id);

    const incumbentId = await createStoreProduct(
      storeId,
      productInput(categorySlug, 'shared-handle'),
      {
        source: {
          sourceConnectionId: shopify.id,
          sourceProvider: shopify.provider,
          sourceExternalId: 'shopify-1',
          sourceExternalUpdatedAt: null,
        },
      },
    );

    const message = await refusalOf(() =>
      createStoreProduct(storeId, productInput(categorySlug, 'shared-handle'), {
        source: {
          sourceConnectionId: woo.id,
          sourceProvider: woo.provider,
          sourceExternalId: 'woo-1',
          sourceExternalUpdatedAt: null,
        },
      }),
    );

    expect(message).toContain(incumbentId);
    expect(message).toContain('shopify');
    expect(message).toContain('incumbent.myshopify.test');
    expect(message).toContain(shopify.id);
    // It names the INCUMBENT's channel, never the one that just lost.
    expect(message).not.toContain(woo.id);
    expect(message).not.toContain('rival.example.test');
  });

  it('surfaces through the push rail as a per-product failure that isolates the batch', async () => {
    const categorySlug = await makeStore();
    const storeId = createdStoreIds[0];
    const conn = await makeConnection(storeId, 'woocommerce', 'plugin.example.test');

    await createStoreProduct(storeId, productInput(categorySlug, 'taken-handle'), {});

    // Two products in one push: the first collides, the second must still land.
    // The isolation posture is #292's explicit constraint — this stays a
    // per-product failure, and what changed is only that it now says what it is.
    const result = await ingestProducts(storeId, conn.id, {
      products: [
        {
          externalId: 'push-collides',
          title: 'Collides',
          description: '',
          images: [],
          handle: 'taken-handle',
          variants: [{ price: { amount: 900, currency: 'EUR' }, inventory: { available: 1 } }],
        },
        {
          externalId: 'push-lands',
          title: 'Lands',
          description: '',
          images: [],
          handle: 'free-handle',
          variants: [{ price: { amount: 900, currency: 'EUR' }, inventory: { available: 1 } }],
        },
      ],
    } as Parameters<typeof ingestProducts>[2]);

    const [collided, landed] = result.results;
    expect(collided.action).toBe('failed');
    expect(collided.error).toContain('taken-handle');
    expect(collided.error).toContain('created directly in Mercaria');
    expect(landed.action).toBe('created');

    // The per-product string is the OTHER merchant-visible carriage of the same
    // defect: it must not be a statement dump either.
    expect(collided.error).not.toContain('insert into');
    expect(collided.error).not.toContain('params:');
  });
});

describe('sync_runs.error is classified and bounded (#292 part B)', () => {
  /**
   * A GENUINE drizzle-wrapped `23505`, obtained by really violating the index
   * through the raw repository write — the one path with no classifier on it.
   * Nothing here is hand-built, because the property under test is what the
   * DRIVER puts in a message.
   */
  async function realHandleViolation(categorySlug: string, storeId: string): Promise<unknown> {
    await createStoreProduct(storeId, productInput(categorySlug, 'first-handle'), {});
    const secondId = await createStoreProduct(
      storeId,
      productInput(categorySlug, 'second-handle'),
      {},
    );
    try {
      await updateListingColumns(secondId, { handle: 'first-handle' });
    } catch (err) {
      return err;
    }
    throw new Error('fixture did not violate listings_store_id_handle_key');
  }

  async function storedError(conn: ConnectionRow, failure: unknown): Promise<SyncRunRecord> {
    const run = await insertSyncRun(conn.id, 'webhook');
    return finishSyncRun(run.id, {
      status: 'failed',
      counts: { created: 0, updated: 0, skipped: 0, failed: 1 },
      failure,
    });
  }

  it('replaces a driver statement dump with the rule that was broken', async () => {
    const categorySlug = await makeStore();
    const storeId = createdStoreIds[0];
    const conn = await makeConnection(storeId, 'woocommerce', 'shop.example.test');

    const driverError = await realHandleViolation(categorySlug, storeId);

    // POSITIVE CONTROL. Without this the assertions below are what a test passes
    // with when its fixture produced a tidy error in the first place — which is
    // exactly how "we found less" and "there is less" become indistinguishable.
    const raw = (driverError as Error).message;
    expect(raw).toContain('update "listings"');
    expect(raw).toContain('params:');
    expect(raw.length).toBeGreaterThan(200);
    // And the measured reason the old message could not even name the rule:
    // drizzle replaces the driver's message with its own.
    expect(raw).not.toContain('listings_store_id_handle_key');

    const closed = await storedError(conn, driverError);

    expect(closed.error).not.toBeNull();
    expect(closed.error).not.toContain('update "listings"');
    expect(closed.error).not.toContain('params:');
    expect(closed.error).not.toContain('first-handle');
    expect(closed.error).toContain('URL handle');
    expect(closed.error!.length).toBeLessThanOrEqual(MERCHANT_FACING_MESSAGE_MAX_LENGTH);
  });

  it('names the rule and the code for a constraint nobody mapped', async () => {
    const categorySlug = await makeStore();
    const storeId = createdStoreIds[0];
    const conn = await makeConnection(storeId, 'woocommerce', 'shop.example.test');

    // A store handle collision — a real unique this map deliberately does not
    // carry an entry for, so it exercises the DEFAULT rather than the map.
    let driverError: unknown;
    try {
      await insertStore(
        {
          handle: `handle-identity-${categorySlug.replace('handle-identity-', '')}`,
          name: 'Duplicate handle store',
          description: '',
          brandColor: '#123456',
          defaultCurrency: 'FAIR',
        },
        [{ oxyUserId: OWNER_USER, role: 'owner', permissions: [] }],
      );
    } catch (err) {
      driverError = err;
    }
    expect(driverError).toBeDefined();
    expect((driverError as Error).message).toContain('params:');

    const closed = await storedError(conn, driverError);

    expect(closed.error).toContain('rule ');
    expect(closed.error).toContain('code 23505');
    expect(closed.error).not.toContain('params:');
    expect(closed.error).not.toContain('insert into');
  });

  it('keeps a refusal this repository composed, and bounds an overlong one', async () => {
    const categorySlug = await makeStore();
    const storeId = createdStoreIds[0];
    void categorySlug;
    const conn = await makeConnection(storeId, 'woocommerce', 'shop.example.test');

    const kept = await storedError(conn, validationError('WooCommerce order 41 has no line items'));
    expect(kept.error).toBe('WooCommerce order 41 has no line items');

    // The case the bound exists for: a zod dump interpolated into a
    // `validationError`, which IS a MercariaError and would otherwise ride the
    // "ours is safe" branch whole into the column.
    const overlong = await storedError(conn, validationError(`Malformed: ${'x'.repeat(4000)}`));
    expect(overlong.error!.length).toBe(MERCHANT_FACING_MESSAGE_MAX_LENGTH);
    expect(overlong.error!.endsWith('…')).toBe(true);
  });

  it('refuses to republish a message nobody composed', async () => {
    const categorySlug = await makeStore();
    void categorySlug;
    const storeId = createdStoreIds[0];
    const conn = await makeConnection(storeId, 'woocommerce', 'shop.example.test');

    // A bare `Error` is not ours and carries no SQLSTATE: whatever an upstream
    // library put in it is not a sentence Mercaria decided to show a merchant.
    const closed = await storedError(conn, new Error('ECONNRESET at line 4 of vendor.js'));
    expect(closed.error).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
    expect(closed.error).not.toContain('vendor.js');
  });

  it('classifies a DRIVER failure on the per-product carriage too', async () => {
    const categorySlug = await makeStore();
    void categorySlug;
    const storeId = createdStoreIds[0];
    const conn = await makeConnection(storeId, 'woocommerce', 'plugin.example.test');

    // A currency outside the CHECK the money columns carry. `CurrencyCode` is
    // Mercaria's BELIEF about what a wire field holds; the wire holds a string,
    // and this drives the SERVICE rather than the route, so the zod that would
    // have narrowed it never runs — which is exactly the path a driver error
    // arrives on. One assertion, to a real type, standing for that gap.
    const unsupportedCurrency = 'ZZZ' as CurrencyCode;
    //
    // Without this case the push-rail assertions above pass whether or not
    // `channel-ingest.service` classifies at all — every error they produce is
    // already a `MercariaError`, whose message the raw `err.message` it replaced
    // would have carried identically.
    const result = await ingestProducts(storeId, conn.id, {
      products: [
        {
          externalId: 'push-bad-currency',
          title: 'Bad currency',
          description: '',
          images: [],
          variants: [
            { price: { amount: 900, currency: unsupportedCurrency }, inventory: { available: 1 } },
          ],
        },
      ],
    } as Parameters<typeof ingestProducts>[2]);

    const [failed] = result.results;
    expect(failed.action).toBe('failed');
    expect(failed.error).not.toContain('insert into');
    expect(failed.error).not.toContain('params:');
    expect(failed.error!.length).toBeLessThanOrEqual(MERCHANT_FACING_MESSAGE_MAX_LENGTH);
    // A CHECK violation, named by its rule and its code rather than its statement.
    expect(failed.error).toContain('code 23514');
  });

  it('writes NULL when a run had no failure at all', async () => {
    const categorySlug = await makeStore();
    void categorySlug;
    const storeId = createdStoreIds[0];
    const conn = await makeConnection(storeId, 'woocommerce', 'shop.example.test');

    const run = await insertSyncRun(conn.id, 'backfill');
    const closed = await finishSyncRun(run.id, {
      status: 'completed',
      counts: { created: 1, updated: 0, skipped: 0, failed: 0 },
    });
    expect(closed.error).toBeNull();

    // And the column really is readable as NULL rather than an empty string,
    // which the dashboard renders identically but means something different.
    const [row] = await db.select().from(syncRuns).where(eq(syncRuns.id, run.id));
    expect(row.error).toBeNull();
  });
});
