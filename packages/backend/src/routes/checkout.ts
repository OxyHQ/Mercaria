import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import { checkoutSchema } from '../middleware/schemas.js';
import { postCheckout } from '../controllers/checkout.controller.js';

/**
 * Checkout API — turn the authenticated buyer's cart into orders.
 *
 * `POST /checkout` reserves stock, splits the cart into one order per seller and
 * returns a summary of each. Metered on the dedicated `'checkout'` scope. An
 * optional `Idempotency-Key` header makes a replay return the original orders.
 */
const router = Router();

router.use(authenticateToken);

router.post('/', makeRateLimiter('checkout'), validateBody(checkoutSchema), postCheckout);

export default router;
