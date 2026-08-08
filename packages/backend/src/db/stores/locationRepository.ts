/**
 * `locations` — where a store stocks inventory.
 *
 * ## The single-default invariant is now a constraint, and that CHANGES a write
 *
 * Mongo let a store hold two default locations; `location.service` avoided it by
 * clearing the previous default before promoting a new one, in a second
 * statement that could simply not run. Here
 * `locations_store_id_default_key` — `uniqueIndex().on(storeId).where(isDefault)`
 * — makes two defaults unrepresentable.
 *
 * That is why {@link insertLocation} and {@link updateLocation} open a
 * transaction: the clear and the promote must land together or the clear is a
 * store with NO default, which `resolveDefaultLocationId` answers with a
 * NOT_FOUND on the next stock write. Postgres checks a unique index PER
 * STATEMENT, so demote-then-promote in one transaction is fine and
 * promote-then-demote is not.
 *
 * ## Deleting one now raises 23503, and that is the point
 *
 * `draft_orders.location_id` and `connections.sync_settings_target_location_id`
 * are ON DELETE RESTRICT, because NULL already means "the store's default
 * location" on both — so SET NULL would silently REROUTE an open draft's
 * reservation or a live sync rather than refuse. Mongo's delete succeeded and
 * left a dangling id. `location.service.deleteLocation` translates the refusal
 * into its existing CONFLICT contract.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { LocationType } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { inventoryLevels } from '../schema/catalog.js';
import { locations } from '../schema/stores.js';

/** One row of `locations`. */
export type LocationRecord = InferSelectModel<typeof locations>;

/** A postal address as the caller supplies it — the shape `CreateLocationInput` carries. */
export interface AddressInput {
  label?: string;
  recipientName: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
  phone?: string;
}

/**
 * The nine `address_*` columns, as an update patch.
 *
 * `null` clears all nine rather than leaving a half-written address behind: the
 * Mongoose sub-document was replaced wholesale on every write, and a partial
 * update here would leave the previous city beside the new street. Every
 * optional field is written explicitly for the same reason — omitting one would
 * keep the old value.
 */
function addressPatch(address: AddressInput | null): {
  addressLabel: string | null;
  addressRecipientName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  addressCountry: string | null;
  addressPhone: string | null;
} {
  return {
    addressLabel: address?.label ?? null,
    addressRecipientName: address?.recipientName ?? null,
    addressLine1: address?.line1 ?? null,
    addressLine2: address?.line2 ?? null,
    addressCity: address?.city ?? null,
    addressRegion: address?.region ?? null,
    addressPostalCode: address?.postalCode ?? null,
    addressCountry: address?.country ?? null,
    addressPhone: address?.phone ?? null,
  };
}

/** The fields a caller may set when creating a location. */
export interface NewLocation {
  name: string;
  type: LocationType;
  address?: AddressInput;
  isDefault: boolean;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
}

/** The fields a caller may patch. `address: null` clears every address column. */
export interface LocationPatch {
  name?: string;
  type?: LocationType;
  address?: AddressInput | null;
  isDefault?: boolean;
  isActive?: boolean;
  fulfillsOnlineOrders?: boolean;
}

/** A store's locations, default first then oldest first — the admin list order. */
export async function findLocationsByStore(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationRecord[]> {
  return db
    .select()
    .from(locations)
    .where(eq(locations.storeId, storeId))
    .orderBy(desc(locations.isDefault), asc(locations.createdAt));
}

/** One location scoped to its store, or `null` — the scoping IS the authorization. */
export async function findLocation(
  storeId: string,
  locationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationRecord | null> {
  const [row] = await db
    .select()
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.storeId, storeId)))
    .limit(1);
  return row ?? null;
}

/** How many locations a store has. Guards the "never delete the last one" rule. */
export async function countLocations(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(locations)
    .where(eq(locations.storeId, storeId));
  return row?.count ?? 0;
}

/**
 * The store's default location id — the `isDefault` one, falling back to ANY
 * active one, or `null` when the store has none at all.
 *
 * The fallback is carried across from Mongo deliberately: a store whose default
 * was somehow lost still routes stock somewhere rather than failing every write.
 */
export async function findDefaultLocationId(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | null> {
  const [preferred] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.storeId, storeId), eq(locations.isDefault, true)))
    .limit(1);
  if (preferred) return preferred.id;

  const [fallback] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.storeId, storeId), eq(locations.isActive, true)))
    .limit(1);
  return fallback?.id ?? null;
}

/** Clear every default flag on a store. Only ever called inside a transaction. */
async function clearDefault(storeId: string, db: DatabaseOrTransaction): Promise<void> {
  await db
    .update(locations)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(locations.storeId, storeId), eq(locations.isDefault, true)));
}

/**
 * Create a location. Promoting it to default clears the previous default in the
 * SAME transaction — see the module docblock for why that is not optional.
 */
export async function insertLocation(
  storeId: string,
  values: NewLocation,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationRecord> {
  const run = async (tx: DatabaseOrTransaction): Promise<LocationRecord> => {
    if (values.isDefault) {
      await clearDefault(storeId, tx);
    }
    const [row] = await tx
      .insert(locations)
      .values({
        storeId,
        name: values.name,
        type: values.type,
        isDefault: values.isDefault,
        isActive: values.isActive,
        fulfillsOnlineOrders: values.fulfillsOnlineOrders,
        ...addressPatch(values.address ?? null),
      })
      .returning();
    return row;
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}

/**
 * Patch a location, clearing the previous default first when this one is being
 * promoted. Returns the updated row, or `null` when it does not belong to the
 * store.
 */
export async function updateLocation(
  storeId: string,
  locationId: string,
  patch: LocationPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationRecord | null> {
  const run = async (tx: DatabaseOrTransaction): Promise<LocationRecord | null> => {
    if (patch.isDefault === true) {
      await clearDefault(storeId, tx);
    }

    const rows = await tx
      .update(locations)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.fulfillsOnlineOrders !== undefined
          ? { fulfillsOnlineOrders: patch.fulfillsOnlineOrders }
          : {}),
        ...(patch.address !== undefined ? addressPatch(patch.address) : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(locations.id, locationId), eq(locations.storeId, storeId)))
      .returning();

    return rows[0] ?? null;
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}

/**
 * Delete a location scoped to its store.
 *
 * @returns The ids of the variants whose `inventory_levels` rows the cascade
 *   removed, so the caller can recompute their rollups. The FK deletes the level
 *   rows; it does NOT update the denormalized `product_variants.inventory_*`
 *   totals, so without this the variant keeps counting stock at a place that no
 *   longer exists — the exact orphan the cascade was added to stop leaking, one
 *   layer up. Read BEFORE the delete, because after it there is nothing to read.
 */
export async function deleteLocation(
  storeId: string,
  locationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ deleted: boolean; affectedVariantIds: string[] }> {
  const run = async (
    tx: DatabaseOrTransaction,
  ): Promise<{ deleted: boolean; affectedVariantIds: string[] }> => {
    // Read BEFORE the delete: after the cascade fires there is no level row left
    // to name the variant. `selectDistinct` rather than a raw `db.execute`,
    // which bypasses drizzle's column mappers.
    const levels = await tx
      .selectDistinct({ variantId: inventoryLevels.variantId })
      .from(inventoryLevels)
      .where(eq(inventoryLevels.locationId, locationId));

    const rows = await tx
      .delete(locations)
      .where(and(eq(locations.id, locationId), eq(locations.storeId, storeId)))
      .returning({ id: locations.id });

    if (rows.length === 0) {
      return { deleted: false, affectedVariantIds: [] };
    }
    return {
      deleted: true,
      affectedVariantIds: levels.map((row) => row.variantId),
    };
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}
