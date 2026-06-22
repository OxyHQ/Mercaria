/**
 * Seller-listings controller (THIN) — the P2P (individual seller) write path.
 *
 * Ownership is enforced HERE: a caller may only read/update/delete listings
 * whose `oxyUserId` matches their own. Creation funnels through
 * `catalog-write.service.createP2PListing`; the create/update responses are
 * re-hydrated via `catalog-hydration.service` so the client receives the same
 * `Listing` DTO shape it gets from the public read path.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  CreateP2PListingInput,
  UpdateListingInput,
  Listing as ListingDTO,
} from '@mercaria/shared-types';
import { Listing, type IListing } from '../models/listing.js';
import {
  createP2PListing,
  updateListing,
  archiveListing,
} from '../services/catalog-write.service.js';
import { hydrateListings } from '../services/catalog-hydration.service.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { sendSuccess, sendPaginated, sendError, ErrorCodes } from '../utils/api-response.js';
import { respondWithError, forbidden, notFound } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';

/** Load a P2P listing and assert the caller owns it, or throw NOT_FOUND/FORBIDDEN. */
async function loadOwnedListing(listingId: string, oxyUserId: string): Promise<IListing> {
  const listing = await Listing.findById(listingId).lean<IListing | null>();
  if (!listing) {
    throw notFound('Listing not found');
  }
  if (listing.ownerType !== 'user' || listing.oxyUserId !== oxyUserId) {
    throw forbidden('You do not own this listing');
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

/** GET /seller/listings — the caller's own P2P listings (any status). */
export async function listMyListings(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { page, limit } = parsePagination(req.query);
    const filter = { ownerType: 'user' as const, oxyUserId };

    const [docs, total] = await Promise.all([
      Listing.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<IListing[]>(),
      Listing.countDocuments(filter),
    ]);

    const data = await hydrateListings(docs, { viewerId: oxyUserId });
    sendPaginated(res, data, buildPagination(page, limit, total));
  } catch (err) {
    log.general.error({ err }, 'Failed to list seller listings');
    respondWithError(res, err, 'Failed to load your listings');
  }
}

/** POST /seller/listings — create a P2P listing owned by the caller. */
export async function createMyListing(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const listingId = await createP2PListing(oxyUserId, req.body as CreateP2PListingInput);
    const dto = await hydrateById(listingId, oxyUserId);
    sendSuccess(res, dto, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create seller listing');
    respondWithError(res, err, 'Failed to create listing');
  }
}

/** GET /seller/listings/:id — a single owned listing. */
export async function getMyListing(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    await loadOwnedListing(id, oxyUserId);
    const dto = await hydrateById(id, oxyUserId);
    if (!dto) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Listing not found', 404);
      return;
    }
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, listingId: id }, 'Failed to load seller listing');
    respondWithError(res, err, 'Failed to load listing');
  }
}

/** PATCH /seller/listings/:id — update an owned listing. */
export async function updateMyListing(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    await loadOwnedListing(id, oxyUserId);
    await updateListing(id, req.body as UpdateListingInput);
    const dto = await hydrateById(id, oxyUserId);
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, listingId: id }, 'Failed to update seller listing');
    respondWithError(res, err, 'Failed to update listing');
  }
}

/** DELETE /seller/listings/:id — archive an owned listing (soft delete). */
export async function deleteMyListing(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    await loadOwnedListing(id, oxyUserId);
    await archiveListing(id);
    sendSuccess(res, { id, status: 'archived' });
  } catch (err) {
    log.general.error({ err, listingId: id }, 'Failed to delete seller listing');
    respondWithError(res, err, 'Failed to delete listing');
  }
}
