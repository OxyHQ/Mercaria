/**
 * Location service — store inventory location lifecycle + invariants.
 *
 * Owns create/list/update/delete of a store's `Location`s plus the protection
 * invariants (mirroring `store.service` for membership): a store must always keep
 * at least one location, and the DEFAULT location can be neither deleted while it
 * is the default nor left absent. Exactly one location per store is `isDefault`;
 * promoting a new default clears the previous one. Invariants are enforced by
 * throwing typed `MercariaError`s (`CONFLICT`/`NOT_FOUND`) that controllers map to
 * the response. Every location is scoped to its `storeId`, so a member can only
 * operate on their own store's locations.
 */

import type { CreateLocationInput, UpdateLocationInput } from '@mercaria/shared-types';
import { Location, type ILocation, type ILocationAddress } from '../models/location.js';
import { conflict, notFound } from '../lib/errors/error-codes.js';

/** Map an input address (or undefined) to the persisted embedded shape. */
function toAddress(address: CreateLocationInput['address']): ILocationAddress | undefined {
  if (!address) {
    return undefined;
  }
  const persisted: ILocationAddress = {
    recipientName: address.recipientName,
    line1: address.line1,
    city: address.city,
    postalCode: address.postalCode,
    country: address.country,
  };
  if (address.label) persisted.label = address.label;
  if (address.line2) persisted.line2 = address.line2;
  if (address.region) persisted.region = address.region;
  if (address.phone) persisted.phone = address.phone;
  return persisted;
}

/** List a store's locations (default first, then by creation order). */
export async function listLocations(storeId: string): Promise<ILocation[]> {
  return Location.find({ storeId })
    .sort({ isDefault: -1, createdAt: 1 })
    .lean<ILocation[]>();
}

/**
 * Create a location for a store. Promoting it to default (`isDefault: true`)
 * clears any previous default first so exactly one default remains.
 */
export async function createLocation(
  storeId: string,
  input: CreateLocationInput,
): Promise<ILocation> {
  if (input.isDefault === true) {
    await Location.updateMany({ storeId }, { $set: { isDefault: false } });
  }

  const address = toAddress(input.address);
  const location = await Location.create({
    storeId,
    name: input.name,
    type: input.type ?? 'warehouse',
    ...(address ? { address } : {}),
    isDefault: input.isDefault ?? false,
    isActive: input.isActive ?? true,
    fulfillsOnlineOrders: input.fulfillsOnlineOrders ?? true,
  });

  return location.toObject();
}

/**
 * Update a store location in place (scoped to `storeId`, else NOT_FOUND).
 * Promoting it to default clears any previous default first.
 */
export async function updateLocation(
  storeId: string,
  locationId: string,
  patch: UpdateLocationInput,
): Promise<ILocation> {
  const location = await Location.findOne({ _id: locationId, storeId });
  if (!location) {
    throw notFound('Location not found');
  }

  if (patch.isDefault === true && !location.isDefault) {
    await Location.updateMany({ storeId }, { $set: { isDefault: false } });
  }

  if (patch.name !== undefined) location.name = patch.name;
  if (patch.type !== undefined) location.type = patch.type;
  if (patch.address !== undefined) location.address = toAddress(patch.address);
  if (patch.isDefault !== undefined) location.isDefault = patch.isDefault;
  if (patch.isActive !== undefined) location.isActive = patch.isActive;
  if (patch.fulfillsOnlineOrders !== undefined) {
    location.fulfillsOnlineOrders = patch.fulfillsOnlineOrders;
  }

  await location.save();
  return location.toObject();
}

/**
 * Delete a store location (scoped to `storeId`, else NOT_FOUND). Rejects deleting
 * the store's LAST location or its DEFAULT location — a store must always retain a
 * routable default for inventory.
 */
export async function deleteLocation(storeId: string, locationId: string): Promise<void> {
  const location = await Location.findOne({ _id: locationId, storeId }).lean<ILocation | null>();
  if (!location) {
    throw notFound('Location not found');
  }

  const count = await Location.countDocuments({ storeId });
  if (count <= 1 || location.isDefault) {
    throw conflict('Cannot delete the last or default location');
  }

  await Location.deleteOne({ _id: locationId, storeId });
}
