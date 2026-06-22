import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateObjectId } from '../middleware/validate.js';
import { createAddressSchema, updateAddressSchema } from '../middleware/schemas.js';
import {
  listMyAddresses,
  createMyAddress,
  updateMyAddress,
  deleteMyAddress,
} from '../controllers/addresses.controller.js';

/**
 * Addresses API — the authenticated buyer's saved shipping addresses.
 *
 * `GET /addresses` lists; `POST` creates; `PATCH|DELETE /addresses/:id` update /
 * remove. The single-default invariant is enforced in `address.service`. Metered
 * on the `'orders'` scope (buyer checkout-adjacent path).
 */
const router = Router();

router.use(authenticateToken);

router.get('/', makeRateLimiter('orders'), listMyAddresses);
router.post('/', makeRateLimiter('orders'), validateBody(createAddressSchema), createMyAddress);
router.patch(
  '/:id',
  makeRateLimiter('orders'),
  validateObjectId('id'),
  validateBody(updateAddressSchema),
  updateMyAddress,
);
router.delete('/:id', makeRateLimiter('orders'), validateObjectId('id'), deleteMyAddress);

export default router;
