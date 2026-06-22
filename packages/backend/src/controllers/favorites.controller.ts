/**
 * Favorites controller (THIN) — the buyer's wishlist.
 *
 * Logic lives in `favorite.service`. `GET` returns the buyer's hydrated saved
 * listings (paginated via the F1 catalog-hydration path); `POST`/`DELETE` toggle
 * a single listing idempotently (POST when already saved is a no-op success;
 * DELETE when absent is a no-op success).
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { parsePagination } from '../utils/pagination.js';
import { sendSuccess, sendPaginated } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { listFavorites, save, unsave } from '../services/favorite.service.js';
import { log } from '../lib/logger.js';

/** GET /favorites — the buyer's saved listings (hydrated, paginated). */
export async function listMyFavorites(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { page, limit } = parsePagination(req.query);
    const { data, pagination } = await listFavorites(oxyUserId, page, limit);
    sendPaginated(res, data, pagination);
  } catch (err) {
    log.general.error({ err }, 'Failed to list favorites');
    respondWithError(res, err, 'Failed to load your favorites');
  }
}

/** POST /favorites/:listingId — save (favorite) a listing (idempotent). */
export async function addFavorite(req: Request, res: Response): Promise<void> {
  const listingId = routeParam(req, 'listingId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const result = await save(oxyUserId, listingId);
    sendSuccess(res, result);
  } catch (err) {
    log.general.error({ err, listingId }, 'Failed to add favorite');
    respondWithError(res, err, 'Failed to save listing');
  }
}

/** DELETE /favorites/:listingId — unsave (un-favorite) a listing (idempotent). */
export async function removeFavorite(req: Request, res: Response): Promise<void> {
  const listingId = routeParam(req, 'listingId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const result = await unsave(oxyUserId, listingId);
    sendSuccess(res, result);
  } catch (err) {
    log.general.error({ err, listingId }, 'Failed to remove favorite');
    respondWithError(res, err, 'Failed to remove listing from favorites');
  }
}
