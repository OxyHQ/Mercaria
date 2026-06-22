import { Router } from 'express';
import { validateBody, validateObjectId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import {
  createCollectionSchema,
  updateCollectionSchema,
  setCollectionProductsSchema,
} from '../../middleware/schemas.js';
import {
  listStoreCollections,
  createStoreCollection,
  getStoreCollection,
  patchStoreCollection,
  deleteStoreCollection,
  setStoreCollectionProducts,
} from '../../controllers/admin/collections-admin.controller.js';

/**
 * Store collections sub-router, mounted at `/admin/stores/:storeId/collections`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router has already run
 * `authenticateToken` → `loadStore`, so `req.store`/`req.storeMembership` are set.
 * Reads are gated on `products:read`; writes on the dedicated `collections:write`
 * permission (owner + admin hold it by default). Membership materialization onto
 * `Listing.collectionIds` is enforced in `collection.service`.
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('products:read'), listStoreCollections);
router.post(
  '/',
  requireStorePermission('collections:write'),
  validateBody(createCollectionSchema),
  createStoreCollection,
);
router.get(
  '/:id',
  requireStorePermission('products:read'),
  validateObjectId('id'),
  getStoreCollection,
);
router.patch(
  '/:id',
  requireStorePermission('collections:write'),
  validateObjectId('id'),
  validateBody(updateCollectionSchema),
  patchStoreCollection,
);
router.delete(
  '/:id',
  requireStorePermission('collections:write'),
  validateObjectId('id'),
  deleteStoreCollection,
);
router.post(
  '/:id/products',
  requireStorePermission('collections:write'),
  validateObjectId('id'),
  validateBody(setCollectionProductsSchema),
  setStoreCollectionProducts,
);

export default router;
