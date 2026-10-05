/**
 * The location world the public location reads (#1017, ADR 0013) are proven
 * against, shared by `public-api-locations.realdb.test.ts` (the wire) and
 * `public-api-sdk-contract.realdb.test.ts` (the SDK against it).
 *
 * One live store with ten locations — one per status rule — and a suspended
 * store with one; a fake GoWay (`services/goway/__tests__/fake-goway.ts`, the
 * real SDK behind a `fetch` seam) holding the place each location names, each
 * vouching for its location at the business tier unless the case is about it
 * not doing so. Stock sits at two locations: `linked` (exact counts private)
 * and `noPickup` (exact counts disclosed), with fresh, low, empty, stale and
 * half-stale levels.
 *
 * Every private fact a location row carries — its operational name and
 * delivery address, a pause reason, a restriction reason — and every fact of
 * its GoWay PLACE (the place's own name and street) is seeded as a run-unique
 * SENTINEL: none may reach a public body, the place facts because they are
 * GoWay's to serve.
 */

import { expect } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { Database } from '../../db/postgres.js';
import { inventoryLevels, listings, productVariants } from '../../db/schema/catalog.js';
import { locationPublications } from '../../db/schema/pickup.js';
import { locations, stores } from '../../db/schema/stores.js';
import { withTriggerToggleLock } from '../../db/__tests__/trigger-toggle-lock.js';
import type { FakeGoWay, FakePlace } from '../../services/goway/__tests__/fake-goway.js';
import { exactKeys, KEYS } from './public-api-fixtures.js';

/* -------------------------------------------------------------------------- */
/* The contract's key sets                                                    */
/* -------------------------------------------------------------------------- */

export const LOCATION_KEYS = {
  locationRef: ['id', 'kind'],
  location: ['discoverable', 'goWayPlaceId', 'pickup', 'ref', 'store', 'url'],
  locationStore: ['handle', 'logoUrl', 'name', 'ref'],
  pickup: ['identityRequirement', 'instructions', 'paymentRequirement'],
  locationProduct: ['availability', 'product', 'stockConfirmedAt'],
} as const;

/** A location body's key set EQUALS the contract's, recursively. */
export function checkLocation(value: unknown, where: string): Record<string, unknown> {
  const location = exactKeys(value, LOCATION_KEYS.location, where);
  exactKeys(location['ref'], LOCATION_KEYS.locationRef, `${where}.ref`);
  const store = exactKeys(location['store'], LOCATION_KEYS.locationStore, `${where}.store`);
  exactKeys(store['ref'], KEYS.storeRef, `${where}.store.ref`);
  if (location['pickup'] !== null) exactKeys(location['pickup'], LOCATION_KEYS.pickup, `${where}.pickup`);
  expect(location['discoverable']).toBeTypeOf('boolean');
  return location;
}

/** A location product's key set: `exactQuantity` exactly when the location discloses a fresh count. */
export function checkLocationProduct(value: unknown, where: string): Record<string, unknown> {
  const keys = typeof value === 'object' && value !== null && 'exactQuantity' in value
    ? [...LOCATION_KEYS.locationProduct, 'exactQuantity']
    : LOCATION_KEYS.locationProduct;
  const item = exactKeys(value, keys, where);
  exactKeys(item['product'], KEYS.summary, `${where}.product`);
  expect(['in_stock', 'low_stock', 'out_of_stock']).toContain(item['availability']);
  expect(Number.isNaN(Date.parse(String(item['stockConfirmedAt'])))).toBe(false);
  return item;
}

/* -------------------------------------------------------------------------- */
/* The world                                                                  */
/* -------------------------------------------------------------------------- */

export interface LocationWorldIds {
  store: string;
  suspendedStore: string;
  /** Published, collection offered, vouched for: discoverable. */
  linked: string;
  /** Published and vouched for, collection paused: served, not discoverable. */
  paused: string;
  /** Published and vouched for, no collection offered, exact stock disclosed. */
  noPickup: string;
  draftNever: string;
  withdrawn: string;
  draftAfter: string;
  restricted: string;
  inactive: string;
  /** Published; its place names it only at the community tier. */
  unvouched: string;
  /** Published, naming no place at all. */
  noPlace: string;
  /** Published and vouched for, in the suspended store. */
  inSuspendedStore: string;
  /** Listings stocked at `linked`. */
  inStock: string;
  low: string;
  empty: string;
  stale: string;
  halfStale: string;
  /** Live, stocked only at `paused`. */
  elsewhere: string;
  /** Archived, stocked at `linked`. */
  archived: string;
  /** Live, stocked nowhere. */
  unstocked: string;
}

/** A fresh, run-namespaced location world. Names are known synchronously; rows exist after `seed`. */
export function createLocationWorld() {
  const RUN = uuidv7().slice(-12).replace(/\W/gu, '').toLowerCase();
  /** One search token only `inStock` carries. */
  const TERM = `publoc${RUN}`;
  const storeHandle = `publoc-${RUN}`;
  const SENTINEL = {
    locationName: `LOCNAME-SENTINEL-${RUN}`,
    deliveryLine: `DELIVERY-SENTINEL-${RUN}`,
    pauseReason: `PAUSE-SENTINEL-${RUN}`,
    restrictionReason: `RESTRICT-SENTINEL-${RUN}`,
    placeName: `PLACENAME-SENTINEL-${RUN}`,
    placeStreet: `PLACESTREET-SENTINEL-${RUN}`,
  } as const;
  /** The place each location names, by the location's label. */
  const placeOf = (label: string): string => `plc-${label}-${RUN}`;

  const ids = {} as LocationWorldIds;
  const storeIds: string[] = [];
  const locationIds: string[] = [];
  const listingIds: string[] = [];

  const PUBLISHED_AT = new Date(Date.now() - 86_400_000);
  /** Fresh: well inside the hour-long interval every fixture location declares. */
  const FRESH = new Date(Date.now() - 60_000);
  /** Stale: two hours old against that hour. */
  const STALE = new Date(Date.now() - 2 * 3_600_000);

  async function insertStore(db: Database, label: string, status: 'active' | 'suspended'): Promise<string> {
    const [row] = await db
      .insert(stores)
      .values({
        oxyAccountId: `oxy-account-publoc-${label}-${RUN}`,
        handle: label === 'main' ? storeHandle : `publoc-${label}-${RUN}`,
        name: `Location store ${label} ${RUN}`,
        description: '',
        brandColor: '#204060',
        status,
        ...(label === 'main' ? { logoFileId: `loc-logo-${RUN}` } : {}),
      })
      .returning({ id: stores.id });
    if (!row) throw new Error('no store row');
    storeIds.push(row.id);
    return row.id;
  }

  interface LocationInput {
    readonly storeId: string;
    readonly label: string;
    readonly state: 'draft' | 'published' | 'withdrawn';
    readonly publishedAt: Date | null;
    readonly placed?: boolean;
    readonly active?: boolean;
    readonly pickupOffered?: boolean;
    readonly paused?: boolean;
    readonly restricted?: boolean;
    readonly disclosesExactStock?: boolean;
  }

  async function insertLocation(db: Database, input: LocationInput): Promise<string> {
    const [row] = await db
      .insert(locations)
      .values({
        storeId: input.storeId,
        name: `${SENTINEL.locationName} ${input.label}`,
        type: 'retail',
        addressLine1: SENTINEL.deliveryLine,
        addressCountry: 'ES',
        isActive: input.active ?? true,
        goWayPlaceId: input.placed === false ? null : placeOf(input.label),
      })
      .returning({ id: locations.id });
    if (!row) throw new Error('no location row');
    locationIds.push(row.id);
    await db.insert(locationPublications).values({
      locationId: row.id,
      storeId: input.storeId,
      publicationState: input.state,
      publishedAt: input.publishedAt,
      pickupOffered: input.pickupOffered ?? true,
      pickupInstructions: input.pickupOffered === false ? null : 'Ring at the side door',
      ...(input.paused ? { pickupPausedAt: new Date(), pickupPauseReason: SENTINEL.pauseReason } : {}),
      ...(input.restricted
        ? {
            restrictedAt: new Date(),
            restrictionReason: SENTINEL.restrictionReason,
            restrictedByOxyUserId: `oxy-operator-${RUN}`,
          }
        : {}),
      inventorySource: 'pos',
      stockConfirmationIntervalSeconds: 3_600,
      disclosesExactStock: input.disclosesExactStock ?? false,
      lowStockThreshold: 3,
    });
    return row.id;
  }

  /** A live store listing whose variants hold `levels` — `[location, available, confirmedAt]` per variant. */
  async function insertStock(
    db: Database,
    input: {
      label: string;
      price: number;
      status?: 'active' | 'archived';
      searchable?: boolean;
      variants: readonly (readonly [string, number, Date] | null)[];
    },
  ): Promise<string> {
    const [listing] = await db
      .insert(listings)
      .values({
        ownerType: 'store',
        storeId: ids.store,
        title: `${input.label} ${input.searchable ? TERM : 'shelf'} ${RUN}`,
        description: 'At a location',
        condition: 'new',
        conditionAssertion: 'seller_declared',
        status: input.status ?? 'active',
        publishedAt: PUBLISHED_AT,
      })
      .returning({ id: listings.id });
    if (!listing) throw new Error('no listing row');
    listingIds.push(listing.id);
    for (const [index, level] of input.variants.entries()) {
      const [variant] = await db
        .insert(productVariants)
        .values({
          listingId: listing.id,
          title: `Option ${index}`,
          position: index,
          priceAmount: input.price,
          priceCurrency: 'EUR',
          inventoryTracked: true,
          inventoryAvailable: level?.[1] ?? 0,
        })
        .returning({ id: productVariants.id });
      if (!variant) throw new Error('no variant row');
      if (level !== null) {
        const [locationId, available, confirmedAt] = level;
        await db.insert(inventoryLevels).values({
          variantId: variant.id,
          listingId: listing.id,
          locationId,
          available,
          updatedAt: confirmedAt,
        });
      }
    }
    const { recomputeListingFacets } = await import('../../db/catalog/listingRepository.js');
    await recomputeListingFacets(listing.id);
    return listing.id;
  }

  /** The place a location names, vouching for it at the business tier unless told otherwise. */
  function place(label: string, locationId: string, overrides: Partial<FakePlace> = {}): FakePlace {
    return {
      id: placeOf(label),
      name: `${SENTINEL.placeName} ${label}`,
      latitude: 41.4036,
      longitude: 2.1744,
      address: { street: SENTINEL.placeStreet, houseNumber: '7', city: 'Barcelona', countryCode: 'ES' },
      timezone: 'Europe/Madrid',
      openingHours: { intervals: [1, 2, 3, 4, 5].map((day) => ({ day, opens: '09:00', closes: '20:00' })) },
      storeLinks: [{ locationId, verification: 'business_asserted' }],
      ...overrides,
    };
  }

  /** The place every vouched-for location names, restored to vouching. Call it before each case that changes one. */
  function resetPlaces(goway: FakeGoWay): void {
    goway.places.clear();
    goway.gone.clear();
    for (const label of ['linked', 'paused', 'noPickup', 'withdrawn', 'draftAfter', 'restricted', 'inactive', 'inSuspendedStore'] as const) {
      goway.places.set(placeOf(label), place(label, ids[label]));
    }
    goway.places.set(
      placeOf('unvouched'),
      place('unvouched', ids.unvouched, { storeLinks: [{ locationId: ids.unvouched, verification: 'community_reported' }] }),
    );
  }

  async function seed(db: Database, goway: FakeGoWay): Promise<void> {
    ids.store = await insertStore(db, 'main', 'active');
    ids.suspendedStore = await insertStore(db, 'suspended', 'suspended');
    const published = { state: 'published', publishedAt: PUBLISHED_AT } as const;
    ids.linked = await insertLocation(db, { storeId: ids.store, label: 'linked', ...published });
    ids.paused = await insertLocation(db, { storeId: ids.store, label: 'paused', ...published, paused: true });
    ids.noPickup = await insertLocation(db, {
      storeId: ids.store,
      label: 'noPickup',
      ...published,
      pickupOffered: false,
      disclosesExactStock: true,
    });
    ids.draftNever = await insertLocation(db, { storeId: ids.store, label: 'draftNever', state: 'draft', publishedAt: null });
    ids.withdrawn = await insertLocation(db, { storeId: ids.store, label: 'withdrawn', state: 'withdrawn', publishedAt: PUBLISHED_AT });
    ids.draftAfter = await insertLocation(db, { storeId: ids.store, label: 'draftAfter', state: 'draft', publishedAt: PUBLISHED_AT });
    ids.restricted = await insertLocation(db, { storeId: ids.store, label: 'restricted', ...published, restricted: true });
    ids.inactive = await insertLocation(db, { storeId: ids.store, label: 'inactive', ...published, active: false });
    ids.unvouched = await insertLocation(db, { storeId: ids.store, label: 'unvouched', ...published });
    ids.noPlace = await insertLocation(db, { storeId: ids.store, label: 'noPlace', ...published, placed: false });
    ids.inSuspendedStore = await insertLocation(db, { storeId: ids.suspendedStore, label: 'inSuspendedStore', ...published });

    ids.inStock = await insertStock(db, {
      label: 'instock',
      price: 1_500,
      searchable: true,
      variants: [[ids.linked, 10, FRESH], [ids.linked, 0, FRESH], [ids.noPickup, 5, FRESH]],
    });
    ids.low = await insertStock(db, { label: 'low', price: 900, variants: [[ids.linked, 2, FRESH]] });
    ids.empty = await insertStock(db, { label: 'empty', price: 700, variants: [[ids.linked, 0, FRESH]] });
    ids.stale = await insertStock(db, {
      label: 'stale',
      price: 1_200,
      variants: [[ids.linked, 50, STALE], [ids.noPickup, 8, STALE]],
    });
    ids.halfStale = await insertStock(db, {
      label: 'halfstale',
      price: 1_100,
      variants: [[ids.linked, 1, FRESH], [ids.linked, 40, STALE]],
    });
    ids.elsewhere = await insertStock(db, { label: 'elsewhere', price: 600, variants: [[ids.paused, 9, FRESH]] });
    ids.archived = await insertStock(db, {
      label: 'archived',
      price: 500,
      status: 'archived',
      variants: [[ids.linked, 9, FRESH]],
    });
    ids.unstocked = await insertStock(db, { label: 'unstocked', price: 400, variants: [null] });

    resetPlaces(goway);
  }

  /** Delete exactly the rows `seed` created. */
  async function cleanup(db: Database): Promise<void> {
    if (listingIds.length > 0) await db.delete(listings).where(inArray(listings.id, listingIds));
    if (locationIds.length > 0) {
      // A suite may publish or withdraw through the service, which appends to
      // the publication's append-only trail; the CASCADE into it needs the
      // trigger to stand down for exactly that one table — one window, one table.
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(
          sql`alter table location_publication_events disable trigger location_publication_events_append_only`,
        );
        await tx.delete(locationPublications).where(inArray(locationPublications.locationId, locationIds));
        await tx.execute(
          sql`alter table location_publication_events enable trigger location_publication_events_append_only`,
        );
      });
      await db.delete(locations).where(inArray(locations.id, locationIds));
    }
    if (storeIds.length > 0) {
      const { deleteTestStores } = await import('../../db/__tests__/store-teardown.js');
      await deleteTestStores(db, storeIds);
    }
  }

  return {
    RUN,
    TERM,
    storeHandle,
    SENTINEL,
    ids,
    placeOf,
    place,
    resetPlaces,
    seed,
    cleanup,
    FRESH,
    STALE,
  };
}
