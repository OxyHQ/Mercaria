import { Router } from 'express';
import { validateBody, validateId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import {
  createStoreProductSchema,
  updateListingSchema,
  createVariantSchema,
  releasePinnedFieldsSchema,
  updateVariantSchema,
  setInventorySchema,
  setLevelInventorySchema,
} from '../../middleware/schemas.js';
import {
  listProducts,
  createProduct,
  getProduct,
  patchProduct,
  deleteProduct,
  releaseProductPins,
  createVariant,
  patchVariant,
  deleteVariant,
  setVariantInventory,
  listVariantLevels,
  setVariantLevelInventory,
} from '../../controllers/admin/products-admin.controller.js';

/**
 * Store products sub-router, mounted at `/admin/stores/:storeId/products`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router already ran
 * `authenticateToken` → `loadStore`. Reads require `products:read`; writes
 * require `products:write` (including the #427 field-pin release); the
 * inventory absolute-set requires `inventory:write`.
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('products:read'), listProducts);
router.post('/', requireStorePermission('products:write'), validateBody(createStoreProductSchema), createProduct);

router.get('/:id', requireStorePermission('products:read'), validateId('id'), getProduct);
router.patch(
  '/:id',
  requireStorePermission('products:write'),
  validateId('id'),
  validateBody(updateListingSchema),
  patchProduct,
);
router.delete('/:id', requireStorePermission('products:write'), validateId('id'), deleteProduct);

/**
 * #427 — release connector field pins. `products:write` because an ordinary
 * edit is what CREATES one, so the way out is gated exactly like the way in;
 * see the controller for why neither `channels:write` nor `store:manage` is it.
 */
router.post(
  '/:id/pins/release',
  requireStorePermission('products:write'),
  validateId('id'),
  validateBody(releasePinnedFieldsSchema),
  releaseProductPins,
);

// Variants.
router.post(
  '/:id/variants',
  requireStorePermission('products:write'),
  validateId('id'),
  validateBody(createVariantSchema),
  createVariant,
);
router.patch(
  '/:id/variants/:variantId',
  requireStorePermission('products:write'),
  validateId('id'),
  validateId('variantId'),
  validateBody(updateVariantSchema),
  patchVariant,
);
router.delete(
  '/:id/variants/:variantId',
  requireStorePermission('products:write'),
  validateId('id'),
  validateId('variantId'),
  deleteVariant,
);

// Inventory absolute-set at the default location (admin restock).
router.patch(
  '/:id/variants/:variantId/inventory',
  requireStorePermission('inventory:write'),
  validateId('id'),
  validateId('variantId'),
  validateBody(setInventorySchema),
  setVariantInventory,
);

// Multi-location inventory levels (per-variant per-location stock).
router.get(
  '/:id/variants/:variantId/levels',
  requireStorePermission('products:read'),
  validateId('id'),
  validateId('variantId'),
  listVariantLevels,
);
router.patch(
  '/:id/variants/:variantId/levels/:locationId',
  requireStorePermission('inventory:write'),
  validateId('id'),
  validateId('variantId'),
  validateId('locationId'),
  validateBody(setLevelInventorySchema),
  setVariantLevelInventory,
);

export default router;
