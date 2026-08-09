import { Router } from 'express';
import { makeActorRateLimiter } from '../lib/rate-limit.js';
import { resolveCommerceActor } from '../middleware/commerce-actor.js';
import { validateBody, validateId } from '../middleware/validate.js';
import {
  addCartItemSchema,
  updateCartItemSchema,
  applyCartDiscountSchema,
} from '../middleware/schemas.js';
import {
  getMyCart,
  addCartItem,
  updateCartItem,
  deleteCartItem,
  applyCartDiscount,
  deleteCartDiscount,
  mergeGuestCartHandler,
} from '../controllers/cart.controller.js';

/**
 * Cart API — the buyer's basket, for an Oxy account OR a guest session (#104,
 * ADR 0003 M7).
 *
 * `GET /cart` returns the hydrated cart (live prices/availability/subtotal +
 * pending-discount preview). `POST /cart/items` adds/increments a variant;
 * `PATCH|DELETE /cart/items/:variantId` set quantity / remove a line.
 * `POST /cart/discount` pins a code; `DELETE /cart/discount/:code` removes it.
 * `POST /cart/merge` folds a presented guest cart into the Oxy cart.
 *
 * ## `resolveCommerceActor` REPLACES `authenticateToken` here
 *
 * Not "in addition to": mandatory auth is exactly what made a signed-out cart
 * impossible. The resolver still refuses a PRESENTED-but-invalid Oxy bearer
 * with a 401 (ADR 0003 D2 — a silently expired session must never degrade into
 * a guest and split one person across two carts), and it runs the D10 Origin
 * check on every cookie-authenticated write before any database work. What
 * changed is only that ABSENT credentials now resolve to an actor instead of a
 * refusal.
 *
 * `routes/checkout.ts`, `routes/orders.ts` and `routes/addresses.ts` keep their
 * mandatory `authenticateToken` (ADR 0003 M7): guest checkout is #105–#107,
 * guest order access is the separate grant-authenticated portal (#108), and
 * saved addresses stay Oxy-only.
 *
 * ## Idempotency, stated rather than assumed (#104 route requirement 9)
 *
 * `POST /cart/items` INCREMENTS, so a retried offline-queued add double-counts:
 * it is the one non-idempotent mutation here and is documented as such.
 * `PATCH /cart/items/:variantId` sets an ABSOLUTE quantity and creates the line
 * if the cart lacks it, so it converges however many times it arrives — that is
 * the mutation a native client should retry with. `DELETE` converges the same
 * way. `POST /cart/merge` is idempotent on `UNIQUE(cart_merges.guest_session_id)`.
 *
 * Metered on the actor-aware `'cart'` scope (`rl:cart:`), keyed per Oxy account
 * or per guest SESSION rather than per IP — several guests behind one NAT must
 * not share a bucket. The merge has its own smaller `'cart-merge'` bucket.
 */
const router = Router();

// ONE resolver for the whole surface (ADR 0003 D1: resolved once per request).
// It must precede every limiter below: `makeActorRateLimiter` keys on
// `req.commerceActor`, and without it every request would look anonymous.
router.use(resolveCommerceActor);

router.get('/', makeActorRateLimiter('cart'), getMyCart);
router.post('/items', makeActorRateLimiter('cart'), validateBody(addCartItemSchema), addCartItem);
router.patch(
  '/items/:variantId',
  makeActorRateLimiter('cart'),
  validateId('variantId'),
  validateBody(updateCartItemSchema),
  updateCartItem,
);
router.delete(
  '/items/:variantId',
  makeActorRateLimiter('cart'),
  validateId('variantId'),
  deleteCartItem,
);
router.post(
  '/discount',
  makeActorRateLimiter('cart'),
  validateBody(applyCartDiscountSchema),
  applyCartDiscount,
);
router.delete('/discount/:code', makeActorRateLimiter('cart'), deleteCartDiscount);
// No body schema: the merge takes NO input at all. The guest session it merges
// is the one the resolver verified, never one a client named — which is why
// there is nothing here to validate and nothing to forge.
router.post('/merge', makeActorRateLimiter('cart-merge', { identifiedMax: 60 }), mergeGuestCartHandler);

export default router;
