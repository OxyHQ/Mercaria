import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateObjectId } from '../middleware/validate.js';
import { addCartItemSchema, updateCartItemSchema } from '../middleware/schemas.js';
import {
  getMyCart,
  addCartItem,
  updateCartItem,
  deleteCartItem,
} from '../controllers/cart.controller.js';

/**
 * Cart API — the authenticated buyer's basket.
 *
 * `GET /cart` returns the hydrated cart (live prices/availability/subtotal).
 * `POST /cart/items` adds/increments a variant; `PATCH|DELETE /cart/items/:variantId`
 * set quantity / remove a line. Metered on the dedicated `'cart'` scope.
 */
const router = Router();

router.use(authenticateToken);

router.get('/', makeRateLimiter('cart'), getMyCart);
router.post('/items', makeRateLimiter('cart'), validateBody(addCartItemSchema), addCartItem);
router.patch(
  '/items/:variantId',
  makeRateLimiter('cart'),
  validateObjectId('variantId'),
  validateBody(updateCartItemSchema),
  updateCartItem,
);
router.delete(
  '/items/:variantId',
  makeRateLimiter('cart'),
  validateObjectId('variantId'),
  deleteCartItem,
);

export default router;
