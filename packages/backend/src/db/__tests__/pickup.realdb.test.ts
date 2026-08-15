/**
 * Location publication, nearby discovery and collection against a REAL
 * PostgreSQL server — issue #93.
 *
 * Everything here is held by a CHECK, a trigger, a GENERATED PostGIS column, a
 * GiST index or a conditional UPDATE, and NONE of those exists under a mocked
 * repository. A mocked `insert` accepts the null island, a coordinate with no
 * longitude, a `collected` row with no instant and a second collection of a
 * parcel already handed over — each of which would look green and ship broken.
 *
 * The acceptance criteria this file answers directly:
 *
 *  1. A store location with current stock appears on the correct canonical
 *     variant near the user.
 *  2. Stale, private, inactive and zero-stock locations do NOT appear.
 *  3. Pickup reserves the exact location's stock (asserted through the same
 *     `reserve` the checkout calls, at the level grain).
 *  4. P2P proximity exposes no precise coordinate — there is no column for one.
 *  7. Geo, inventory-race, privacy and location-state tests pass.
 * 14. Collection is idempotent and cannot mark the order collected twice.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers, so every name and handle carries a per-run suffix and
 * teardown deletes exactly what it created — children first, since
 * `order_pickups` RESTRICTs against both `locations` and `location_publications`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { listings, productVariants, inventoryLevels } from '../schema/catalog.js';
import { locations, stores } from '../schema/stores.js';
import { orders } from '../schema/orders.js';
import { canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';
import { nativeListingLinks } from '../schema/offers.js';
import {
  listingLocalDiscovery,
  locationClosures,
  locationOpeningHours,
  locationPublicationEvents,
  locationPublications,
  orderPickups,
  pickupCollectionCredentials,
  pickupCollectionEvents,
} from '../schema/pickup.js';
import {
  findCanonicalProductsWithNearbyCollection,
  findNearbyCollectableLocations,
  findNearbyPlaceSuggestions,
  findNearestPickupDistanceByVariant,
  findPickupCandidate,
} from '../pickup/nearbyRepository.js';
import {
  appendCollectionEvent,
  ensureCollectionCredential,
  rotateCollectionCredential,
} from '../pickup/collectionRepository.js';
import {
  insertOrderPickup,
  markCollected,
  markPickupCancelled,
  markReadyForPickup,
} from '../pickup/orderPickupRepository.js';
import { reserveAtLocation } from '../catalog/inventoryLevelRepository.js';
import { withTriggerToggleLock } from './trigger-toggle-lock.js';
import { deleteTestStores } from './store-teardown.js';
import { deleteTestCanonicalRows } from './canonical-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

/** Barcelona, Plaça de Catalunya — the origin every distance here is from. */
const ORIGIN = { latitude: 41.3874, longitude: 2.1686 };
/** Sagrada Família — about 2 km from the origin. */
const NEARBY = { latitude: 41.4036, longitude: 2.1744 };
/** Madrid — about 500 km away, so outside every radius used here. */
const FAR = { latitude: 40.4168, longitude: -3.7038 };

const createdStoreIds: string[] = [];
const createdListingIds: string[] = [];
const createdLocationIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];
const createdOrderIds: string[] = [];

/** `inArray` on an empty list renders `false`; a sentinel keeps the SQL valid. */
function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  // The two append-only triggers refuse a DELETE — including one arriving
  // through a parent's CASCADE — so this teardown has to stand them down. Two
  // windows, ONE TABLE EACH, and that is the load-bearing part rather than a
  // tidiness preference.
  //
  // `ALTER TABLE … DISABLE TRIGGER` takes ShareRowExclusive, which does NOT
  // conflict with the AccessShare a reader holds but DOES conflict with the
  // RowExclusive every ordinary INSERT/UPDATE/DELETE holds. So the counterparty
  // is a plain writer, and `withTriggerToggleLock` cannot see it — the mutex
  // serialises window against window. A single window holding one table's lock
  // while acquiring a second's forms a cycle with any writer taking that pair
  // the other way round, and deadlocks (40P01). One disable per window leaves
  // exactly one STRONG lock held at a time and every other lock RowExclusive,
  // which never conflicts with another RowExclusive.
  //
  // The DELETES stay children-first across the two windows, and everything the
  // triggers cannot see stays OUTSIDE both — the narrowest window blocks the
  // fewest siblings. The transaction is still what makes a throw safe: the DDL
  // rolls back with it, where on the pool it would autocommit and leave an
  // append-only trigger off for the rest of the run, every later file asserting
  // it refuses a write then passing vacuously.

  // `order_pickups` is `restrict` onto both `locations` and
  // `location_publications`, so it goes first and needs no trigger down.
  await db.delete(orderPickups).where(inArray(orderPickups.orderId, safeIds(createdOrderIds)));

  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(
      sql`alter table pickup_collection_events disable trigger pickup_collection_events_append_only`,
    );
    await tx
      .delete(pickupCollectionEvents)
      .where(inArray(pickupCollectionEvents.orderId, safeIds(createdOrderIds)));
    await tx.execute(
      sql`alter table pickup_collection_events enable trigger pickup_collection_events_append_only`,
    );
  });

  await db
    .delete(pickupCollectionCredentials)
    .where(inArray(pickupCollectionCredentials.orderId, safeIds(createdOrderIds)));
  await db
    .delete(listingLocalDiscovery)
    .where(inArray(listingLocalDiscovery.listingId, safeIds(createdListingIds)));
  await db
    .delete(nativeListingLinks)
    .where(inArray(nativeListingLinks.canonicalVariantId, safeIds(createdVariantIds)));
  await db.delete(listings).where(inArray(listings.id, safeIds(createdListingIds)));

  // `location_publications` CASCADEs into `location_publication_events`, so the
  // trigger this window stands down fires on a delete this statement never
  // names.
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(
      sql`alter table location_publication_events disable trigger location_publication_events_append_only`,
    );
    await tx
      .delete(locationPublications)
      .where(inArray(locationPublications.locationId, safeIds(createdLocationIds)));
    await tx.execute(
      sql`alter table location_publication_events enable trigger location_publication_events_append_only`,
    );
  });

  await db.delete(locations).where(inArray(locations.id, safeIds(createdLocationIds)));
  await db.delete(orders).where(inArray(orders.id, safeIds(createdOrderIds)));
  // The shared helpers, not a direct delete: `deleteTestStores` clears the
  // `native_store_links` a sibling's backfill may have minted against a store
  // this file owns, and `deleteTestCanonicalRows` DECLINES exactly the rows a
  // sibling's `match_decisions` pins rather than deleting somebody else's row.
  // Both are what the fixture censuses require, and both exist because a
  // correctly-scoped teardown can still be blocked by a row a sibling minted.
  await deleteTestStores(db, createdStoreIds);
  await deleteTestCanonicalRows(db, {
    productIds: createdProductIds,
    variantIds: createdVariantIds,
  });
  await closePostgres();
});

/**
 * Assert a write is refused by the named CLASS of constraint.
 *
 * Distinguishing check from trigger matters: both refuse the write, and a test
 * that only asserted "it threw" would pass against a CHECK that had been
 * dropped so long as some other constraint happened to fire.
 */
async function expectCheckRefusal(run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, 'expected a CHECK violation, but the write succeeded').toBeDefined();
  expect(isCheckViolation(thrown), `expected a CHECK violation, got: ${String(thrown)}`).toBe(true);
}

async function expectUniqueRefusal(run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, 'expected a unique violation, but the write succeeded').toBeDefined();
  expect(isUniqueViolation(thrown), `expected a unique violation, got: ${String(thrown)}`).toBe(true);
}

async function expectTriggerRefusal(pattern: RegExp, run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, 'expected a trigger to refuse, but the write succeeded').toBeDefined();
  // The RAISE text lives on the error's CAUSE: drizzle wraps a driver failure
  // in a `Failed query: …` message, so matching only the top-level message
  // would pass against ANY refusal — including a foreign key — which is
  // exactly the check that cannot tell success from failure.
  const cause = (thrown as { cause?: { message?: string } }).cause;
  expect(String(cause?.message ?? thrown)).toMatch(pattern);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

async function mintStore(label: string): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      handle: `pickup-${label}-${RUN}`,
      name: `Pickup store ${label} ${RUN}`,
      description: '',
      brandColor: '#000000',
    })
    .returning({ id: stores.id });
  if (!row) throw new Error('mintStore returned no row');
  createdStoreIds.push(row.id);
  return row.id;
}

async function mintLocation(storeId: string, label: string, isActive = true): Promise<string> {
  const [row] = await db
    .insert(locations)
    .values({ storeId, name: `${label} ${RUN}`, type: 'retail', isActive })
    .returning({ id: locations.id });
  if (!row) throw new Error('mintLocation returned no row');
  createdLocationIds.push(row.id);
  return row.id;
}

interface PublicationOptions {
  readonly position?: { latitude: number; longitude: number } | null;
  readonly state?: 'draft' | 'published' | 'withdrawn';
  readonly pickupOffered?: boolean;
  readonly paused?: boolean;
  readonly restricted?: boolean;
  readonly intervalSeconds?: number;
  readonly city?: string;
  readonly disclosesExactStock?: boolean;
}

async function mintPublication(
  storeId: string,
  locationId: string,
  options: PublicationOptions = {},
): Promise<string> {
  const position = options.position === undefined ? ORIGIN : options.position;
  const [row] = await db
    .insert(locationPublications)
    .values({
      locationId,
      storeId,
      displayName: `Shop ${RUN}`,
      publicCity: options.city ?? `Barcelona-${RUN}`,
      publicCountry: 'ES',
      timezone: 'Europe/Madrid',
      ...(position === null
        ? {}
        : {
            latitude: position.latitude,
            longitude: position.longitude,
            geocodeProvenance: 'merchant_map_pin' as const,
            geocodedAt: new Date(),
          }),
      publicationState: options.state ?? 'published',
      pickupOffered: options.pickupOffered ?? true,
      ...(options.paused === true
        ? { pickupPausedAt: new Date(), pickupPauseReason: 'stocktake' }
        : {}),
      ...(options.restricted === true
        ? {
            restrictedAt: new Date(),
            restrictionReason: 'under review',
            restrictedByOxyUserId: 'operator-1',
          }
        : {}),
      inventorySource: 'pos',
      stockConfirmationIntervalSeconds: options.intervalSeconds ?? 3_600,
      disclosesExactStock: options.disclosesExactStock ?? false,
    })
    .returning({ id: locationPublications.id });
  if (!row) throw new Error('mintPublication returned no row');
  return row.id;
}

/**
 * A minimal REAL order, because `order_pickups`, the credential and the trail
 * all carry a genuine foreign key to `orders`.
 *
 * Written directly rather than through `insertOrder`: this file is about the
 * pickup tables' own constraints, and driving a whole checkout to reach them
 * would be testing the fixture. Every NOT NULL column with no default is
 * supplied, which is the shape the FK actually requires.
 */
async function mintOrder(storeId: string): Promise<string> {
  const [row] = await db
    .insert(orders)
    .values({
      orderNumber: `${Date.now()}${createdOrderIds.length}`,
      sellerType: 'store',
      storeId,
      buyerOrigin: 'oxy',
      buyerOxyUserId: `buyer-${RUN}`,
      shippingAddressRecipientName: 'Collection',
      shippingAddressLine1: 'Shop',
      shippingAddressCity: 'Barcelona',
      shippingAddressPostalCode: '-',
      shippingAddressCountry: 'ES',
      shippingMethod: 'pickup',
      shippingLabel: 'Pickup',
      shippingCostShopAmount: 0,
      shippingCostShopCurrency: 'EUR',
      shippingCostPresentmentAmount: 0,
      shippingCostPresentmentCurrency: 'EUR',
      totalsSubtotalShopAmount: 0,
      totalsSubtotalShopCurrency: 'EUR',
      totalsSubtotalPresentmentAmount: 0,
      totalsSubtotalPresentmentCurrency: 'EUR',
      totalsDiscountTotalShopAmount: 0,
      totalsDiscountTotalShopCurrency: 'EUR',
      totalsDiscountTotalPresentmentAmount: 0,
      totalsDiscountTotalPresentmentCurrency: 'EUR',
      totalsShippingShopAmount: 0,
      totalsShippingShopCurrency: 'EUR',
      totalsShippingPresentmentAmount: 0,
      totalsShippingPresentmentCurrency: 'EUR',
      totalsTaxShopAmount: 0,
      totalsTaxShopCurrency: 'EUR',
      totalsTaxPresentmentAmount: 0,
      totalsTaxPresentmentCurrency: 'EUR',
      totalsGrandTotalShopAmount: 0,
      totalsGrandTotalShopCurrency: 'EUR',
      totalsGrandTotalPresentmentAmount: 0,
      totalsGrandTotalPresentmentCurrency: 'EUR',
    })
    .returning({ id: orders.id });
  if (!row) throw new Error('mintOrder returned no row');
  createdOrderIds.push(row.id);
  return row.id;
}

/** A canonical product plus one variant — what a nearby query is keyed on. */
async function mintCanonicalVariant(label: string): Promise<{ productId: string; variantId: string }> {
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `Pickup product ${label} ${RUN}`,
      normalizedName: `pickup product ${label} ${RUN}`,
      slug: `pickup-product-${label}-${RUN}`,
      status: 'active',
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('mintCanonicalVariant returned no product');
  createdProductIds.push(product.id);

  const [variant] = await db
    .insert(canonicalVariants)
    // A real sha-256 hex digest: `canonical_variants_signature_shape_check`
    // refuses anything else, which is what stops a signature this codebase did
    // not produce weakening the uniqueness beside it.
    .values({
      productId: product.id,
      name: 'Default',
      signature: createHash('sha256').update(`${label}-${RUN}`).digest('hex'),
    })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('mintCanonicalVariant returned no variant');
  createdVariantIds.push(variant.id);
  return { productId: product.id, variantId: variant.id };
}

/** A store listing with one variant, stocked at one location and attached. */
async function mintStockedListing(input: {
  storeId: string;
  locationId: string;
  canonicalVariantId: string;
  available?: number;
  listingStatus?: 'active' | 'restricted';
  confirmedAt?: Date;
}): Promise<{ listingId: string; variantId: string }> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId: input.storeId,
      title: `Pickup listing ${RUN}`,
      description: 'under test',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: input.listingStatus ?? 'active',
    })
    .returning({ id: listings.id });
  if (!listing) throw new Error('mintStockedListing returned no listing');
  createdListingIds.push(listing.id);

  const [variant] = await db
    .insert(productVariants)
    .values({
      listingId: listing.id,
      title: 'Default Title',
      priceAmount: 119_900,
      priceCurrency: 'EUR',
      inventoryTracked: true,
      inventoryAvailable: input.available ?? 5,
    })
    .returning({ id: productVariants.id });
  if (!variant) throw new Error('mintStockedListing returned no variant');

  await db.insert(inventoryLevels).values({
    variantId: variant.id,
    listingId: listing.id,
    locationId: input.locationId,
    available: input.available ?? 5,
  });
  // `updated_at` defaults to now; a STALE fixture needs it moved explicitly.
  if (input.confirmedAt) {
    await db
      .update(inventoryLevels)
      .set({ updatedAt: input.confirmedAt })
      .where(
        and(
          eq(inventoryLevels.variantId, variant.id),
          eq(inventoryLevels.locationId, input.locationId),
        ),
      );
  }

  await db.insert(nativeListingLinks).values({
    productVariantId: variant.id,
    listingId: listing.id,
    canonicalVariantId: input.canonicalVariantId,
    method: 'barcode_gtin',
    matchRule: 'test',
    status: 'active',
  });

  return { listingId: listing.id, variantId: variant.id };
}

// ── The generated geography column ──────────────────────────────────────────

describe('the generated PostGIS point', () => {
  it('really is a Point at SRID 4326, and is NULL without a pair', async () => {
    const storeId = await mintStore('geo');
    const pinned = await mintLocation(storeId, 'pinned');
    const unpinned = await mintLocation(storeId, 'unpinned');
    await mintPublication(storeId, pinned);
    await mintPublication(storeId, unpinned, { position: null, state: 'draft' });

    // Asserted against real ROWS rather than against the declaration: the
    // typmod cannot be emitted by drizzle-kit, so the only way to know the
    // stored value is a 4326 point is to ask the server what it stored.
    const rows = await db.execute(sql`
      select st_geometrytype(geo_point::geometry) as kind,
             st_srid(geo_point::geometry) as srid,
             geo_point is null as absent
      from location_publications
      where location_id = any(${sql.param([pinned, unpinned])}::text[])
      order by absent
    `);
    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe('ST_Point');
    expect(Number(rows[0].srid)).toBe(4326);
    expect(rows[1].absent).toBe(true);
  });

  it('is covered by a GiST index, which no functional test could miss the absence of', async () => {
    // AN INDEX IS THE ONE THING A FUNCTIONAL TEST CAN NEVER DETECT THE ABSENCE
    // OF. Every `ST_DWithin` case above passes identically against a sequential
    // scan — it returns the same rows, just slower, and "slower" is invisible
    // at fixture scale and catastrophic at catalogue scale. So the index is
    // asserted to EXIST, and asserted to be GiST specifically: a btree over a
    // `geography` column would be created without complaint and could not serve
    // the operator at all.
    //
    // The read is scoped to this ONE index name and the row count is asserted
    // first, so "I found no such index" cannot be what a passing test looks
    // like — the vacuity floor this whole file's exclusion cases also carry.
    const rows = await db.execute(sql`
      select indexdef
      from pg_indexes
      where tablename = 'location_publications'
        and indexname = 'location_publications_geo_point_idx'
    `);
    expect(
      rows,
      'the GiST index over location_publications.geo_point is missing; every nearby query ' +
        'silently degrades to a sequential scan and no other test in this file can tell',
    ).toHaveLength(1);
    expect(String(rows[0].indexdef)).toContain('USING gist');
    expect(String(rows[0].indexdef)).toContain('geo_point');
  });
});

// ── The CHECKs ──────────────────────────────────────────────────────────────

describe('the publication CHECKs', () => {
  let storeId: string;
  beforeAll(async () => {
    storeId = await mintStore('checks');
  });

  const publication = (
    locationId: string,
    extra: Record<string, unknown> = {},
  ): typeof locationPublications.$inferInsert => ({
    locationId,
    storeId,
    displayName: 'x',
    publicCountry: 'ES',
    timezone: 'Europe/Madrid',
    inventorySource: 'pos',
    stockConfirmationIntervalSeconds: 3_600,
    ...extra,
  });

  it('REFUSES the null island, which a plain range check admits', async () => {
    const locationId = await mintLocation(storeId, 'null-island');
    await expectCheckRefusal(() =>
      db.insert(locationPublications).values(
        publication(locationId, {
          latitude: 0,
          longitude: 0,
          geocodeProvenance: 'merchant_map_pin',
          geocodedAt: new Date(),
        }),
      ),
    );
  });

  it('ACCEPTS a real position on the prime meridian, so the refusal is the PAIR', async () => {
    // Greenwich is a real place. A CHECK that refused either half alone would
    // be refusing a merchant, and only this fixture tells the two apart.
    const locationId = await mintLocation(storeId, 'greenwich');
    await db.insert(locationPublications).values(
      publication(locationId, {
        latitude: 51.4779,
        longitude: 0,
        geocodeProvenance: 'merchant_map_pin',
        geocodedAt: new Date(),
      }),
    );
    const [row] = await db
      .select({ latitude: locationPublications.latitude })
      .from(locationPublications)
      .where(eq(locationPublications.locationId, locationId));
    expect(row?.latitude).toBeCloseTo(51.4779, 4);
  });

  it('refuses a latitude with no longitude', async () => {
    const locationId = await mintLocation(storeId, 'half-pair');
    await expectCheckRefusal(() =>
      db.insert(locationPublications).values(publication(locationId, { latitude: 41 })),
    );
  });

  it('refuses a stock interval outside the declared bounds', async () => {
    const locationId = await mintLocation(storeId, 'interval');
    await expectCheckRefusal(() =>
      db
        .insert(locationPublications)
        .values(publication(locationId, { stockConfirmationIntervalSeconds: 5 })),
    );
  });

  it('refuses a pause with no reason', async () => {
    const locationId = await mintLocation(storeId, 'pause');
    await expectCheckRefusal(() =>
      db.insert(locationPublications).values(publication(locationId, { pickupPausedAt: new Date() })),
    );
  });
});

describe('the collection-state CHECKs', () => {
  let storeId: string;
  let locationId: string;
  let publicationId: string;

  beforeAll(async () => {
    storeId = await mintStore('states');
    locationId = await mintLocation(storeId, 'states');
    publicationId = await mintPublication(storeId, locationId);
  });

  const snapshot = (
    orderId: string,
    extra: Record<string, unknown>,
  ): typeof orderPickups.$inferInsert => ({
    orderId,
    locationId,
    publicationId,
    displayName: 'x',
    publicCountry: 'ES',
    timezone: 'Europe/Madrid',
    identityRequirement: 'collection_code',
    paymentRequirement: 'prepaid',
    ...extra,
  });

  it('refuses `collected` with no instant, and an instant with another state', async () => {
    // Both directions, because the biconditional is what makes "when was this
    // handed over" answerable — the first question a dispute asks.
    await expectCheckRefusal(async () =>
      db.insert(orderPickups).values(snapshot(await mintOrder(storeId), { state: 'collected' })),
    );
    await expectCheckRefusal(async () =>
      db
        .insert(orderPickups)
        .values(
          snapshot(await mintOrder(storeId), {
            state: 'ready_for_pickup',
            collectedAt: new Date(),
          }),
        ),
    );
  });

  it('refuses `ready_for_pickup` with no instant', async () => {
    await expectCheckRefusal(async () =>
      db
        .insert(orderPickups)
        .values(snapshot(await mintOrder(storeId), { state: 'ready_for_pickup' })),
    );
  });

  it('refuses a cancellation with no reason', async () => {
    await expectCheckRefusal(async () =>
      db
        .insert(orderPickups)
        .values(
          snapshot(await mintOrder(storeId), {
            state: 'pickup_cancelled',
            cancelledAt: new Date(),
          }),
        ),
    );
  });
});

// ── The triggers ────────────────────────────────────────────────────────────

describe('the append-only trails and the frozen snapshot', () => {
  let storeId: string;
  let locationId: string;
  let publicationId: string;
  let orderId: string;

  beforeAll(async () => {
    storeId = await mintStore('triggers');
    locationId = await mintLocation(storeId, 'triggers');
    publicationId = await mintPublication(storeId, locationId);
    orderId = await mintOrder(storeId);
  });

  it('refuses UPDATE and DELETE against a publication event', async () => {
    const [event] = await db
      .insert(locationPublicationEvents)
      .values({ publicationId, kind: 'published', occurredAt: new Date() })
      .returning({ id: locationPublicationEvents.id });
    if (!event) throw new Error('no event');

    await expectTriggerRefusal(/append-only/, () =>
      db
        .update(locationPublicationEvents)
        .set({ kind: 'withdrawn' })
        .where(eq(locationPublicationEvents.id, event.id)),
    );
    await expectTriggerRefusal(/append-only/, () =>
      db.delete(locationPublicationEvents).where(eq(locationPublicationEvents.id, event.id)),
    );
    // Cleaned up by the publication's own cascade at teardown — the trigger
    // refuses a DELETE against the row, not against its parent.
  });

  it('refuses UPDATE and DELETE against a collection event', async () => {
    const [event] = await appendCollectionEvent({
      orderId,
      storeId,
      kind: 'code_rejected',
      occurredAt: new Date(),
    }).then((row) => [row]);

    await expectTriggerRefusal(/append-only/, () =>
      db
        .update(pickupCollectionEvents)
        .set({ kind: 'code_validated' })
        .where(eq(pickupCollectionEvents.id, event.id)),
    );
    await expectTriggerRefusal(/append-only/, () =>
      db.delete(pickupCollectionEvents).where(eq(pickupCollectionEvents.id, event.id)),
    );
  });

  it('freezes the order snapshot and lets the STATE move', async () => {
    const snapshotOrderId = await mintOrder(storeId);
    await insertOrderPickup({
      orderId: snapshotOrderId,
      locationId,
      publicationId,
      displayName: 'Original name',
      publicLine1: null,
      publicLine2: null,
      publicCity: 'Barcelona',
      publicRegion: null,
      publicPostalCode: null,
      publicCountry: 'ES',
      timezone: 'Europe/Madrid',
      pickupInstructions: null,
      identityRequirement: 'collection_code',
      paymentRequirement: 'prepaid',
    });

    await expectTriggerRefusal(/immutable/, () =>
      db
        .update(orderPickups)
        .set({ displayName: 'Renamed' })
        .where(eq(orderPickups.orderId, snapshotOrderId)),
    );
    await expectTriggerRefusal(/immutable/, () =>
      db
        .update(orderPickups)
        .set({ publicCity: 'Madrid' })
        .where(eq(orderPickups.orderId, snapshotOrderId)),
    );

    // …and the positive control: the operational half moves freely, or the
    // trigger would be freezing the whole row and this test would pass by
    // making the feature unusable.
    const moved = await markReadyForPickup({ orderId: snapshotOrderId, at: new Date() });
    expect(moved?.state).toBe('ready_for_pickup');
  });
});

// ── The proximity read ──────────────────────────────────────────────────────

describe('the nearby read', () => {
  let storeId: string;
  let canonical: { productId: string; variantId: string };
  let nearLocationId: string;

  beforeAll(async () => {
    storeId = await mintStore('nearby');
    canonical = await mintCanonicalVariant('nearby');

    nearLocationId = await mintLocation(storeId, 'near');
    await mintPublication(storeId, nearLocationId, { position: NEARBY });
    await mintStockedListing({
      storeId,
      locationId: nearLocationId,
      canonicalVariantId: canonical.variantId,
      available: 4,
    });

    const farLocationId = await mintLocation(storeId, 'far');
    await mintPublication(storeId, farLocationId, { position: FAR });
    await mintStockedListing({
      storeId,
      locationId: farLocationId,
      canonicalVariantId: canonical.variantId,
    });
  });

  it('ACCEPTANCE 1: finds the nearby location for the right canonical variant', async () => {
    const rows = await findNearbyCollectableLocations({
      canonicalVariantId: canonical.variantId,
      ...ORIGIN,
      radiusMetres: 25_000,
      limit: 20,
    });
    expect(rows.map((row) => row.locationId)).toEqual([nearLocationId]);
    // About 2 km, and asserted as a RANGE: the point of the assertion is that
    // PostGIS measured a real distance, not that it produced one exact number.
    expect(rows[0].distanceMetres).toBeGreaterThan(1_500);
    expect(rows[0].distanceMetres).toBeLessThan(2_500);
    expect(rows[0].available).toBe(4);
  });

  it('answers the same for the canonical PRODUCT handle', async () => {
    const rows = await findNearbyCollectableLocations({
      canonicalProductId: canonical.productId,
      ...ORIGIN,
      radiusMetres: 25_000,
      limit: 20,
    });
    expect(rows.map((row) => row.locationId)).toEqual([nearLocationId]);
  });

  it('excludes the FAR location, so the radius is a real predicate', async () => {
    // The positive control for the radius: widening it brings Madrid back, so
    // a query that returned only the near one because the join was broken
    // could not pass both halves.
    const wide = await findNearbyCollectableLocations({
      canonicalVariantId: canonical.variantId,
      ...ORIGIN,
      radiusMetres: 100_000,
      limit: 20,
    });
    expect(wide).toHaveLength(1);
    const widest = await db.execute(sql`
      select count(*)::int as total from location_publications
      where store_id = ${storeId} and geo_point is not null
    `);
    expect(Number(widest[0].total)).toBe(2);
  });

  const excluded: readonly [string, PublicationOptions, { listingStatus?: 'restricted'; available?: number; confirmedAt?: Date }][] = [
    ['a DRAFT publication', { state: 'draft' }, {}],
    ['a WITHDRAWN publication', { state: 'withdrawn' }, {}],
    ['a location that does not offer collection', { pickupOffered: false }, {}],
    ['a PAUSED location', { paused: true }, {}],
    ['a RESTRICTED location', { restricted: true }, {}],
    ['an UNGEOCODED location', { position: null }, {}],
    ['a location with zero stock', {}, { available: 0 }],
    ['a RESTRICTED listing', {}, { listingStatus: 'restricted' }],
    [
      'a location whose stock is STALER than its own interval',
      { intervalSeconds: 60 },
      { confirmedAt: new Date(Date.now() - 3_600_000) },
    ],
  ];

  for (const [label, publicationOptions, listingOptions] of excluded) {
    it(`ACCEPTANCE 2: excludes ${label}`, async () => {
      const isolatedStore = await mintStore(`excl-${label.replace(/\W+/g, '')}`);
      const isolatedCanonical = await mintCanonicalVariant(`excl-${label.replace(/\W+/g, '')}`);
      const locationId = await mintLocation(isolatedStore, 'excluded');
      await mintPublication(isolatedStore, locationId, publicationOptions);
      await mintStockedListing({
        storeId: isolatedStore,
        locationId,
        canonicalVariantId: isolatedCanonical.variantId,
        ...listingOptions,
      });

      const rows = await findNearbyCollectableLocations({
        canonicalVariantId: isolatedCanonical.variantId,
        ...ORIGIN,
        radiusMetres: 25_000,
        limit: 20,
      });
      expect(rows).toEqual([]);
    });
  }

  it('the SAME fixture with the exclusion removed IS returned', async () => {
    // The positive control for the whole block above: without it, a broken
    // join would make all nine exclusions pass by returning nothing ever.
    const isolatedStore = await mintStore('excl-control');
    const isolatedCanonical = await mintCanonicalVariant('excl-control');
    const locationId = await mintLocation(isolatedStore, 'control');
    await mintPublication(isolatedStore, locationId);
    await mintStockedListing({
      storeId: isolatedStore,
      locationId,
      canonicalVariantId: isolatedCanonical.variantId,
    });
    const rows = await findNearbyCollectableLocations({
      canonicalVariantId: isolatedCanonical.variantId,
      ...ORIGIN,
      radiusMetres: 25_000,
      limit: 20,
    });
    expect(rows.map((row) => row.locationId)).toEqual([locationId]);
  });

  it('orders nearest first and pages on a stable keyset', async () => {
    const pagingStore = await mintStore('paging');
    const pagingCanonical = await mintCanonicalVariant('paging');
    const ids: string[] = [];
    // Three shops at increasing distances along one meridian.
    for (const [index, offset] of [0.01, 0.03, 0.06].entries()) {
      const locationId = await mintLocation(pagingStore, `page-${index}`);
      await mintPublication(pagingStore, locationId, {
        position: { latitude: ORIGIN.latitude + offset, longitude: ORIGIN.longitude },
      });
      await mintStockedListing({
        storeId: pagingStore,
        locationId,
        canonicalVariantId: pagingCanonical.variantId,
      });
      ids.push(locationId);
    }

    const first = await findNearbyCollectableLocations({
      canonicalVariantId: pagingCanonical.variantId,
      ...ORIGIN,
      radiusMetres: 50_000,
      limit: 2,
    });
    expect(first.map((row) => row.locationId)).toEqual([ids[0], ids[1]]);

    const second = await findNearbyCollectableLocations({
      canonicalVariantId: pagingCanonical.variantId,
      ...ORIGIN,
      radiusMetres: 50_000,
      limit: 2,
      cursor: { distanceMetres: first[1].distanceMetres, publicationId: first[1].publicationId },
    });
    // The page resumes and does not repeat: the cursor is a real predicate.
    expect(second.map((row) => row.locationId)).toEqual([ids[2]]);
  });

  it('suggests only places that actually hold the item', async () => {
    const places = await findNearbyPlaceSuggestions({
      canonicalVariantId: canonical.variantId,
      precisionDegrees: 0.1,
      limit: 10,
    });
    expect(places.map((place) => place.city)).toContain(`Barcelona-${RUN}`);
    for (const place of places) expect(place.locationCount).toBeGreaterThan(0);

    // …and a term that matches nothing returns nothing, rather than everything.
    const none = await findNearbyPlaceSuggestions({
      canonicalVariantId: canonical.variantId,
      term: 'zzz-no-such-city',
      precisionDegrees: 0.1,
      limit: 10,
    });
    expect(none).toEqual([]);
  });

  it('answers #74 with the nearest distance per VARIANT, and #70 with a product set', async () => {
    const rows = await findNearbyCollectableLocations({
      canonicalVariantId: canonical.variantId,
      ...ORIGIN,
      radiusMetres: 25_000,
      limit: 5,
    });
    const distances = await findNearestPickupDistanceByVariant({
      variantIds: [rows[0].variantId],
      ...ORIGIN,
      radiusMetres: 25_000,
    });
    expect(distances.get(rows[0].variantId)).toBe(rows[0].distanceMetres);

    const products = await findCanonicalProductsWithNearbyCollection({
      canonicalProductIds: [canonical.productId],
      ...ORIGIN,
      radiusMetres: 25_000,
    });
    expect(products.has(canonical.productId)).toBe(true);
    // …and the discriminating half: a tiny radius excludes it, so the set is
    // not simply "every product asked about".
    const tight = await findCanonicalProductsWithNearbyCollection({
      canonicalProductIds: [canonical.productId],
      ...ORIGIN,
      radiusMetres: 500,
    });
    expect(tight.has(canonical.productId)).toBe(false);
  });

  it('the checkout candidate read applies NO eligibility predicate', async () => {
    // A PAUSED location must resolve, so the gate can answer "collection is not
    // available" rather than "location not found" — which is a different and
    // wrong thing to tell a buyer.
    const pausedStore = await mintStore('paused-candidate');
    const pausedCanonical = await mintCanonicalVariant('paused-candidate');
    const locationId = await mintLocation(pausedStore, 'paused');
    await mintPublication(pausedStore, locationId, { paused: true });
    const { variantId } = await mintStockedListing({
      storeId: pausedStore,
      locationId,
      canonicalVariantId: pausedCanonical.variantId,
    });

    const candidate = await findPickupCandidate({ locationId, variantId });
    expect(candidate).not.toBeNull();
    expect(candidate?.pickupPaused).toBe(true);
    expect(candidate?.available).toBe(5);
  });
});

// ── Reserving at the exact location ─────────────────────────────────────────

describe('ACCEPTANCE 3: stock moves at the EXACT location', () => {
  it('decrements the chosen branch and leaves the other alone', async () => {
    const storeId = await mintStore('reserve');
    const canonical = await mintCanonicalVariant('reserve');
    const branchA = await mintLocation(storeId, 'branch-a');
    const branchB = await mintLocation(storeId, 'branch-b');
    await mintPublication(storeId, branchA, { position: NEARBY });
    await mintPublication(storeId, branchB, { position: ORIGIN });

    const { listingId, variantId } = await mintStockedListing({
      storeId,
      locationId: branchA,
      canonicalVariantId: canonical.variantId,
      available: 3,
    });
    // The same variant, stocked at a second branch.
    await db
      .insert(inventoryLevels)
      .values({ variantId, listingId, locationId: branchB, available: 7 });

    // The SAME guarded UPDATE `reserve(variantId, qty, locationId)` calls.
    expect(await reserveAtLocation(variantId, branchA, 2)).toBe(true);

    const levels = await db
      .select({
        locationId: inventoryLevels.locationId,
        available: inventoryLevels.available,
        committed: inventoryLevels.committed,
      })
      .from(inventoryLevels)
      .where(eq(inventoryLevels.variantId, variantId));
    const byLocation = new Map(levels.map((level) => [level.locationId, level]));
    expect(byLocation.get(branchA)).toMatchObject({ available: 1, committed: 2 });
    expect(byLocation.get(branchB)).toMatchObject({ available: 7, committed: 0 });
  });

  it('refuses to over-reserve a branch even though the STORE has enough', async () => {
    // The race-safety property, at the grain that matters for a collection: a
    // buyer standing at branch A must not be sold a unit that is at branch B.
    const storeId = await mintStore('reserve-guard');
    const canonical = await mintCanonicalVariant('reserve-guard');
    const branchA = await mintLocation(storeId, 'guard-a');
    const branchB = await mintLocation(storeId, 'guard-b');
    await mintPublication(storeId, branchA);
    await mintPublication(storeId, branchB);
    const { listingId, variantId } = await mintStockedListing({
      storeId,
      locationId: branchA,
      canonicalVariantId: canonical.variantId,
      available: 1,
    });
    await db
      .insert(inventoryLevels)
      .values({ variantId, listingId, locationId: branchB, available: 50 });

    expect(await reserveAtLocation(variantId, branchA, 2)).toBe(false);
  });
});

// ── Collection idempotency ──────────────────────────────────────────────────

describe('ACCEPTANCE 14: collection is idempotent', () => {
  let storeId: string;
  let locationId: string;
  let publicationId: string;

  beforeAll(async () => {
    storeId = await mintStore('collect');
    locationId = await mintLocation(storeId, 'collect');
    publicationId = await mintPublication(storeId, locationId);
  });

  async function mintCollection(): Promise<string> {
    const orderId = await mintOrder(storeId);
    await insertOrderPickup({
      orderId,
      locationId,
      publicationId,
      displayName: 'x',
      publicLine1: null,
      publicLine2: null,
      publicCity: null,
      publicRegion: null,
      publicPostalCode: null,
      publicCountry: 'ES',
      timezone: 'Europe/Madrid',
      pickupInstructions: null,
      identityRequirement: 'collection_code',
      paymentRequirement: 'prepaid',
    });
    return orderId;
  }

  it('marks collected exactly once; the second attempt moves nothing', async () => {
    const orderId = await mintCollection();
    const at = new Date();

    const first = await markCollected({ orderId, at });
    expect(first?.state).toBe('collected');
    // `null` is the CAS losing, which the service turns into a converging
    // success rather than an error — the second till is not doing anything
    // wrong. What matters here is that NOTHING moved.
    const second = await markCollected({ orderId, at: new Date(at.getTime() + 60_000) });
    expect(second).toBeNull();

    const [row] = await db.select().from(orderPickups).where(eq(orderPickups.orderId, orderId));
    expect(row?.collectedAt?.getTime()).toBe(first?.collectedAt?.getTime());
  });

  it('two CONCURRENT collections converge on one transition', async () => {
    // Sequential calls pass under a read-then-write that a real race defeats,
    // so both are issued at once.
    const orderId = await mintCollection();
    const at = new Date();
    const [a, b] = await Promise.all([
      markCollected({ orderId, at }),
      markCollected({ orderId, at }),
    ]);
    expect([a, b].filter((row) => row !== null)).toHaveLength(1);
  });

  it('cannot collect a CANCELLED collection, or cancel a collected one', async () => {
    const cancelled = await mintCollection();
    await markPickupCancelled({ orderId: cancelled, reason: 'buyer changed mind', at: new Date() });
    expect(await markCollected({ orderId: cancelled, at: new Date() })).toBeNull();

    const collected = await mintCollection();
    await markCollected({ orderId: collected, at: new Date() });
    expect(
      await markPickupCancelled({ orderId: collected, reason: 'too late', at: new Date() }),
    ).toBeNull();
  });

  it('stamps a ready instant even when a shop hands over without pressing ready', async () => {
    // The `coalesce` in `markCollected`: `order_pickups_ready_instant_check`
    // deliberately does not cover the collected state, so without it the
    // fastest-moving orders would be the only ones with no ready time at all.
    const orderId = await mintCollection();
    const row = await markCollected({ orderId, at: new Date() });
    expect(row?.readyAt).not.toBeNull();
  });
});

describe('the collection credential', () => {
  it('is created once and rotates by incrementing IN SQL', async () => {
    const orderId = await mintOrder(await mintStore('credential'));
    const at = new Date();

    const first = await ensureCollectionCredential({ orderId, at });
    const second = await ensureCollectionCredential({ orderId, at: new Date() });
    expect(second.version).toBe(1);
    expect(second.issuedAt.getTime()).toBe(first.issuedAt.getTime());

    // Two concurrent rotations produce TWO rotations, which is correct for a
    // credential nobody should be holding: the second press is somebody who is
    // not sure the first worked.
    await Promise.all([
      rotateCollectionCredential({ orderId, at: new Date() }),
      rotateCollectionCredential({ orderId, at: new Date() }),
    ]);
    const [row] = await db
      .select({ version: pickupCollectionCredentials.version })
      .from(pickupCollectionCredentials)
      .where(eq(pickupCollectionCredentials.orderId, orderId));
    expect(row?.version).toBe(3);
  });

  it('stores no code, no hash and no ciphertext', async () => {
    // The claim the whole design rests on, asserted against the real table
    // rather than against the file: a dump of this table opens nothing.
    const columns = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'pickup_collection_credentials'
    `);
    const names = columns.map((row) => String(row.column_name));
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const forbidden of ['code', 'code_hash', 'token', 'token_hash', 'secret', 'ciphertext']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

// ── P2P proximity ───────────────────────────────────────────────────────────

describe('ACCEPTANCE 4: P2P proximity exposes no precise position', () => {
  it('has no coordinate column, and refuses an out-of-range cell index', async () => {
    const columns = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'listing_local_discovery'
    `);
    const names = columns.map((row) => String(row.column_name));
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const forbidden of ['latitude', 'longitude', 'geo_point', 'address', 'postal_code']) {
      expect(names).not.toContain(forbidden);
    }

    const storeId = await mintStore('p2p');
    const [listing] = await db
      .insert(listings)
      .values({
        ownerType: 'user',
        oxyUserId: `seller-${RUN}`,
        title: `P2P listing ${RUN}`,
        description: 'under test',
        condition: 'used_good',
        conditionAssertion: 'seller_declared',
        status: 'active',
      })
      .returning({ id: listings.id });
    if (!listing) throw new Error('no listing');
    createdListingIds.push(listing.id);
    expect(storeId).toBeTruthy();

    // A latitude pasted into an index column — the shape the CHECK exists for.
    await expectCheckRefusal(() =>
      db.insert(listingLocalDiscovery).values({
        listingId: listing.id,
        enabled: true,
        cellLatIndex: 41,
        cellLonIndex: 40_000,
        cellPrecisionDegrees: 0.1,
        areaLabel: 'Gràcia',
        country: 'ES',
      }),
    );

    // …and the positive control: a real cell index is accepted, so the CHECK
    // is not simply refusing everything.
    await db.insert(listingLocalDiscovery).values({
      listingId: listing.id,
      enabled: true,
      cellLatIndex: 413,
      cellLonIndex: 21,
      cellPrecisionDegrees: 0.1,
      areaLabel: 'Gràcia',
      country: 'ES',
    });
  });
});

// ── Hours and closures ──────────────────────────────────────────────────────

describe('the schedule children', () => {
  it('converges a repeated save and refuses a backwards interval', async () => {
    const storeId = await mintStore('hours');
    const locationId = await mintLocation(storeId, 'hours');
    const publicationId = await mintPublication(storeId, locationId);

    await db
      .insert(locationOpeningHours)
      .values({ publicationId, weekday: 1, opensMinute: 540, closesMinute: 1_020 });
    // The unique is what makes a repeated save converge rather than accumulate.
    await expectUniqueRefusal(() =>
      db
        .insert(locationOpeningHours)
        .values({ publicationId, weekday: 1, opensMinute: 540, closesMinute: 1_200 }),
    );

    await expectCheckRefusal(() =>
      db
        .insert(locationOpeningHours)
        .values({ publicationId, weekday: 2, opensMinute: 1_020, closesMinute: 540 }),
    );

    await expectCheckRefusal(() =>
      db
        .insert(locationClosures)
        // Both dates in the PAST, and deliberately inverted: what is under test
        // is that `from > through` is refused, so the instants themselves are
        // inert and there is no reason to pin one the real clock is moving
        // toward.
        .values({ publicationId, fromDate: '2026-08-10', throughDate: '2026-08-01' }),
    );
  });
});
