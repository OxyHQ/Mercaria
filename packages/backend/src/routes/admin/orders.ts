import { Router } from 'express';
import { validateBody, validateObjectId, validateQuery } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { orderListQuerySchema, orderStatusPatchSchema } from '../../middleware/schemas.js';
import {
  listStoreOrders,
  getStoreOrder,
  patchStoreOrderStatusHandler,
  getStoreStats,
} from '../../controllers/admin/orders-admin.controller.js';

/**
 * Store orders sub-router, mounted at `/admin/stores/:storeId/orders`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router already ran
 * `authenticateToken` → `loadStore`. Reads require `orders:read`; the stats
 * dashboard requires `stats:read`; status patches require `orders:fulfill`.
 *
 * `/stats` is registered BEFORE `/:id` so the literal path is not captured by
 * the `:id` param route.
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('orders:read'), validateQuery(orderListQuerySchema), listStoreOrders);
router.get('/stats', requireStorePermission('stats:read'), getStoreStats);
router.get('/:id', requireStorePermission('orders:read'), validateObjectId('id'), getStoreOrder);
router.patch(
  '/:id/status',
  requireStorePermission('orders:fulfill'),
  validateObjectId('id'),
  validateBody(orderStatusPatchSchema),
  patchStoreOrderStatusHandler,
);

export default router;
