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
import buyerRequestRouter from './buyer-requests.js';

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

/**
 * #110's buyer-request surface, for an authenticated buyer.
 *
 * Mounted AFTER the literal routes above so `/orders/:id/cancel` is still
 * matched by its own handler rather than falling into this sub-router — and
 * `POST /orders/:id/cancel` deliberately stays: it is the direct cancel a buyer
 * with an ACCOUNT has always had for their own unpaid order, and #110 adds the
 * REQUEST flow beside it rather than replacing it. The two differ in who
 * decides: `cancel` is the buyer acting on an order nobody has begun to fulfil,
 * a cancellation REQUEST is the buyer asking a seller.
 *
 * The same router serves the guest portal — see `routes/buyer-requests.ts`.
 */
router.use('/:id', validateId('id'), buyerRequestRouter);

export default router;
