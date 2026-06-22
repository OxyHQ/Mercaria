import { Router } from 'express';
import { validateObjectId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { getStoreRefund } from '../../controllers/admin/refunds-admin.controller.js';

/**
 * Store refunds sub-router, mounted at `/admin/stores/:storeId/refunds`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router has already run
 * `authenticateToken` → `loadStore`, so `req.store`/`req.storeMembership` are set.
 * The order-scoped refund routes (process + list) live on the orders sub-router
 * (`/orders/:id/refunds`); this router serves the standalone single-refund read.
 * Reads are gated on `orders:read`.
 */
const router = Router({ mergeParams: true });

router.get('/:id', requireStorePermission('orders:read'), validateObjectId('id'), getStoreRefund);

export default router;
