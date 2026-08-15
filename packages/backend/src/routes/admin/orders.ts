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
import {
  cancelPickupHandler,
  collectPickupHandler,
  getOrderPickupHandler,
  markPickupReadyHandler,
  rotateCollectionCodeHandler,
} from '../../controllers/admin/pickup-admin.controller.js';
import {
  cancelPickupSchema,
  collectPickupSchema,
  markPickupReadySchema,
  rotateCollectionCodeSchema,
} from '../../middleware/pickup-schemas.js';

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

/**
 * The COLLECTION desk (#93).
 *
 * `orders:fulfill` throughout: marking a parcel ready and handing it over IS
 * fulfilling, and #93 operations rule 4 asks for the existing permissions
 * rather than a new one. Reading the collection needs only `orders:read`,
 * because a shop assistant looking up where a parcel is should not need the
 * authority to hand it over.
 *
 * There is deliberately no route that returns the CURRENT code to a merchant.
 * A code is the buyer's; a desk verifies one by having it presented. Rotation
 * returns the NEW code because the shop is the party that has to tell the
 * customer it changed.
 */
router.get('/:id/pickup', requireStorePermission('orders:read'), validateId('id'), getOrderPickupHandler);
router.post(
  '/:id/pickup/ready',
  requireStorePermission('orders:fulfill'),
  validateId('id'),
  validateBody(markPickupReadySchema),
  markPickupReadyHandler,
);
router.post(
  '/:id/pickup/collect',
  requireStorePermission('orders:fulfill'),
  validateId('id'),
  validateBody(collectPickupSchema),
  collectPickupHandler,
);
router.post(
  '/:id/pickup/cancel',
  requireStorePermission('orders:fulfill'),
  validateId('id'),
  validateBody(cancelPickupSchema),
  cancelPickupHandler,
);
router.post(
  '/:id/pickup/rotate-code',
  requireStorePermission('orders:fulfill'),
  validateId('id'),
  validateBody(rotateCollectionCodeSchema),
  rotateCollectionCodeHandler,
);
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
