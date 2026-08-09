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
// Discovery analytics (#77) — the emitter and nothing else. This surface is on
// `analytics-ranking-isolation.test.ts`'s scanned list, so an import of a
// rollup, an aggregate or a metric here fails the build: an offer comparison
// that could read measured popularity is one join away from ranking by it.
import { emitAnalyticsEvent } from '../services/analytics/emit.js';

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

    // One `offer_impression` per SERVED offer, not one per request: the
    // external click-through denominator counts offers a shopper could have
    // clicked, and a per-request event would make CTR depend on page size.
    // Emitted from the server rather than the client because a comparison list
    // is rendered whole — there is no viewport question to answer, unlike a
    // long results page where only the client knows what was seen.
    for (const offer of page.offers) {
      emitAnalyticsEvent(req, {
        eventType: 'offer_impression',
        entities: {
          offerId: offer.id,
          canonicalVariantId: offer.canonicalVariantId,
          ...(offer.merchantId === undefined ? {} : { merchantId: offer.merchantId }),
          ...(offer.storefrontId === undefined ? {} : { storefrontId: offer.storefrontId }),
        },
      });
    }

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
    // `offer_expanded` — the single-offer read IS the expansion, and it is
    // emitted after the 404 guard so a miss is not counted as an expansion.
    emitAnalyticsEvent(req, {
      eventType: 'offer_expanded',
      entities: {
        offerId: offer.id,
        canonicalVariantId: offer.canonicalVariantId,
        ...(offer.merchantId === undefined ? {} : { merchantId: offer.merchantId }),
        ...(offer.storefrontId === undefined ? {} : { storefrontId: offer.storefrontId }),
      },
    });
    sendSuccess(res, offer);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to load offer');
  }
}
