import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery, validateId } from '../middleware/validate.js';
import { orderListQuerySchema } from '../middleware/schemas.js';
import {
  listMyOrders,
  getMyOrder,
  cancelMyOrder,
  mockPayMyOrder,
} from '../controllers/orders.controller.js';

/**
 * Buyer orders API — the authenticated buyer's own orders.
 *
 * `GET /orders` lists order summaries (paginated); `GET /orders/:id` returns a
 * hydrated order; `POST /orders/:id/cancel` cancels an order; `POST
 * /orders/:id/mock-pay` is the test-only pay shortcut. Metered on `'orders'`.
 */
const router = Router();

router.use(authenticateToken);

router.get('/', makeRateLimiter('orders'), validateQuery(orderListQuerySchema), listMyOrders);
router.get('/:id', makeRateLimiter('orders'), validateId('id'), getMyOrder);
router.post('/:id/cancel', makeRateLimiter('orders'), validateId('id'), cancelMyOrder);
router.post('/:id/mock-pay', makeRateLimiter('orders'), validateId('id'), mockPayMyOrder);

export default router;
