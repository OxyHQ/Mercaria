/**
 * `/internal/pickup/*` — the operator handlers (#93 operations rules 3, 5, 6).
 *
 * READ plus ONE write, and the write is a RESTRICTION rather than a repair. See
 * `services/pickup/operator.service.ts` for why every probe reports and none
 * fixes; what is worth stating here is what this surface deliberately cannot
 * do: there is no "set this location's position", no "publish this location",
 * no "mark this collection collected" and no route that returns a collection
 * CODE. Each would be Mercaria acting as a merchant, or as a buyer, in a domain
 * where both already have their own authenticated surface.
 */

import type { Request, Response } from 'express';
import { respondWithError } from '../lib/errors/error-codes.js';
import { readPickupConsistency } from '../services/pickup/operator.service.js';
import { setOperatorRestriction } from '../services/pickup/publication.service.js';
import { listPublicationEvents } from '../db/pickup/locationPublicationRepository.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';

/** GET /internal/pickup/consistency — the four probes. */
export async function pickupConsistencyHandler(_req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await readPickupConsistency());
  } catch (err) {
    respondWithError(res, err, 'Failed to read pickup consistency');
  }
}

/**
 * GET /internal/pickup/publications/:id/events — one location's audit trail.
 *
 * Opens from a PUBLICATION id and nothing else. There is no route that opens
 * from a merchant, a buyer, an order or a coordinate: "show me everything that
 * happened near here" is not a question this surface can be asked.
 */
export async function publicationEventsHandler(req: Request, res: Response): Promise<void> {
  try {
    const events = await listPublicationEvents(routeParam(req, 'id'), 200);
    sendSuccess(res, { events });
  } catch (err) {
    respondWithError(res, err, 'Failed to read the publication trail');
  }
}

/**
 * POST /internal/pickup/publications/:id/restriction — withdraw a place, or
 * put it back.
 *
 * Distinct from the merchant's own pause on purpose: a merchant must not be
 * able to lift a Mercaria restriction by un-pausing their own shop, and the two
 * live in different columns so neither can be mistaken for the other. Every
 * call appends to the same append-only trail the read above serves.
 */
export async function setPublicationRestrictionHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { restricted: boolean; reason: string };
    const publication = await setOperatorRestriction({
      publicationId: routeParam(req, 'id'),
      restricted: body.restricted,
      reason: body.reason,
      actorOxyUserId: req.userId ?? '',
      at: new Date(),
    });
    sendSuccess(res, { publication });
  } catch (err) {
    respondWithError(res, err, 'Failed to change the location restriction');
  }
}
