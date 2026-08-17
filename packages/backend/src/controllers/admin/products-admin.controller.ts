/**
 * Store products controller (THIN) — the store-owned catalog write path.
 *
 * Every product mutation is scoped to the loaded store (`req.store`, set by
 * `loadStore`): a product (Listing) is only operable here if its `storeId`
 * matches. Creation/updates funnel through `catalog-write.service`; inventory
 * absolute-sets go through `inventory.service.setAvailable`. Responses are
 * hydrated via `catalog-hydration.service` so they match the public read shape.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  CreateStoreProductInput,
  CreateStoreProductVariantInput,
  ReleaseConnectorPinsInput,
  UpdateListingInput,
  Listing as ListingDTO,
  InventoryLevelDTO,
} from '@mercaria/shared-types';
import {
  findListingById,
  findStoreListingsPageForAdmin,
  type ListingRecord,
} from '../../db/catalog/listingRepository.js';
import { findVariantInListing } from '../../db/catalog/variantRepository.js';
import { findLevelsByVariant } from '../../db/catalog/inventoryLevelRepository.js';
import { findLocation, findLocationsByStore } from '../../db/stores/locationRepository.js';
import {
  createStoreProduct,
  updateListing,
  releasePinnedFields,
  archiveListing,
  addVariant,
  updateVariant,
  removeVariant,
  resolveDefaultLocationId,
  type UpdateVariantInput,
} from '../../services/catalog-write.service.js';
import { setAvailable } from '../../services/inventory.service.js';
import { hydrateListings } from '../../services/catalog-hydration.service.js';
import { enqueueProductPush } from '../../queue/producers.js';
import { parsePagination, buildPagination } from '../../utils/pagination.js';
import { sendSuccess, sendPaginated } from '../../utils/api-response.js';
import { respondWithError, forbidden, notFound } from '../../lib/errors/error-codes.js';
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

/** Load a product and assert it belongs to the loaded store, else NOT_FOUND/FORBIDDEN. */
async function loadStoreProduct(req: Request): Promise<ListingRecord> {
  const id = routeParam(req, 'id');
  const listing = await findListingById(id);
  if (!listing) {
    throw notFound('Product not found');
  }
  if (listing.ownerType !== 'store' || listing.storeId !== storeId(req)) {
    throw forbidden('Product does not belong to this store');
  }
  return listing;
}

/**
 * Enqueue a product push to the store's push/bidirectional connections after a
 * MERCHANT-driven catalog change. Hooking it here (the merchant write path), not
 * inside `catalog-write.service`, is a deliberate loop guard: the connector import
 * path calls the catalog funnels directly and so never triggers a re-push. The
 * push job itself no-ops when the store has no push connections and skips the
 * origin connection, so this is safe to call unconditionally. Best-effort — a
 * failure to enqueue never fails the merchant's request.
 */
async function schedulePush(storeIdValue: string, listingId: string): Promise<void> {
  try {
    await enqueueProductPush({ storeId: storeIdValue, listingId });
  } catch (err) {
    log.general.warn({ err, listingId }, 'Failed to enqueue product push');
  }
}

/**
 * Hydrate a single listing by id into its `Listing` DTO. `includeSource` is on
 * for every admin path so the dashboard/POS can render the connector-provenance
 * ("Synced from …") badge on store-owned listings.
 */
async function hydrateById(listingId: string, viewerId: string): Promise<ListingDTO | undefined> {
  const row = await findListingById(listingId);
  if (!row) {
    return undefined;
  }
  const [dto] = await hydrateListings([row], { viewerId, includeSource: true });
  return dto;
}

/** GET /admin/stores/:storeId/products — the store's products (any status). */
export async function listProducts(req: Request, res: Response): Promise<void> {
  try {
    const id = storeId(req);
    const { page, limit } = parsePagination(req.query);

    const { rows, total } = await findStoreListingsPageForAdmin(id, {}, page, limit);

    const data = await hydrateListings(rows, { viewerId: req.userId, includeSource: true });
    sendPaginated(res, data, buildPagination(page, limit, total));
  } catch (err) {
    log.general.error({ err }, 'Failed to list store products');
    respondWithError(res, err, 'Failed to load products');
  }
}

/** POST /admin/stores/:storeId/products — create a store product. */
export async function createProduct(req: Request, res: Response): Promise<void> {
  try {
    const id = storeId(req);
    const listingId = await createStoreProduct(id, req.body as CreateStoreProductInput, {
      // #90: the acting store member OWNS any condition evidence this product
      // needs. `store:manage` is not the gate here — every member who may write
      // a product may state its condition — but the photographs still have to
      // be attributable to a person.
      ...(req.userId ? { actorOxyUserId: req.userId } : {}),
    });
    await schedulePush(id, listingId);
    const dto = await hydrateById(listingId, req.userId ?? '');
    sendSuccess(res, dto, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create store product');
    respondWithError(res, err, 'Failed to create product');
  }
}

/** GET /admin/stores/:storeId/products/:id — a single store product. */
export async function getProduct(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const dto = await hydrateById(listing.id, req.userId ?? '');
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, productId: req.params.id }, 'Failed to load store product');
    respondWithError(res, err, 'Failed to load product');
  }
}

/** PATCH /admin/stores/:storeId/products/:id — update a store product. */
export async function patchProduct(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const listingId = listing.id;
    // `loadStore` 401s on a request with no `req.userId`, so the old
    // `req.userId ? … : {kind: 'source'}` fallback was unreachable — but since
    // #416 that branch would mean "a merchant edit that silently does not pin
    // the field it changed", which is a fail-open in the direction that loses
    // the merchant's work. `getRequiredOxyUserId` throws instead, so the
    // unreachable case stays unreachable by construction rather than by a
    // reading of another middleware.
    await updateListing(listingId, req.body as UpdateListingInput, {
      kind: 'seller',
      oxyUserId: getRequiredOxyUserId(req),
    });
    await schedulePush(storeId(req), listingId);
    const dto = await hydrateById(listingId, req.userId ?? '');
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, productId: req.params.id }, 'Failed to update store product');
    respondWithError(res, err, 'Failed to update product');
  }
}

/**
 * POST /admin/stores/:storeId/products/:id/pins/release — stop holding some of
 * a connector-sourced product's pinned fields (#427).
 *
 * Behind `products:write`, which is the permission that CREATES a pin: a pin is
 * a side effect of editing a field, so any member who can edit the field can
 * make one, and gating the way out more tightly than the way in would let
 * `staff` accumulate pins only an admin could clear. It is also strictly less
 * destructive than the edit itself — releasing a title lets the platform
 * overwrite it eventually, where `products:write` already lets that member
 * overwrite it right now. `channels:write` gates the connection-wide switch,
 * whose blast radius is every field of every product on the connection;
 * `store:manage` is for decisions that bind the store commercially.
 *
 * No `schedulePush`: nothing here changes a field value, so there is nothing
 * the platform needs to hear.
 *
 * Answers with the re-hydrated product, so the caller's own `overriddenFields`
 * is the server's — the pin disappearing is the whole of the visible feedback,
 * because the FIELD does not move until the platform next sends one.
 */
export async function releaseProductPins(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const { fields } = req.body as ReleaseConnectorPinsInput;
    await releasePinnedFields(listing.id, fields, { oxyUserId: getRequiredOxyUserId(req) });
    const dto = await hydrateById(listing.id, req.userId ?? '');
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, productId: req.params.id }, 'Failed to release product field pins');
    respondWithError(res, err, 'Failed to release the pinned fields');
  }
}

/** DELETE /admin/stores/:storeId/products/:id — archive a store product. */
export async function deleteProduct(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    await archiveListing(listing.id);
    sendSuccess(res, { id: listing.id, status: 'archived' });
  } catch (err) {
    log.general.error({ err, productId: req.params.id }, 'Failed to delete store product');
    respondWithError(res, err, 'Failed to delete product');
  }
}

/** POST /admin/stores/:storeId/products/:id/variants — add a variant. */
export async function createVariant(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const listingId = listing.id;
    await addVariant(listingId, req.body as CreateStoreProductVariantInput);
    await schedulePush(storeId(req), listingId);
    const dto = await hydrateById(listingId, req.userId ?? '');
    sendSuccess(res, dto, 201);
  } catch (err) {
    log.general.error({ err, productId: req.params.id }, 'Failed to add variant');
    respondWithError(res, err, 'Failed to add variant');
  }
}

/** PATCH /admin/stores/:storeId/products/:id/variants/:variantId — update a variant. */
export async function patchVariant(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const listingId = listing.id;
    await updateVariant(listingId, routeParam(req, 'variantId'), req.body as UpdateVariantInput);
    await schedulePush(storeId(req), listingId);
    const dto = await hydrateById(listingId, req.userId ?? '');
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, variantId: req.params.variantId }, 'Failed to update variant');
    respondWithError(res, err, 'Failed to update variant');
  }
}

/** DELETE /admin/stores/:storeId/products/:id/variants/:variantId — remove a variant. */
export async function deleteVariant(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const listingId = listing.id;
    await removeVariant(listingId, routeParam(req, 'variantId'));
    await schedulePush(storeId(req), listingId);
    const dto = await hydrateById(listingId, req.userId ?? '');
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, variantId: req.params.variantId }, 'Failed to remove variant');
    respondWithError(res, err, 'Failed to remove variant');
  }
}

/**
 * PATCH /admin/stores/:storeId/products/:id/variants/:variantId/inventory — set
 * available at the store's DEFAULT location (legacy single-location endpoint).
 */
export async function setVariantInventory(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const listingId = listing.id;
    const body = req.body as { available: number };
    const locationId = await resolveDefaultLocationId(storeId(req));
    await setAvailable(routeParam(req, 'variantId'), listingId, locationId, body.available);
    const dto = await hydrateById(listingId, req.userId ?? '');
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, variantId: req.params.variantId }, 'Failed to set inventory');
    respondWithError(res, err, 'Failed to set inventory');
  }
}

/** Assert a variant belongs to the listing, else NOT_FOUND. */
async function assertVariantInListing(variantId: string, listingId: string): Promise<void> {
  if (!(await findVariantInListing(listingId, variantId))) {
    throw notFound('Variant not found');
  }
}

/** Build the per-location `InventoryLevelDTO[]` for a variant (joins location names). */
async function variantLevelDTOs(variantId: string, storeIdValue: string): Promise<InventoryLevelDTO[]> {
  const levels = await findLevelsByVariant(variantId);
  if (levels.length === 0) {
    return [];
  }

  // The store's own locations, which is every location a level of its variants
  // can name — one read rather than a lookup per level.
  const locations = await findLocationsByStore(storeIdValue);
  const nameById = new Map(locations.map((l) => [l.id, l.name]));

  return [...levels]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((level) => ({
      locationId: level.locationId,
      locationName: nameById.get(level.locationId) ?? 'Unknown location',
      available: level.available,
    }));
}

/**
 * GET /admin/stores/:storeId/products/:id/variants/:variantId/levels — the
 * variant's per-location available stock (store products only).
 */
export async function listVariantLevels(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const variantId = routeParam(req, 'variantId');
    await assertVariantInListing(variantId, listing.id);
    sendSuccess(res, await variantLevelDTOs(variantId, storeId(req)));
  } catch (err) {
    log.general.error({ err, variantId: req.params.variantId }, 'Failed to list inventory levels');
    respondWithError(res, err, 'Failed to load inventory levels');
  }
}

/**
 * PATCH /admin/stores/:storeId/products/:id/variants/:variantId/levels/:locationId
 * — absolute-set available at one location (store products only). Verifies the
 * location belongs to the store before writing. Returns the updated levels.
 */
export async function setVariantLevelInventory(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const variantId = routeParam(req, 'variantId');
    const locationId = routeParam(req, 'locationId');
    await assertVariantInListing(variantId, listing.id);

    // The location must belong to THIS store — the scoping is the authorization,
    // and without it a member could stock a variant at another store's warehouse.
    if (!(await findLocation(storeId(req), locationId))) {
      throw notFound('Location not found');
    }

    const body = req.body as { available: number };
    await setAvailable(variantId, listing.id, locationId, body.available);
    sendSuccess(res, await variantLevelDTOs(variantId, storeId(req)));
  } catch (err) {
    log.general.error(
      { err, variantId: req.params.variantId, locationId: req.params.locationId },
      'Failed to set inventory level',
    );
    respondWithError(res, err, 'Failed to set inventory level');
  }
}
