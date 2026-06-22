import { Router } from 'express';
import { validateBody, validateObjectId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import {
  createDraftOrderSchema,
  addDraftLineSchema,
  updateDraftLineSchema,
  applyDraftDiscountsSchema,
  setDraftCustomerSchema,
  updateDraftOrderSchema,
  completeDraftOrderSchema,
} from '../../middleware/schemas.js';
import {
  listStoreDraftOrders,
  createStoreDraftOrder,
  getStoreDraftOrder,
  patchStoreDraftOrder,
  addStoreDraftLine,
  updateStoreDraftLine,
  removeStoreDraftLine,
  applyStoreDraftDiscounts,
  setStoreDraftCustomer,
  cancelStoreDraftOrder,
  completeStoreDraftOrder,
} from '../../controllers/admin/draft-orders-admin.controller.js';

/**
 * Store draft orders (POS) sub-router, mounted at
 * `/admin/stores/:storeId/draft-orders`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router has already run
 * `authenticateToken` → `loadStore`, so `req.store`/`req.storeMembership` are set.
 * Every route is gated on the dedicated `draft_orders:write` permission (owner,
 * admin and staff hold it — staff run the POS). `PATCH /:id` updates the draft's
 * note/shipping address; line/discount/customer ops + cancel/complete are explicit
 * sub-routes.
 */
const router = Router({ mergeParams: true });

const requireWrite = requireStorePermission('draft_orders:write');

router.get('/', requireWrite, listStoreDraftOrders);
router.post('/', requireWrite, validateBody(createDraftOrderSchema), createStoreDraftOrder);

router.get('/:id', requireWrite, validateObjectId('id'), getStoreDraftOrder);
router.patch(
  '/:id',
  requireWrite,
  validateObjectId('id'),
  validateBody(updateDraftOrderSchema),
  patchStoreDraftOrder,
);
router.delete('/:id', requireWrite, validateObjectId('id'), cancelStoreDraftOrder);

router.post(
  '/:id/lines',
  requireWrite,
  validateObjectId('id'),
  validateBody(addDraftLineSchema),
  addStoreDraftLine,
);
router.patch(
  '/:id/lines/:variantId',
  requireWrite,
  validateObjectId('id'),
  validateObjectId('variantId'),
  validateBody(updateDraftLineSchema),
  updateStoreDraftLine,
);
router.delete(
  '/:id/lines/:variantId',
  requireWrite,
  validateObjectId('id'),
  validateObjectId('variantId'),
  removeStoreDraftLine,
);

router.post(
  '/:id/discounts',
  requireWrite,
  validateObjectId('id'),
  validateBody(applyDraftDiscountsSchema),
  applyStoreDraftDiscounts,
);
router.post(
  '/:id/customer',
  requireWrite,
  validateObjectId('id'),
  validateBody(setDraftCustomerSchema),
  setStoreDraftCustomer,
);
router.post(
  '/:id/complete',
  requireWrite,
  validateObjectId('id'),
  validateBody(completeDraftOrderSchema),
  completeStoreDraftOrder,
);

export default router;
