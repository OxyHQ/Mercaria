/**
 * Location service — store inventory location lifecycle + invariants.
 *
 * Owns create/list/update/delete of a store's locations plus the protection
 * invariants (mirroring `store.service` for membership): a store must always keep
 * at least one location, and the DEFAULT location can be neither deleted while it
 * is the default nor left absent. Exactly one location per store is `isDefault`;
 * promoting a new default clears the previous one. Invariants are enforced by
 * throwing typed `MercariaError`s (`CONFLICT`/`NOT_FOUND`) that controllers map to
 * the response. Every location is scoped to its `storeId`, so a member can only
 * operate on their own store's locations.
 *
 * ## Two things the Postgres port changed, both of them real
 *
 * **The single-default rule is now a constraint.** `promote a new default` and
 * `clear the old one` used to be two statements that could half-happen; the
 * repository runs them in one transaction under a partial unique index, so two
 * defaults are unrepresentable rather than merely avoided.
 *
 * **Deleting a location can now be REFUSED by the database.** `draft_orders` and
 * `connections.sync_settings_target_location_id` reference it ON DELETE RESTRICT,
 * because NULL already means "the store's default location" on both — SET NULL
 * would silently reroute an open draft's reservation or a live sync. Under Mongo
 * the delete simply succeeded and left a dangling id. That refusal arrives as
 * SQLSTATE 23503 and is translated here into the CONFLICT this service already
 * promises, with a message naming what is holding the location — a bare 500 would
 * tell the merchant nothing they could act on.
 */

import type { CreateLocationInput, UpdateLocationInput } from '@mercaria/shared-types';
import { isForeignKeyViolation } from '@oxyhq/db';
import {
  countLocations,
  deleteLocation as deleteLocationRow,
  findLocation,
  findLocationsByStore,
  insertLocation,
  updateLocation as updateLocationRow,
  type LocationRecord,
} from '../db/stores/locationRepository.js';
import { recomputeVariantRollup } from '../db/catalog/variantRepository.js';
import { conflict, notFound } from '../lib/errors/error-codes.js';

export type { LocationRecord };

/** List a store's locations (default first, then by creation order). */
export async function listLocations(storeId: string): Promise<LocationRecord[]> {
  return findLocationsByStore(storeId);
}

/**
 * Create a location for a store. Promoting it to default (`isDefault: true`)
 * clears any previous default first so exactly one default remains.
 */
export async function createLocation(
  storeId: string,
  input: CreateLocationInput,
): Promise<LocationRecord> {
  return insertLocation(storeId, {
    name: input.name,
    type: input.type ?? 'warehouse',
    ...(input.address ? { address: input.address } : {}),
    isDefault: input.isDefault ?? false,
    isActive: input.isActive ?? true,
    fulfillsOnlineOrders: input.fulfillsOnlineOrders ?? true,
  });
}

/**
 * Update a store location in place (scoped to `storeId`, else NOT_FOUND).
 * Promoting it to default clears any previous default first.
 */
export async function updateLocation(
  storeId: string,
  locationId: string,
  patch: UpdateLocationInput,
): Promise<LocationRecord> {
  const updated = await updateLocationRow(storeId, locationId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.type !== undefined ? { type: patch.type } : {}),
    // `undefined` means "not supplied"; an explicitly supplied `undefined`
    // address means "clear it", which the repository writes as nine NULLs.
    ...(patch.address !== undefined ? { address: patch.address ?? null } : {}),
    ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    ...(patch.fulfillsOnlineOrders !== undefined
      ? { fulfillsOnlineOrders: patch.fulfillsOnlineOrders }
      : {}),
  });

  if (!updated) {
    throw notFound('Location not found');
  }
  return updated;
}

/**
 * Delete a store location (scoped to `storeId`, else NOT_FOUND). Rejects deleting
 * the store's LAST location or its DEFAULT location — a store must always retain a
 * routable default for inventory.
 */
export async function deleteLocation(storeId: string, locationId: string): Promise<void> {
  const location = await findLocation(storeId, locationId);
  if (!location) {
    throw notFound('Location not found');
  }

  const count = await countLocations(storeId);
  if (count <= 1 || location.isDefault) {
    throw conflict('Cannot delete the last or default location');
  }

  let affectedVariantIds: string[];
  try {
    ({ affectedVariantIds } = await deleteLocationRow(storeId, locationId));
  } catch (err) {
    // 23503 is the RESTRICT side of the schema answering, and it is the ONLY
    // outcome here that is a legitimate refusal rather than a fault — so it is
    // caught by SQLSTATE and everything else rethrows untouched.
    if (isForeignKeyViolation(err)) {
      throw conflict(
        'This location is still referenced by an open draft order or a channel ' +
          'sync target. Reassign those first, then delete the location.',
      );
    }
    throw err;
  }

  // `inventory_levels` CASCADE from the location, which removes the orphaned
  // rows Mongo used to leak — but a cascade does NOT update the denormalized
  // `product_variants.inventory_*` rollup, so a variant would keep counting
  // stock at a place that no longer exists. Recompute each affected variant.
  for (const variantId of affectedVariantIds) {
    await recomputeVariantRollup(variantId);
  }
}
