import { Router } from 'express';
import { validateBody, validateId, validateQuery } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import {
  orderListQuerySchema,
  orderStatusPatchSchema,
  createRefundSchema,
} from '../../middleware/schemas.js';
import {
  listStoreOrders,
  getStoreOrder,
  patchStoreOrderStatusHandler,
  getStoreStats,
} from '../../controllers/admin/orders-admin.controller.js';
import {
  createOrderRefund,
  listOrderRefunds,
} from '../../controllers/admin/refunds-admin.controller.js';
import {
  cancelReturn,
  closeMerchantSupportThread,
  completeCancellation,
  decideCancellation,
  decideReturn,
  instructReturn,
  listMerchantRequests,
  postMerchantSupportMessage,
  receiveReturn,
  refundReturn,
} from '../../controllers/buyer-requests.controller.js';

/**
 * Store orders sub-router, mounted at `/admin/stores/:storeId/orders`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router already ran
 * `authenticateToken` → `loadStore`. Reads require `orders:read`; the stats
 * dashboard requires `stats:read`; status patches require `orders:fulfill`;
 * processing a refund requires `refunds:write`.
 *
 * `/stats` is registered BEFORE `/:id` so the literal path is not captured by
 * the `:id` param route.
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('orders:read'), validateQuery(orderListQuerySchema), listStoreOrders);
router.get('/stats', requireStorePermission('stats:read'), getStoreStats);
router.get('/:id', requireStorePermission('orders:read'), validateId('id'), getStoreOrder);
router.patch(
  '/:id/status',
  requireStorePermission('orders:fulfill'),
  validateId('id'),
  validateBody(orderStatusPatchSchema),
  patchStoreOrderStatusHandler,
);
router.post(
  '/:id/refunds',
  requireStorePermission('refunds:write'),
  validateId('id'),
  validateBody(createRefundSchema),
  createOrderRefund,
);
router.get(
  '/:id/refunds',
  requireStorePermission('orders:read'),
  validateId('id'),
  listOrderRefunds,
);

/**
 * #110's merchant surface for buyer requests.
 *
 * The permissions REUSE what already exists rather than adding narrower ones —
 * "reuse current refund permissions and add narrower request permissions only
 * where needed", and none was needed. The split is by what the action does, not
 * by what it is called:
 *
 *  - `orders:read` reads the queue and answers a support thread. A staff member
 *    who can already see the order can already see the question about it, and
 *    replying to a buyer is not a money power.
 *  - `orders:fulfill` decides and completes a CANCELLATION, issues return
 *    instructions and marks a return received. These move goods and order
 *    state, which is exactly what that permission already gates.
 *  - `refunds:write` decides a RETURN and commits its refund. Approving a
 *    return is a commitment to give money back, so it sits with the permission
 *    that already means that — which is also why `admin` and `owner` hold it
 *    and `staff` does not.
 */
router.get(
  '/:id/buyer-requests',
  requireStorePermission('orders:read'),
  validateId('id'),
  listMerchantRequests,
);
router.post(
  '/:id/cancellation-requests/:requestId/decision',
  requireStorePermission('orders:fulfill'),
  validateId('id'),
  decideCancellation,
);
router.post(
  '/:id/cancellation-requests/:requestId/complete',
  requireStorePermission('orders:fulfill'),
  validateId('id'),
  completeCancellation,
);
router.post(
  '/:id/return-requests/:requestId/decision',
  requireStorePermission('refunds:write'),
  validateId('id'),
  decideReturn,
);
router.post(
  '/:id/return-requests/:requestId/instructions',
  requireStorePermission('orders:fulfill'),
  validateId('id'),
  instructReturn,
);
router.post(
  '/:id/return-requests/:requestId/received',
  requireStorePermission('orders:fulfill'),
  validateId('id'),
  receiveReturn,
);
router.post(
  '/:id/return-requests/:requestId/refund',
  requireStorePermission('refunds:write'),
  validateId('id'),
  refundReturn,
);
router.post(
  '/:id/return-requests/:requestId/cancel',
  requireStorePermission('refunds:write'),
  validateId('id'),
  cancelReturn,
);
router.post(
  '/:id/support',
  requireStorePermission('orders:read'),
  validateId('id'),
  postMerchantSupportMessage,
);
router.post(
  '/:id/support/close',
  requireStorePermission('orders:read'),
  validateId('id'),
  closeMerchantSupportThread,
);

export default router;
