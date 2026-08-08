import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateId } from '../middleware/validate.js';
import { checkoutSchema } from '../middleware/schemas.js';
import { getCheckoutPaymentStatus, postCheckout } from '../controllers/checkout.controller.js';

/**
 * Checkout API — turn the authenticated buyer's cart into orders.
 *
 * `POST /checkout` reserves stock, splits the cart into one order per seller and
 * returns a summary of each. Metered on the dedicated `'checkout'` scope. An
 * optional `Idempotency-Key` header makes a replay return the original orders.
 *
 * `GET /checkout/:checkoutGroupId/payment-status` is how a buyer's client finds
 * out what actually happened after a payment sheet closes. It is a READ, and
 * that is the point: a client can never assert that a payment succeeded (#45
 * invariant 6), so its own result callback is cosmetic and this endpoint —
 * answering from state only a verified provider event can move — is the truth.
 * Metered on `'orders'` rather than `'checkout'`: it is polled while a payment
 * completes, and sharing a budget with order placement would let that polling
 * exhaust a buyer's ability to place one.
 */
const router = Router();

router.use(authenticateToken);

router.post('/', makeRateLimiter('checkout'), validateBody(checkoutSchema), postCheckout);

router.get(
  '/:checkoutGroupId/payment-status',
  makeRateLimiter('orders'),
  validateId('checkoutGroupId'),
  getCheckoutPaymentStatus,
);

export default router;
