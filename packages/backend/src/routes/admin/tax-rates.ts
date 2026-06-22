import { Router } from 'express';
import { validateBody, validateObjectId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { createTaxRateSchema, updateTaxRateSchema } from '../../middleware/schemas.js';
import {
  listStoreTaxRates,
  createStoreTaxRate,
  patchStoreTaxRate,
  deleteStoreTaxRate,
} from '../../controllers/admin/tax-rates-admin.controller.js';

/**
 * Store tax-rates sub-router, mounted at `/admin/stores/:storeId/tax-rates`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router has already run
 * `authenticateToken` → `loadStore`, so `req.store`/`req.storeMembership` are set.
 * Reads are gated on `products:read`; writes on the dedicated `settings:write`
 * permission (owner + admin hold it by default; staff do not).
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('products:read'), listStoreTaxRates);
router.post(
  '/',
  requireStorePermission('settings:write'),
  validateBody(createTaxRateSchema),
  createStoreTaxRate,
);
router.patch(
  '/:id',
  requireStorePermission('settings:write'),
  validateObjectId('id'),
  validateBody(updateTaxRateSchema),
  patchStoreTaxRate,
);
router.delete(
  '/:id',
  requireStorePermission('settings:write'),
  validateObjectId('id'),
  deleteStoreTaxRate,
);

export default router;
