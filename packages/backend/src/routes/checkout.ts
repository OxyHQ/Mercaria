import { Router } from 'express';
import { makeActorRateLimiter } from '../lib/rate-limit.js';
import { resolveCommerceActor } from '../middleware/commerce-actor.js';
import { validateBody, validateId } from '../middleware/validate.js';
import { checkoutSchema } from '../middleware/schemas.js';
import { getCheckoutPaymentStatus, postCheckout } from '../controllers/checkout.controller.js';

/**
 * Checkout API — turn the buyer's cart into orders, for an Oxy account OR a
 * guest session (#105, ADR 0003 M7).
 *
 * `POST /checkout` reserves stock, splits the cart into one order per seller and
 * returns a summary of each. An optional `Idempotency-Key` header makes a replay
 * return the original orders.
 *
 * `GET /checkout/:checkoutGroupId/payment-status` is how a buyer's client finds
 * out what actually happened after a payment sheet closes. It is a READ, and
 * that is the point: a client can never assert that a payment succeeded (#45
 * invariant 6), so its own result callback is cosmetic and this endpoint —
 * answering from state only a verified provider event can move — is the truth.
 * Metered on `'orders'` rather than `'checkout'`: it is polled while a payment
 * completes, and sharing a budget with order placement would let that polling
 * exhaust a buyer's ability to place one.
 *
 * ## `resolveCommerceActor` REPLACES `authenticateToken` here
 *
 * The same swap `routes/cart.ts` made in #104, one issue later, and for the
 * same reason: mandatory auth is exactly what made a signed-out checkout
 * impossible. The resolver still refuses a PRESENTED-but-invalid Oxy bearer
 * with a 401 (ADR 0003 D2), and it runs the D10 Origin check on every
 * cookie-authenticated write before any database work. What changed is only
 * that ABSENT credentials now resolve to an actor instead of a refusal — and
 * an `anonymous` actor owns no cart, so it is refused by the service with a
 * sentence rather than by the router with a 401.
 *
 * `routes/orders.ts` and `routes/addresses.ts` KEEP their mandatory
 * `authenticateToken`: guest order access is the separate grant-authenticated
 * portal (#108) and saved addresses stay Oxy-only — a guest's destination lives
 * on the order's own immutable snapshot and in no address book (#105 privacy
 * rule 6).
 *
 * Metered on the actor-aware scopes, so guests are bucketed per SESSION rather
 * than per IP — several guests behind one NAT must not share a checkout budget.
 */
const router = Router();

// ONE resolver for the whole surface (ADR 0003 D1: resolved once per request).
// It must precede every limiter below: `makeActorRateLimiter` keys on
// `req.commerceActor`, and without it every request would look anonymous.
router.use(resolveCommerceActor);

router.post('/', makeActorRateLimiter('checkout'), validateBody(checkoutSchema), postCheckout);

router.get(
  '/:checkoutGroupId/payment-status',
  makeActorRateLimiter('orders'),
  validateId('checkoutGroupId'),
  getCheckoutPaymentStatus,
);

export default router;
