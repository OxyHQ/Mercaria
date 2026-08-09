/**
 * Offer operator controller (#57) — trace, converge, retire.
 *
 * THREE actions and no more. Each drives a path that already exists and is
 * already idempotent, so this surface adds a trigger and no new way for an offer
 * to come into being: an operator can ask the converger to run now, can retire
 * an offer with a recorded reason, and can read what is outstanding. There is no
 * "create offer" and no "edit price" — an offer states what a source or a
 * listing said, and an operator overwriting it would make the row stop meaning
 * that.
 */

import type { Request, Response } from 'express';
import type { OfferRetirementReason } from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import {
  findOfferOutboxForListing,
  summarizeOfferOutbox,
} from '../db/offers/offerOutboxRepository.js';
import { findOfferWithChannel, retireOffers } from '../db/offers/offerRepository.js';
import { convergeNativeOffersForListing } from '../services/offers/native-offer.service.js';
import { getOffer } from '../services/offers/offer.service.js';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import { log } from '../lib/logger.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/**
 * GET /internal/offers/:id — one offer, its channel operator and its verdict.
 *
 * The same projection the public read serves, deliberately: an operator
 * investigating "why is this not buyable" must see the answer a shopper sees,
 * and a richer internal view would let the two disagree about the thing being
 * investigated.
 */
export async function traceOfferHandler(req: Request, res: Response): Promise<void> {
  try {
    const offer = await getOffer(routeParam(req, 'id'));
    if (!offer) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Offer not found', 404);
      return;
    }
    const outbox = offer.listingId
      ? await findOfferOutboxForListing(offer.listingId)
      : undefined;
    sendSuccess(res, {
      offer,
      convergence: outbox
        ? {
            status: outbox.status,
            attempts: outbox.attempts,
            requestedRevision: outbox.requestedRevision,
            claimedRevision: outbox.claimedRevision,
            availableAt: outbox.availableAt.toISOString(),
            ...(outbox.processedAt ? { processedAt: outbox.processedAt.toISOString() } : {}),
            ...(outbox.lastError ? { lastError: outbox.lastError } : {}),
          }
        : null,
    });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to trace offer');
  }
}

/** GET /internal/offers/convergence — how much projection work is outstanding. */
export async function offerConvergenceSummaryHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await summarizeOfferOutbox());
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to summarize offer convergence');
  }
}

/**
 * POST /internal/offers/listings/:listingId/converge — run one job now.
 *
 * Drives the SAME function the dispatcher runs, synchronously, which is why it
 * needs no new safety: convergence is a fixed point, so an operator running it
 * beside a dispatcher that is also running it produces one answer twice.
 */
export async function convergeListingOffersHandler(req: Request, res: Response): Promise<void> {
  try {
    const listingId = routeParam(req, 'listingId');
    const result = await convergeNativeOffersForListing(listingId);
    log.general.info(
      { ...result, operator: catalogOperatorId(req) },
      '[Offers] operator ran a convergence',
    );
    sendSuccess(res, result);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to converge listing offers');
  }
}

/**
 * POST /internal/offers/:id/retire — withdraw one offer from current results.
 *
 * An UPDATE, so the row and its provenance survive (issue acceptance 5). A
 * NATIVE offer is refused: its existence is a function of its listing, so
 * retiring one by hand would be undone by the next convergence and would leave
 * an operator believing they had acted. The listing is where that decision
 * belongs, and moderation is how it is made.
 */
export async function retireOfferHandler(req: Request, res: Response): Promise<void> {
  try {
    const id = routeParam(req, 'id');
    const body = req.body as { reason: OfferRetirementReason; note: string };

    const db = getDb();
    const existing = await findOfferWithChannel(db, id);
    if (!existing) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Offer not found', 404);
      return;
    }
    if (existing.offer.kind === 'native') {
      sendError(
        res,
        ErrorCodes.CONFLICT,
        'A native offer follows its listing. Change the listing, or use moderation enforcement.',
        409,
      );
      return;
    }

    const retired = await retireOffers(db, [id], body.reason);
    if (retired === 0) {
      sendError(res, ErrorCodes.CONFLICT, 'The offer was already retired', 409);
      return;
    }
    log.general.info(
      { offerId: id, reason: body.reason, note: body.note, operator: catalogOperatorId(req) },
      '[Offers] operator retired an offer',
    );
    sendSuccess(res, { id, status: 'retired', reason: body.reason });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to retire offer');
  }
}
