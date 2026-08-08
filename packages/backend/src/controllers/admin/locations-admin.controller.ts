/**
 * Store locations controller (THIN) — the store inventory-location admin path.
 *
 * Every location operation is scoped to the loaded store (`req.store`, set by
 * `loadStore`): a member may only list/create/update/delete locations on their
 * own store. All business logic + the protection invariants (a store keeps ≥1
 * location; the default cannot be deleted) live in `location.service`. Responses
 * are the `Location` DTO.
 */

import type { Request, Response } from 'express';
import type {
  CreateLocationInput,
  UpdateLocationInput,
  Location as LocationDTO,
} from '@mercaria/shared-types';
import type { LocationRecord } from '../../db/stores/locationRepository.js';
import {
  listLocations,
  createLocation,
  updateLocation,
  deleteLocation,
} from '../../services/location.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { respondWithError, notFound } from '../../lib/errors/error-codes.js';
import { routeParam } from '../../utils/request.js';
import { log } from '../../lib/logger.js';

/** The loaded store id for the current request (guaranteed by `loadStore`). */
function storeId(req: Request): string {
  const store = req.store;
  if (!store) {
    throw notFound('Store not loaded');
  }
  return store.id;
}

/**
 * Serialize a location row to the `Location` DTO.
 *
 * The embedded `address` sub-document became nine nullable columns, so "has an
 * address" is no longer a truthy object test. `address_recipient_name` is the
 * discriminator — it is one of the five fields the source sub-schema declared
 * REQUIRED, so it is present for every address that was ever stored and NULL for
 * every row that has none. Testing a genuinely optional column (`label`,
 * `region`, `phone`) instead would drop a real address that simply left it out.
 */
export function toLocationDTO(loc: LocationRecord): LocationDTO {
  const hasAddress =
    loc.addressRecipientName !== null &&
    loc.addressLine1 !== null &&
    loc.addressCity !== null &&
    loc.addressPostalCode !== null &&
    loc.addressCountry !== null;

  return {
    id: loc.id,
    storeId: loc.storeId,
    name: loc.name,
    type: loc.type,
    ...(hasAddress
      ? {
          address: {
            ...(loc.addressLabel ? { label: loc.addressLabel } : {}),
            recipientName: loc.addressRecipientName,
            line1: loc.addressLine1,
            ...(loc.addressLine2 ? { line2: loc.addressLine2 } : {}),
            city: loc.addressCity,
            ...(loc.addressRegion ? { region: loc.addressRegion } : {}),
            postalCode: loc.addressPostalCode,
            country: loc.addressCountry,
            ...(loc.addressPhone ? { phone: loc.addressPhone } : {}),
          },
        }
      : {}),
    isDefault: loc.isDefault,
    isActive: loc.isActive,
    fulfillsOnlineOrders: loc.fulfillsOnlineOrders,
    createdAt: loc.createdAt.toISOString(),
    updatedAt: loc.updatedAt.toISOString(),
  };
}

/** GET /admin/stores/:storeId/locations — the store's locations. */
export async function listStoreLocations(req: Request, res: Response): Promise<void> {
  try {
    const locations = await listLocations(storeId(req));
    sendSuccess(res, locations.map(toLocationDTO));
  } catch (err) {
    log.general.error({ err }, 'Failed to list store locations');
    respondWithError(res, err, 'Failed to load locations');
  }
}

/** POST /admin/stores/:storeId/locations — create a location. */
export async function createStoreLocation(req: Request, res: Response): Promise<void> {
  try {
    const location = await createLocation(storeId(req), req.body as CreateLocationInput);
    sendSuccess(res, toLocationDTO(location), 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create store location');
    respondWithError(res, err, 'Failed to create location');
  }
}

/** PATCH /admin/stores/:storeId/locations/:id — update a location. */
export async function patchStoreLocation(req: Request, res: Response): Promise<void> {
  try {
    const location = await updateLocation(
      storeId(req),
      routeParam(req, 'id'),
      req.body as UpdateLocationInput,
    );
    sendSuccess(res, toLocationDTO(location));
  } catch (err) {
    log.general.error({ err, locationId: req.params.id }, 'Failed to update store location');
    respondWithError(res, err, 'Failed to update location');
  }
}

/** DELETE /admin/stores/:storeId/locations/:id — delete a location. */
export async function deleteStoreLocation(req: Request, res: Response): Promise<void> {
  try {
    const id = routeParam(req, 'id');
    await deleteLocation(storeId(req), id);
    sendSuccess(res, { id, deleted: true });
  } catch (err) {
    log.general.error({ err, locationId: req.params.id }, 'Failed to delete store location');
    respondWithError(res, err, 'Failed to delete location');
  }
}
