import { z } from 'zod';
import { MAX_FEATURED_COLLECTIONS } from '@mercaria/shared-types';
import {
  getFeaturedCollections,
  setFeaturedCollections,
} from '../../controllers/admin/featured-collections.controller.js';
import { Router } from 'express';
import { validateBody, validateId } from '../../middleware/validate.js';
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
 * `authenticateToken` → `loadStore`, so `req.store`/`req.storeAccess` are set.
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
router.get('/featured', requireStorePermission('products:read'), getFeaturedCollections);
router.put(
  '/featured',
  requireStorePermission('collections:write'),
  validateBody(
    z.object({ collectionIds: z.array(z.string().min(1)).max(MAX_FEATURED_COLLECTIONS) }).strict(),
  ),
  setFeaturedCollections,
);
router.get('/:id', requireStorePermission('products:read'), validateId('id'), getStoreCollection);
router.patch(
  '/:id',
  requireStorePermission('collections:write'),
  validateId('id'),
  validateBody(updateCollectionSchema),
  patchStoreCollection,
);
router.delete(
  '/:id',
  requireStorePermission('collections:write'),
  validateId('id'),
  deleteStoreCollection,
);
router.post(
  '/:id/products',
  requireStorePermission('collections:write'),
  validateId('id'),
  validateBody(setCollectionProductsSchema),
  setStoreCollectionProducts,
);

export default router;
