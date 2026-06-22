import { Router } from 'express';
import { validateBody, validateObjectId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { createCustomerSchema, updateCustomerSchema } from '../../middleware/schemas.js';
import {
  listStoreCustomers,
  getStoreCustomer,
  getStoreCustomerOrders,
  createStoreCustomer,
  patchStoreCustomer,
} from '../../controllers/admin/customers-admin.controller.js';

/**
 * Store customers sub-router, mounted at `/admin/stores/:storeId/customers`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router has already run
 * `authenticateToken` → `loadStore`, so `req.store`/`req.storeMembership` are set.
 * Reads are gated on `customers:read`; writes on `customers:write` (owner, admin
 * and staff all hold both — staff run the POS).
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('customers:read'), listStoreCustomers);
router.post(
  '/',
  requireStorePermission('customers:write'),
  validateBody(createCustomerSchema),
  createStoreCustomer,
);
router.get('/:id', requireStorePermission('customers:read'), validateObjectId('id'), getStoreCustomer);
router.get(
  '/:id/orders',
  requireStorePermission('customers:read'),
  validateObjectId('id'),
  getStoreCustomerOrders,
);
router.patch(
  '/:id',
  requireStorePermission('customers:write'),
  validateObjectId('id'),
  validateBody(updateCustomerSchema),
  patchStoreCustomer,
);

export default router;
