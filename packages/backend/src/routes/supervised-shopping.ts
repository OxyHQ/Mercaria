import { Router } from 'express';
import { oxyClient } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateId } from '../middleware/validate.js';
import { addCartItemSchema, updateCartItemSchema, checkoutSchema } from '../middleware/schemas.js';
import { listMyAddresses } from '../controllers/addresses.controller.js';
import {
  addSupervisedCartItem,
  browseSupervisedShopping,
  getSupervisedCart,
  prepareSupervisedCheckout,
  readSupervisedCheckout,
  removeSupervisedCartItem,
  resumeSupervisedCheckout,
  updateSupervisedCartItem,
} from '../controllers/supervised-shopping.controller.js';

const router = Router();
const contentAuth = oxyClient.middleware.auth({ supervisedAction: 'content' });
const purchaseAuth = oxyClient.middleware.auth({ supervisedAction: 'purchases' });
const rateLimit = makeRateLimiter('orders');

router.get('/catalog', contentAuth, rateLimit, browseSupervisedShopping);
router.get('/cart', contentAuth, rateLimit, getSupervisedCart);
router.post(
  '/cart/items',
  contentAuth,
  rateLimit,
  validateBody(addCartItemSchema),
  addSupervisedCartItem,
);
router.patch(
  '/cart/items/:variantId',
  contentAuth,
  rateLimit,
  validateId('variantId'),
  validateBody(updateCartItemSchema),
  updateSupervisedCartItem,
);
router.delete(
  '/cart/items/:variantId',
  contentAuth,
  rateLimit,
  validateId('variantId'),
  removeSupervisedCartItem,
);
router.get('/addresses', purchaseAuth, rateLimit, listMyAddresses);
router.post(
  '/checkout',
  purchaseAuth,
  rateLimit,
  validateBody(checkoutSchema),
  prepareSupervisedCheckout,
);
router.get(
  '/checkout/:checkoutGroupId',
  purchaseAuth,
  rateLimit,
  validateId('checkoutGroupId'),
  readSupervisedCheckout,
);
router.post(
  '/checkout/:checkoutGroupId/resume',
  purchaseAuth,
  rateLimit,
  validateId('checkoutGroupId'),
  resumeSupervisedCheckout,
);

export default router;
