import { Router } from 'express';
import { validateBody, validateObjectId } from '../../middleware/validate.js';
import { loadStore, requireStorePermission } from '../../middleware/store-authz.js';
import { createStoreSchema, updateStoreSchema } from '../../middleware/schemas.js';
import {
  createStoreHandler,
  listMyStores,
  getStoreHandler,
  updateStoreHandler,
} from '../../controllers/admin/store-admin.controller.js';
import membersRouter from './members.js';
import productsRouter from './products.js';
import ordersRouter from './orders.js';

/**
 * Store-admin router, mounted at `/admin/stores`.
 *
 * `POST /` (create — caller becomes owner) and `GET /` (caller's stores) do NOT
 * use `loadStore`. Everything under `/:storeId` runs `loadStore` first (resolve
 * + member check, attaching `req.store`/`req.storeMembership`), then per-route
 * role/permission guards. The members + products sub-routers inherit the loaded
 * store via `mergeParams`.
 */
const router = Router();

// Caller-scoped (no loadStore).
router.post('/', validateBody(createStoreSchema), createStoreHandler);
router.get('/', listMyStores);

// Store-scoped: load + authorize the store for every nested route.
router.use('/:storeId', validateObjectId('storeId'), loadStore);

router.get('/:storeId', getStoreHandler);
router.patch(
  '/:storeId',
  requireStorePermission('store:manage'),
  validateBody(updateStoreSchema),
  updateStoreHandler,
);

router.use('/:storeId/members', membersRouter);
router.use('/:storeId/products', productsRouter);
router.use('/:storeId/orders', ordersRouter);

export default router;
