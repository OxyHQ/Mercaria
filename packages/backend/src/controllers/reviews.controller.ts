/**
 * Reviews controller (THIN).
 *
 * Logic lives in `review.service` and `services/reviews/*`. `POST /reviews`
 * writes a scoped review; the GETs are the public scoped reads plus the
 * authenticated "what may I review?" surface. `GET /listings/:id/reviews` and
 * `GET /stores/:handle/reviews` are the LEGACY reads, mounted on the listings +
 * stores routers and kept working through the compatibility window.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { sendSuccess, sendPaginated } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { routeParam } from '../utils/request.js';
import {
  createReview,
  listReviews,
  listReviewsForStoreHandle,
  listScopedReviewsWithAggregate,
} from '../services/review.service.js';
import {
  listEligibilitiesForOrder,
  listOpenEligibilities,
} from '../services/reviews/review-eligibility.service.js';
import { log } from '../lib/logger.js';

/** How many open eligibilities one order-history page asks for. */
const ELIGIBILITY_PAGE_LIMIT = 50;

/** POST /reviews — write a scoped review. */
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

/**
 * GET /reviews/product/:canonicalProductId — a canonical product's PRODUCT
 * reviews, plus the aggregate the page displays.
 *
 * The aggregate travels with the page deliberately: a client that derived an
 * average from the first page of reviews would show a number that is not the
 * product's rating, and #75's structured data mirrors what the page shows.
 */
export async function listProductReviews(req: Request, res: Response): Promise<void> {
  const canonicalProductId = routeParam(req, 'canonicalProductId');
  try {
    const { page, limit } = parsePagination(req.query);
    const { data, total, aggregate } = await listScopedReviewsWithAggregate(
      'product',
      canonicalProductId,
      { page, limit },
    );
    sendPaginated(res, data, buildPagination(page, limit, total), { aggregate });
  } catch (err) {
    log.general.error({ err, canonicalProductId }, 'Failed to list product reviews');
    respondWithError(res, err, 'Failed to load reviews');
  }
}

/** GET /reviews/merchant/:merchantId — a merchant's SERVICE reviews + aggregate. */
export async function listMerchantReviews(req: Request, res: Response): Promise<void> {
  const merchantId = routeParam(req, 'merchantId');
  try {
    const { page, limit } = parsePagination(req.query);
    const { data, total, aggregate } = await listScopedReviewsWithAggregate(
      'merchant',
      merchantId,
      { page, limit },
    );
    sendPaginated(res, data, buildPagination(page, limit, total), { aggregate });
  } catch (err) {
    log.general.error({ err, merchantId }, 'Failed to list merchant reviews');
    respondWithError(res, err, 'Failed to load reviews');
  }
}

/**
 * GET /reviews/eligibilities — what this account may still review.
 *
 * The order-history surface's read (#76 UI rule 3). It carries the scope, the
 * target and the verification EVIDENCE TYPE, and no contact or payment
 * identifier, because `ReviewEligibility` has no field for one.
 */
export async function listMyReviewEligibilities(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const eligibilities = await listOpenEligibilities(oxyUserId, ELIGIBILITY_PAGE_LIMIT);
    sendSuccess(res, eligibilities);
  } catch (err) {
    log.general.error({ err }, 'Failed to list review eligibilities');
    respondWithError(res, err, 'Failed to load review eligibilities');
  }
}

/** GET /reviews/eligibilities/order/:orderId — one order's eligibilities (owner only). */
export async function listOrderReviewEligibilities(req: Request, res: Response): Promise<void> {
  const orderId = routeParam(req, 'orderId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const eligibilities = await listEligibilitiesForOrder(orderId, oxyUserId);
    sendSuccess(res, eligibilities);
  } catch (err) {
    log.general.error({ err, orderId }, 'Failed to list order review eligibilities');
    respondWithError(res, err, 'Failed to load review eligibilities');
  }
}

/** GET /listings/:id/reviews — a listing's published reviews (paginated, LEGACY). */
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

/** GET /stores/:handle/reviews — a store's published reviews (paginated, LEGACY). */
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
