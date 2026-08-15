/**
 * The buyer's own view of a collection: the snapshot, and the code.
 *
 * ONE handler serves both actor kinds (#93 verification rule 9, "guest and
 * authenticated buyers use the same collection mechanism"), and the fork is the
 * SUBJECT it is handed — an Oxy account or a portal grant — which is #106's
 * `OrderAccessSubject` union used exactly as it was built to be used. There is
 * nothing guest-shaped below the resolution, and a second handler would have
 * been a second place the authorization could be got wrong.
 *
 * ## Why the code is fetched from its own route rather than embedded in the order
 *
 * Two reasons and both are about where it ends up. An order DTO is logged,
 * cached by clients and forwarded into support tools; a code carried inside one
 * would follow it into all three. And #93 client rule 13 asks that a code be
 * shown "only inside an authorized order surface" — which is exactly the shape
 * of a separate request the client makes when it is about to render it, rather
 * than a field that arrives whether anybody looks at it or not.
 *
 * It never appears in a URL, a log line, an analytics row or a message subject.
 */

import type { Request, Response } from 'express';
import { forbidden, notFound, respondWithError } from '../lib/errors/error-codes.js';
import { findOrderById } from '../db/orders/orderRepository.js';
import {
  authorizeOrderAccess,
  orderAccessFactsFromRecord,
  orderAccessSubjectForCommerceActor,
  resolveGuestPortalSubject,
  type OrderAccessSubject,
} from '../services/orders/order-access.service.js';
import { toOrderPortalGrant } from '../services/guest-portal/portal.service.js';
import { findOrderPickup } from '../db/pickup/orderPickupRepository.js';
import {
  projectOrderPickup,
  readCollectionCode,
} from '../services/pickup/collection.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';

/**
 * The subject this request carries, or `null`.
 *
 * A PORTAL grant is preferred over an Oxy actor when both are present, because
 * the guest-portal mount is the only place a grant appears and reaching it
 * means the caller asked as the portal. On the authenticated mount there is no
 * grant and the actor is the only source — so neither route can be answered
 * with the other's authority.
 */
function subjectFor(req: Request): OrderAccessSubject | null {
  return (
    resolveGuestPortalSubject(
      req.portalGrant === undefined ? null : toOrderPortalGrant(req.portalGrant),
    ) ??
    (req.userId === undefined
      ? orderAccessSubjectForCommerceActor(req.commerceActor ?? { kind: 'anonymous' })
      : { kind: 'oxy_account', oxyUserId: req.userId })
  );
}

/**
 * `GET /orders/:id/collection` and
 * `GET /guest/orders/:groupId/orders/:id/collection`.
 *
 * Answers the collection snapshot AND the code together, because a client about
 * to render the code needs the address and the instructions on the same screen
 * — and because splitting them would mean two authorizations of one question.
 *
 * `code` is ABSENT rather than null-ish for an order whose location asks for
 * none, for a cancelled collection and for a deployment with no key: the client
 * renders nothing at all in each case, which is right for all three, and a
 * present-but-empty field is the shape that gets rendered as a blank box.
 */
export async function getCollectionHandler(req: Request, res: Response): Promise<void> {
  const orderId = routeParam(req, 'id');
  try {
    const subject = subjectFor(req);
    if (subject === null) throw forbidden('Sign in to see this order.');

    const order = await findOrderById(orderId);
    if (!order) throw notFound('Order not found');

    const decision = authorizeOrderAccess(subject, orderAccessFactsFromRecord(order), new Date());
    // A refusal is a 404 and never a 403: "this order exists and is not yours"
    // is a fact about somebody else's purchase, and the guest portal's own
    // reads answer the same way for the same reason.
    if (!decision.allowed) throw notFound('Order not found');

    const pickup = await findOrderPickup(orderId);
    if (!pickup) throw notFound('This order is not a collection.');

    const code = await readCollectionCode(orderId, new Date());
    // A code must not survive in a shared cache or on a shared device.
    res.setHeader('Cache-Control', 'private, no-store');
    sendSuccess(res, {
      pickup: projectOrderPickup(pickup),
      ...(code === null ? {} : { code }),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to load the collection');
  }
}
