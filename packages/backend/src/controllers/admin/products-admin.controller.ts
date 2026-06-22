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
import type {
  CreateStoreProductInput,
  CreateStoreProductVariantInput,
  UpdateListingInput,
  Listing as ListingDTO,
  InventoryLevelDTO,
} from '@mercaria/shared-types';
import { Listing, type IListing } from '../../models/listing.js';
import { ProductVariant } from '../../models/product-variant.js';
import { Location, type ILocation } from '../../models/location.js';
import { InventoryLevel, type IInventoryLevelDoc } from '../../models/inventory-level.js';
import {
  createStoreProduct,
  updateListing,
  archiveListing,
  addVariant,
  updateVariant,
  removeVariant,
  resolveDefaultLocationId,
  type UpdateVariantInput,
} from '../../services/catalog-write.service.js';
import { setAvailable } from '../../services/inventory.service.js';
import { hydrateListings } from '../../services/catalog-hydration.service.js';
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
  return String((store as { _id: unknown })._id);
}

/** Load a product and assert it belongs to the loaded store, else NOT_FOUND/FORBIDDEN. */
async function loadStoreProduct(req: Request): Promise<IListing> {
  const id = routeParam(req, 'id');
  const listing = await Listing.findById(id).lean<IListing | null>();
  if (!listing) {
    throw notFound('Product not found');
  }
  if (listing.ownerType !== 'store' || listing.storeId !== storeId(req)) {
    throw forbidden('Product does not belong to this store');
  }
  return listing;
}

/** Hydrate a single listing by id into its `Listing` DTO. */
async function hydrateById(listingId: string, viewerId: string): Promise<ListingDTO | undefined> {
  const doc = await Listing.findById(listingId).lean<IListing | null>();
  if (!doc) {
    return undefined;
  }
  const [dto] = await hydrateListings([doc], { viewerId });
  return dto;
}

/** GET /admin/stores/:storeId/products — the store's products (any status). */
export async function listProducts(req: Request, res: Response): Promise<void> {
  try {
    const id = storeId(req);
    const { page, limit } = parsePagination(req.query);
    const filter = { ownerType: 'store' as const, storeId: id };

    const [docs, total] = await Promise.all([
      Listing.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<IListing[]>(),
      Listing.countDocuments(filter),
    ]);

    const data = await hydrateListings(docs, { viewerId: req.userId });
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
    const listingId = await createStoreProduct(id, req.body as CreateStoreProductInput);
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
    const dto = await hydrateById(String((listing as { _id: unknown })._id), req.userId ?? '');
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
    const listingId = String((listing as { _id: unknown })._id);
    await updateListing(listingId, req.body as UpdateListingInput);
    const dto = await hydrateById(listingId, req.userId ?? '');
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, productId: req.params.id }, 'Failed to update store product');
    respondWithError(res, err, 'Failed to update product');
  }
}

/** DELETE /admin/stores/:storeId/products/:id — archive a store product. */
export async function deleteProduct(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    await archiveListing(String((listing as { _id: unknown })._id));
    sendSuccess(res, { id: String((listing as { _id: unknown })._id), status: 'archived' });
  } catch (err) {
    log.general.error({ err, productId: req.params.id }, 'Failed to delete store product');
    respondWithError(res, err, 'Failed to delete product');
  }
}

/** POST /admin/stores/:storeId/products/:id/variants — add a variant. */
export async function createVariant(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const listingId = String((listing as { _id: unknown })._id);
    await addVariant(listingId, req.body as CreateStoreProductVariantInput);
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
    const listingId = String((listing as { _id: unknown })._id);
    await updateVariant(listingId, routeParam(req, 'variantId'), req.body as UpdateVariantInput);
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
    const listingId = String((listing as { _id: unknown })._id);
    await removeVariant(listingId, routeParam(req, 'variantId'));
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
    const listingId = String((listing as { _id: unknown })._id);
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
  const exists = await ProductVariant.exists({ _id: variantId, listingId });
  if (!exists) {
    throw notFound('Variant not found');
  }
}

/** Build the per-location `InventoryLevelDTO[]` for a variant (joins location names). */
async function variantLevelDTOs(variantId: string): Promise<InventoryLevelDTO[]> {
  const levels = await InventoryLevel.find({ variantId })
    .sort({ createdAt: 1 })
    .lean<IInventoryLevelDoc[]>();
  if (levels.length === 0) {
    return [];
  }

  const locationIds = [...new Set(levels.map((l) => l.locationId))];
  const locations = await Location.find({ _id: { $in: locationIds } })
    .select('name')
    .lean<Pick<ILocation, '_id' | 'name'>[]>();
  const nameById = new Map(locations.map((l) => [String(l._id), l.name]));

  return levels.map((level) => ({
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
    const listingId = String((listing as { _id: unknown })._id);
    const variantId = routeParam(req, 'variantId');
    await assertVariantInListing(variantId, listingId);
    sendSuccess(res, await variantLevelDTOs(variantId));
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
    const listingId = String((listing as { _id: unknown })._id);
    const variantId = routeParam(req, 'variantId');
    const locationId = routeParam(req, 'locationId');
    await assertVariantInListing(variantId, listingId);

    const location = await Location.exists({ _id: locationId, storeId: storeId(req) });
    if (!location) {
      throw notFound('Location not found');
    }

    const body = req.body as { available: number };
    await setAvailable(variantId, listingId, locationId, body.available);
    sendSuccess(res, await variantLevelDTOs(variantId));
  } catch (err) {
    log.general.error(
      { err, variantId: req.params.variantId, locationId: req.params.locationId },
      'Failed to set inventory level',
    );
    respondWithError(res, err, 'Failed to set inventory level');
  }
}
