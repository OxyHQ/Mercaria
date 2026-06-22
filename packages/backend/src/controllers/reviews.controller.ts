/**
 * Reviews controller (THIN).
 *
 * Logic lives in `review.service`. `POST /reviews` writes a verified-purchase
 * review; `GET /listings/:id/reviews` and `GET /stores/:handle/reviews` are the
 * public, paginated read endpoints (mounted on the listings + stores routers).
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { sendSuccess, sendPaginated } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { routeParam } from '../utils/request.js';
import { createReview, listReviews, listReviewsForStoreHandle } from '../services/review.service.js';
import { log } from '../lib/logger.js';

/** POST /reviews — write a verified-purchase review against one target. */
export async function createReviewHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const review = await createReview(oxyUserId, req.body);
    sendSuccess(res, review, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create review');
    respondWithError(res, err, 'Failed to create review');
  }
}

/** GET /listings/:id/reviews — a listing's published reviews (paginated). */
export async function listListingReviews(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const { page, limit } = parsePagination(req.query);
    const { data, total } = await listReviews({ targetType: 'listing', targetId: id }, { page, limit });
    sendPaginated(res, data, buildPagination(page, limit, total));
  } catch (err) {
    log.general.error({ err, listingId: id }, 'Failed to list listing reviews');
    respondWithError(res, err, 'Failed to load reviews');
  }
}

/** GET /stores/:handle/reviews — a store's published reviews (paginated). */
export async function listStoreReviews(req: Request, res: Response): Promise<void> {
  const handle = routeParam(req, 'handle');
  try {
    const { page, limit } = parsePagination(req.query);
    const { data, total } = await listReviewsForStoreHandle(handle, { page, limit });
    sendPaginated(res, data, buildPagination(page, limit, total));
  } catch (err) {
    log.general.error({ err, handle }, 'Failed to list store reviews');
    respondWithError(res, err, 'Failed to load reviews');
  }
}
