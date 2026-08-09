/**
 * Offer controller (THIN) — the public comparison read (#57).
 *
 * Every handler delegates to `services/offers/`. Nothing here derives anything:
 * marketplace-ness, freshness and native checkout eligibility are all computed
 * in the projection, so a controller cannot produce a second answer to any of
 * them, and the DTO carries no field a serializer could widen into one.
 */

import type { Request, Response } from 'express';
import type { OfferAvailability, OfferCondition, OfferKind } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { getOffer, listOffers } from '../services/offers/offer.service.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/**
 * GET /offers?canonicalVariantId= | ?canonicalProductId=
 *
 * Twenty merchant listings for one variant produce twenty offers here (issue
 * acceptance 1), each naming its own seller, its own channel and its own
 * derived `sellerRole` — so the marketplace platform and the actual seller are
 * both present and neither is inferred from the other (acceptance 3).
 */
export async function listOffersHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as {
      canonicalVariantId?: string;
      canonicalProductId?: string;
      country?: string;
      kinds?: OfferKind[];
      availability?: OfferAvailability[];
      conditions?: OfferCondition[];
      includeStale?: 'true' | 'false';
      limit?: number;
      cursor?: string;
    };

    const page = await listOffers({
      ...(query.canonicalVariantId ? { canonicalVariantId: query.canonicalVariantId } : {}),
      ...(query.canonicalProductId ? { canonicalProductId: query.canonicalProductId } : {}),
      ...(query.country ? { country: query.country.toUpperCase() } : {}),
      ...(query.kinds ? { kinds: query.kinds } : {}),
      ...(query.availability ? { availability: query.availability } : {}),
      ...(query.conditions ? { conditions: query.conditions } : {}),
      includeStale: query.includeStale === 'true',
      limit: Math.min(query.limit ?? config.pagination.defaultPageSize, config.pagination.maxPageSize),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });

    sendSuccess(res, page);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list offers');
  }
}

/** GET /offers/:id — one offer with its provenance, freshness and verdict. */
export async function getOfferHandler(req: Request, res: Response): Promise<void> {
  try {
    const offer = await getOffer(routeParam(req, 'id'));
    if (!offer) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Offer not found', 404);
      return;
    }
    sendSuccess(res, offer);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to load offer');
  }
}
