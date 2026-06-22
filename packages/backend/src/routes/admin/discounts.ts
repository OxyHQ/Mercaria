import { Router } from 'express';
import { validateBody, validateObjectId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { createDiscountSchema, updateDiscountSchema } from '../../middleware/schemas.js';
import {
  listStoreDiscounts,
  createStoreDiscount,
  getStoreDiscount,
  patchStoreDiscount,
  deleteStoreDiscount,
} from '../../controllers/admin/discounts-admin.controller.js';

/**
 * Store discounts sub-router, mounted at `/admin/stores/:storeId/discounts`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router has already run
 * `authenticateToken` → `loadStore`, so `req.store`/`req.storeMembership` are set.
 * Reads are gated on `products:read`; writes on the dedicated `discounts:write`
 * permission (owner + admin hold it by default; staff do not).
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('products:read'), listStoreDiscounts);
router.post(
  '/',
  requireStorePermission('discounts:write'),
  validateBody(createDiscountSchema),
  createStoreDiscount,
);
router.get('/:id', requireStorePermission('products:read'), validateObjectId('id'), getStoreDiscount);
router.patch(
  '/:id',
  requireStorePermission('discounts:write'),
  validateObjectId('id'),
  validateBody(updateDiscountSchema),
  patchStoreDiscount,
);
router.delete(
  '/:id',
  requireStorePermission('discounts:write'),
  validateObjectId('id'),
  deleteStoreDiscount,
);

export default router;
