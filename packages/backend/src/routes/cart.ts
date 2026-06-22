import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateObjectId } from '../middleware/validate.js';
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
} from '../controllers/cart.controller.js';

/**
 * Cart API — the authenticated buyer's basket.
 *
 * `GET /cart` returns the hydrated cart (live prices/availability/subtotal +
 * pending-discount preview). `POST /cart/items` adds/increments a variant;
 * `PATCH|DELETE /cart/items/:variantId` set quantity / remove a line.
 * `POST /cart/discount` pins a code; `DELETE /cart/discount/:code` removes it.
 * Metered on the dedicated `'cart'` scope.
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
router.post(
  '/discount',
  makeRateLimiter('cart'),
  validateBody(applyCartDiscountSchema),
  applyCartDiscount,
);
router.delete('/discount/:code', makeRateLimiter('cart'), deleteCartDiscount);

export default router;
