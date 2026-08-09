/**
 * Checkout controller (THIN) — place orders from the buyer's cart.
 *
 * Logic lives in `checkout.service`. The optional `Idempotency-Key` request
 * header makes a replayed checkout converge on the original orders instead of
 * creating duplicates.
 *
 * Since #105 the caller is a `CommerceActor` rather than an Oxy id: the
 * resolver on `routes/checkout.ts` has already produced exactly one actor, and
 * this file passes it through without deciding anything about it. The
 * translation from an actor to what a query may be scoped by lives in the
 * services (`cartOwnerForActor`, `CheckoutGroupOwner`), never in a controller —
 * a second translation is a second place for a guest id to end up wearing an
 * Oxy id's shape.
 */

import type { Request, Response } from 'express';
import type { CheckoutInput } from '@mercaria/shared-types';
import { sendSuccess } from '../utils/api-response.js';
import { forbidden, respondWithError } from '../lib/errors/error-codes.js';
import { checkout } from '../services/checkout.service.js';
import { cartOwnerForActor } from '../services/cart-owner.js';
import type { CommerceActor } from '../services/commerce-actor.js';
import { readCheckoutPaymentStatus } from '../services/payments/checkout-payment.service.js';
import { log } from '../lib/logger.js';

/**
 * The actor the resolver left on the request.
 *
 * `resolveCommerceActor` runs before every handler in this router and always
 * assigns one, so the fallback is unreachable in practice. It is `anonymous`
 * rather than a throw because that is the honest value for "no credential
 * resolved" and the services already refuse it with a message a buyer can act
 * on — a 500 here would turn a missing mount into an incident instead of a 409.
 */
function actorOf(req: Request): CommerceActor {
  return req.commerceActor ?? { kind: 'anonymous' };
}

/** POST /checkout — create orders from the caller's cart. */
export async function postCheckout(req: Request, res: Response): Promise<void> {
  try {
    const raw = req.headers['idempotency-key'];
    const idempotencyKey = (Array.isArray(raw) ? raw[0] : raw) || undefined;
    const result = await checkout(actorOf(req), req.body as CheckoutInput, idempotencyKey);
    sendSuccess(res, result, 201);
  } catch (err) {
    // The error is logged WITHOUT the body: `req.body` carries the buyer's
    // typed address and contact, and a log line is exactly where #105's privacy
    // rule 8 says they must not appear. The services' own refusals name fields
    // and seller keys, never values.
    log.general.error({ err }, 'Checkout failed');
    respondWithError(res, err, 'Checkout failed');
  }
}

/**
 * GET /checkout/:checkoutGroupId/payment-status — what actually happened.
 *
 * The buyer's client asks this after its payment sheet closes, instead of
 * reporting the outcome itself. Scoped to the caller's own orders by the
 * service; a group that is not theirs is a 404, not a 403, because the existence
 * of somebody else's checkout is not a fact this endpoint may confirm.
 */
export async function getCheckoutPaymentStatus(req: Request, res: Response): Promise<void> {
  try {
    const owner = cartOwnerForActor(actorOf(req));
    if (!owner) {
      throw forbidden('Sign in to see this checkout.');
    }
    const raw = req.params.checkoutGroupId;
    const checkoutGroupId = Array.isArray(raw) ? raw[0] : raw;
    const result = await readCheckoutPaymentStatus(
      owner.kind === 'oxy_user'
        ? { kind: 'oxy_user', oxyUserId: owner.oxyUserId }
        : { kind: 'guest_session', guestSessionId: owner.guestSessionId },
      checkoutGroupId,
    );
    sendSuccess(res, result);
  } catch (err) {
    log.general.error({ err }, 'Reading checkout payment status failed');
    respondWithError(res, err, 'Could not read the payment status');
  }
}
