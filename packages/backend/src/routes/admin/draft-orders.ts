import { Router } from 'express';
import { validateBody, validateId } from '../../middleware/validate.js';
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

router.get('/:id', requireWrite, validateId('id'), getStoreDraftOrder);
router.patch(
  '/:id',
  requireWrite,
  validateId('id'),
  validateBody(updateDraftOrderSchema),
  patchStoreDraftOrder,
);
router.delete('/:id', requireWrite, validateId('id'), cancelStoreDraftOrder);

router.post(
  '/:id/lines',
  requireWrite,
  validateId('id'),
  validateBody(addDraftLineSchema),
  addStoreDraftLine,
);
router.patch(
  '/:id/lines/:variantId',
  requireWrite,
  validateId('id'),
  validateId('variantId'),
  validateBody(updateDraftLineSchema),
  updateStoreDraftLine,
);
router.delete(
  '/:id/lines/:variantId',
  requireWrite,
  validateId('id'),
  validateId('variantId'),
  removeStoreDraftLine,
);

router.post(
  '/:id/discounts',
  requireWrite,
  validateId('id'),
  validateBody(applyDraftDiscountsSchema),
  applyStoreDraftDiscounts,
);
router.post(
  '/:id/customer',
  requireWrite,
  validateId('id'),
  validateBody(setDraftCustomerSchema),
  setStoreDraftCustomer,
);
router.post(
  '/:id/complete',
  requireWrite,
  validateId('id'),
  validateBody(completeDraftOrderSchema),
  completeStoreDraftOrder,
);

export default router;
