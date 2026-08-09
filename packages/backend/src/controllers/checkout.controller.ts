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
import type { AnalyticsReasonCode, CheckoutInput } from '@mercaria/shared-types';
import { sendSuccess } from '../utils/api-response.js';
import { forbidden, respondWithError } from '../lib/errors/error-codes.js';
import { checkout } from '../services/checkout.service.js';
import { cartOwnerForActor } from '../services/cart-owner.js';
import {
  isCheckoutRefusal,
  type CheckoutRefusalReason,
} from '../services/checkout/refusal.js';
import type { CommerceActor } from '../services/commerce-actor.js';
import { readCheckoutPaymentStatus } from '../services/payments/checkout-payment.service.js';
import { log } from '../lib/logger.js';
// Discovery analytics (#77) — the emitter only. `checkout.service` itself
// imports NOTHING from this domain, for the reason it imports no Stripe module:
// telemetry must not become structural to placing an order.
import { emitAnalyticsEvent } from '../services/analytics/emit.js';

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

/**
 * The ONE mapping from a checkout refusal to its analytics reason code (#106,
 * closing #77's `#106` seam).
 *
 * A `Record` over the closed `CheckoutRefusalReason` union, so adding a reason
 * in `services/checkout/refusal.ts` fails `tsc` HERE until somebody decides how
 * it is measured — which is the property #77 asked for: a refusal is classified
 * by a code the compiler tracks, never by matching the message text a gate
 * happens to carry today.
 *
 * The two vocabularies are separate on purpose (see `refusal.ts`), and every
 * member below is already in `ANALYTICS_REASON_CODES` — #77 put them there in
 * anticipation, which is why closing this seam needed no analytics migration.
 */
const REFUSAL_REASON_TO_ANALYTICS: Record<CheckoutRefusalReason, AnalyticsReasonCode> = {
  p2p_seller_excluded: 'p2p_seller_excluded',
  market_not_supported: 'market_not_supported',
  destination_unsupported: 'destination_unsupported',
  destination_incomplete: 'destination_incomplete',
  seller_not_payment_ready: 'seller_not_payment_ready',
};

/**
 * Which refusals are a DESTINATION verdict rather than a seller-eligibility
 * one.
 *
 * #77 asks for the two halves separately, and they are genuinely different
 * questions: "can we deliver there at all" is about the address, "may this
 * buyer buy from this seller" is about the parties. A refusal on the first also
 * ends the checkout, so both events are emitted for it — the destination one
 * says WHERE it failed and the eligibility one keeps
 * `guest_eligibility_coverage`'s denominator equal to the number of guest
 * checkouts attempted, which is what makes the metric a coverage rate rather
 * than a ratio of two differently-scoped counts.
 */
const DESTINATION_REFUSALS: ReadonlySet<CheckoutRefusalReason> = new Set([
  'market_not_supported',
  'destination_unsupported',
  'destination_incomplete',
]);

/**
 * Emit the guest contact/destination/eligibility outcome for one checkout.
 *
 * Emitted ONLY for a guest actor: the six event types are the guest-commerce
 * funnel's, and an authenticated checkout's own gates are already covered by
 * `checkout_started` plus the buyer-origin dimension. Every event carries the
 * OUTCOME and nothing else — no email, no phone, no address line, no seller
 * key. `guest_checkouts` holds the contact and this domain has no column for
 * any of it.
 */
function emitGuestCheckoutGates(
  req: Request,
  actor: CommerceActor,
  checkoutGroupId: string | undefined,
  refusal: CheckoutRefusalReason | undefined,
): void {
  if (actor.kind !== 'guest') return;

  const reasonCode = refusal === undefined ? undefined : REFUSAL_REASON_TO_ANALYTICS[refusal];
  const correlation = checkoutGroupId === undefined ? {} : { checkoutGroupId };

  // The CONTACT was accepted whenever the request got past validation, which is
  // exactly when a refusal is either absent or one of the later gates: contact
  // validation is the first thing `resolveCheckoutContract` does, so a
  // malformed contact never reaches a refusal reason at all (it raises a plain
  // 400 from `contact.ts`, which is a client error and not a gate outcome).
  emitAnalyticsEvent(req, {
    eventType: 'guest_contact_validated',
    ...correlation,
    buyerOrigin: 'guest',
  });

  if (refusal !== undefined && DESTINATION_REFUSALS.has(refusal)) {
    emitAnalyticsEvent(req, {
      eventType: 'guest_destination_validation_failed',
      ...correlation,
      ...(reasonCode === undefined ? {} : { reasonCode }),
      buyerOrigin: 'guest',
    });
  } else {
    emitAnalyticsEvent(req, {
      eventType: 'guest_destination_validated',
      ...correlation,
      buyerOrigin: 'guest',
    });
  }

  emitAnalyticsEvent(req, {
    eventType: refusal === undefined ? 'guest_eligibility_accepted' : 'guest_eligibility_rejected',
    ...correlation,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    buyerOrigin: 'guest',
  });
}

/** POST /checkout — create orders from the caller's cart. */
export async function postCheckout(req: Request, res: Response): Promise<void> {
  const actorForGates = actorOf(req);
  try {
    const raw = req.headers['idempotency-key'];
    const idempotencyKey = (Array.isArray(raw) ? raw[0] : raw) || undefined;
    const actor = actorOf(req);
    const result = await checkout(actor, req.body as CheckoutInput, idempotencyKey);
    // TWO events for a guest, one for an authenticated buyer. `checkout_started`
    // is the discovery funnel's step and is emitted for EVERY actor kind — the
    // buyer-origin dimension is what tells the two funnels apart, which is what
    // "the same definitions" means mechanically. `guest_checkout_started` is the
    // guest-commerce funnel's own step, which #77 asks for by name.
    //
    // Both carry the RESTRICTED checkout-group correlation (envelope field 5):
    // these are event types `ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES` admits,
    // because checkout has begun. Emitted AFTER the service returns, so a
    // refused checkout (empty cart, stale line, seller not payment-ready,
    // undeliverable destination) is not counted as a start — this event is the
    // denominator of the conversion metrics, and inflating it with refusals
    // would understate conversion in exactly the condition somebody is
    // investigating.
    //
    // The NUMERATOR of those metrics never comes from here. It is read from
    // `payments` through `services/analytics/verified-conversion.ts`, which is
    // acceptance 9 and the reason no `order_paid` event type exists at all.
    const buyerOrigin = actor.kind === 'guest' ? 'guest' : 'authenticated';
    emitAnalyticsEvent(req, {
      eventType: 'checkout_started',
      checkoutGroupId: result.checkoutGroupId,
      measures: { itemCount: result.orders.length },
      buyerOrigin,
    });
    if (actor.kind === 'guest') {
      emitAnalyticsEvent(req, {
        eventType: 'guest_checkout_started',
        checkoutGroupId: result.checkoutGroupId,
        measures: { itemCount: result.orders.length },
        buyerOrigin: 'guest',
      });
    }
    // Every gate passed, since the service returned. #106 closed #77's seam:
    // both halves of `guest_eligibility_coverage` are emitted now, so the
    // metric measures rather than reading a confident permanent 100%.
    emitGuestCheckoutGates(req, actor, result.checkoutGroupId, undefined);
    sendSuccess(res, result, 201);
  } catch (err) {
    // ONLY a classified refusal is measured. An empty cart, a stale line or a
    // database failure is not a gate outcome, and emitting the ACCEPTED shape
    // for one would be exactly the fabricated event #77's seam file exists to
    // refuse — there is no `other` bucket, by design.
    //
    // No checkout group id: every gate fires BEFORE reservation, so no group
    // exists yet. Emitting without one is what makes these a rate over
    // ATTEMPTS rather than over completed checkouts.
    if (isCheckoutRefusal(err)) {
      emitGuestCheckoutGates(req, actorForGates, undefined, err.reason);
    }
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
