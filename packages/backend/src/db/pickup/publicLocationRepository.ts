/**
 * The reads behind the PUBLIC location surface (#1017,
 * `GET /public/v1/locations…`): a location's commerce facts, the published
 * shop fronts of a store or at a GoWay place, and one location's stock levels.
 *
 * Nothing about where a location is: that is the GoWay place
 * `locations.go_way_place_id` names (ADR 0013), and the service reads it from
 * GoWay. Nothing about the operational location either — its name, type and
 * delivery address are never selected, so a public read cannot serialize them
 * by mistake.
 *
 * ## What the SQL decides and what it does not
 *
 * The list reads apply every predicate that is a stored fact — published, not
 * restricted, the location active, the store live — so a page never carries a
 * row the detail read would refuse on those grounds. Whether the PLACE names
 * the location back is GoWay's answer, applied by the service per read and
 * never stored.
 */

import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type {
  LocationPublicationState,
  PickupIdentityRequirement,
  PickupPaymentRequirement,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { inventoryLevels } from '../schema/catalog.js';
import { locationPublications } from '../schema/pickup.js';
import { locations, stores } from '../schema/stores.js';

/** One location and its publication, as the public reads use them. */
export interface PublicLocationRow {
  readonly locationId: string;
  readonly storeId: string;
  readonly goWayPlaceId: string | null;
  readonly locationActive: boolean;
  readonly publicationState: LocationPublicationState;
  /** The FIRST publication; `null` when the location was never published. */
  readonly publishedAt: Date | null;
  readonly restricted: boolean;
  readonly pickupOffered: boolean;
  readonly pickupPaused: boolean;
  readonly pickupInstructions: string | null;
  readonly identityRequirement: PickupIdentityRequirement;
  readonly paymentRequirement: PickupPaymentRequirement;
  readonly stockConfirmationIntervalSeconds: number;
  readonly disclosesExactStock: boolean;
  readonly lowStockThreshold: number;
}

/** One level row at one location. */
export interface LocationStockLevel {
  readonly listingId: string;
  readonly variantId: string;
  readonly available: number;
  /** When the count was last written — what freshness is measured from. */
  readonly updatedAt: Date;
}

const publicLocationColumns = {
  locationId: locations.id,
  storeId: locations.storeId,
  goWayPlaceId: locations.goWayPlaceId,
  locationActive: locations.isActive,
  publicationState: locationPublications.publicationState,
  publishedAt: locationPublications.publishedAt,
  restrictedAt: locationPublications.restrictedAt,
  pickupOffered: locationPublications.pickupOffered,
  pickupPausedAt: locationPublications.pickupPausedAt,
  pickupInstructions: locationPublications.pickupInstructions,
  identityRequirement: locationPublications.identityRequirement,
  paymentRequirement: locationPublications.paymentRequirement,
  stockConfirmationIntervalSeconds: locationPublications.stockConfirmationIntervalSeconds,
  disclosesExactStock: locationPublications.disclosesExactStock,
  lowStockThreshold: locationPublications.lowStockThreshold,
};

/** A location joined to its publication — every public read starts here. */
function selectPublicLocations(db: DatabaseOrTransaction) {
  return db
    .select(publicLocationColumns)
    .from(locations)
    .innerJoin(locationPublications, eq(locationPublications.locationId, locations.id));
}

type SelectedLocation = Awaited<ReturnType<typeof selectPublicLocations>>[number];

function toRow(row: SelectedLocation): PublicLocationRow {
  return {
    locationId: row.locationId,
    storeId: row.storeId,
    goWayPlaceId: row.goWayPlaceId,
    locationActive: row.locationActive,
    publicationState: row.publicationState,
    publishedAt: row.publishedAt,
    restricted: row.restrictedAt !== null,
    pickupOffered: row.pickupOffered,
    pickupPaused: row.pickupPausedAt !== null,
    pickupInstructions: row.pickupInstructions,
    identityRequirement: row.identityRequirement,
    paymentRequirement: row.paymentRequirement,
    stockConfirmationIntervalSeconds: row.stockConfirmationIntervalSeconds,
    disclosesExactStock: row.disclosesExactStock,
    lowStockThreshold: row.lowStockThreshold,
  };
}

/**
 * One location with its publication, whatever state either is in — or `null`
 * when the location does not exist or has never had a publication, which is
 * "never published" either way.
 */
export async function findPublicLocationById(
  locationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PublicLocationRow | null> {
  const [row] = await selectPublicLocations(db).where(eq(locations.id, locationId)).limit(1);
  return row ? toRow(row) : null;
}

/** Which published shop fronts a list read is about. */
export type PublishedLocationScope = { readonly storeId: string } | { readonly goWayPlaceId: string };

/**
 * One OFFSET slice of the published, unrestricted, active locations of a live
 * store — of one store, or naming one GoWay place — in id order, reading
 * `limit + 1` rows to answer "is there more" without a count.
 */
export async function findPublishedLocationsSlice(
  scope: PublishedLocationScope,
  offset: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: PublicLocationRow[]; hasMore: boolean }> {
  const predicates: SQL[] = [
    eq(locationPublications.publicationState, 'published'),
    isNull(locationPublications.restrictedAt),
    eq(locations.isActive, true),
    eq(stores.status, 'active'),
    'storeId' in scope ? eq(locations.storeId, scope.storeId) : eq(locations.goWayPlaceId, scope.goWayPlaceId),
  ];
  const rows = await selectPublicLocations(db)
    .innerJoin(stores, eq(stores.id, locations.storeId))
    .where(and(...predicates))
    .orderBy(asc(locations.id))
    .limit(limit + 1)
    .offset(offset);
  const hasMore = rows.length > limit;
  return { rows: (hasMore ? rows.slice(0, limit) : rows).map(toRow), hasMore };
}

/** Every level row one location holds for a set of listings. */
export async function findLocationStockLevels(
  locationId: string,
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationStockLevel[]> {
  if (listingIds.length === 0) return [];
  const rows = await db
    .select({
      listingId: inventoryLevels.listingId,
      variantId: inventoryLevels.variantId,
      available: inventoryLevels.available,
      updatedAt: inventoryLevels.updatedAt,
    })
    .from(inventoryLevels)
    .where(and(eq(inventoryLevels.locationId, locationId), inArray(inventoryLevels.listingId, [...listingIds])));
  return rows.map((row) => ({
    listingId: row.listingId,
    variantId: row.variantId,
    available: Number(row.available),
    updatedAt: row.updatedAt,
  }));
}
