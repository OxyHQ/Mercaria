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
import { upgradeListingProductTypeSchema } from '../../middleware/catalog-authoring-schemas.js';
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
  previewProductTypeUpgrade,
  applyProductTypeUpgrade,
  loadStoreProduct,
} from '../../controllers/admin/products-admin.controller.js';
import { makeListingLocalizationRouter } from '../../controllers/listing-localizations.controller.js';
import { makeVariantImageRouter } from '../../controllers/variant-images.controller.js';

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
 * #587 — move a published listing forward to a newer product-type version.
 *
 * The PREVIEW is a GET and applying it is a POST, on one path — the
 * `/product-drafts/:draftId/upgrade` shape, one entity over, and for its reason
 * (ADR 0007 D10: a newer schema version produces a preview, never a silent
 * rewrite).
 *
 * `products:write` and not a new permission string: `store_members_permissions_check`
 * renders the tuple, so an unlisted one is a runtime refusal at the row — and
 * moving a listing's schema version is exactly what that permission names.
 * The PREVIEW is behind `products:write` too rather than `products:read`,
 * because it exists to be acted on and reads a version comparison a shopper has
 * no business seeing; the draft upgrade made the same call for the same reason.
 */
router.get(
  '/:id/product-type-upgrade',
  requireStorePermission('products:write'),
  validateId('id'),
  previewProductTypeUpgrade,
);
router.post(
  '/:id/product-type-upgrade',
  requireStorePermission('products:write'),
  validateId('id'),
  validateBody(upgradeListingProductTypeSchema),
  applyProductTypeUpgrade,
);

/**
 * `/admin/stores/:storeId/products/:id/localizations` — a store's own product
 * translations (#814).
 *
 * The `store` half of a two-mount split; `/seller/listings/:id/localizations` is
 * the `user` half, and both call `makeListingLocalizationRouter`. Which Oxy
 * account may act for this store is answered where it always is — `loadStore`
 * ran on the parent router and `requireStorePermission` runs here — and
 * `loadStoreProduct`, the SAME function `PATCH /:id` uses, then confirms the
 * product belongs to it.
 *
 * `products:write` and NOT `store:manage`: an `admin` holds every permission
 * except `store:manage`, so gating this on it would lock a store admin out of
 * translating a title they can already rewrite through `PATCH /:id`. Product
 * drafts, catalog proposals and catalog authoring all made the same call.
 *
 * The READ is behind the write permission too, deliberately — the
 * `/product-type-upgrade` preview immediately above took the same decision for
 * the same reason: it exists to be acted on, and a translation coverage list is
 * an authoring view rather than a catalogue read.
 */
router.use(
  '/:id/localizations',
  requireStorePermission('products:write'),
  validateId('id'),
  makeListingLocalizationRouter(loadStoreProduct),
);

/**
 * `/admin/stores/:storeId/products/:id/variants/:variantId/images` — which of a
 * store's own gallery photographs each variant shows (#855).
 *
 * The `store` half of a two-mount split;
 * `/seller/listings/:id/variants/:variantId/images` is the `user` half, and both
 * call `makeVariantImageRouter`. Which Oxy account may act for this store is
 * answered where it always is — `loadStore` ran on the parent router and
 * `requireStorePermission` runs here — and `loadStoreProduct`, the SAME function
 * `PATCH /:id` and the localization mount above both use, then confirms the
 * product belongs to it.
 *
 * `products:write` and NOT `store:manage`: an `admin` holds every permission
 * except `store:manage`, so gating this on it would lock a store admin out of
 * choosing a photograph for a product whose entire gallery they can already
 * replace through `PATCH /:id`. Product drafts, catalog proposals, catalog
 * authoring and #814's translations all made the same call. `store:manage` is
 * where commercial commitments live, and assigning a photograph to a variant is
 * not one.
 *
 * The READ is behind the write permission too, deliberately, for the reason the
 * localization mount records: it is an authoring view of what has been selected,
 * not a catalogue read — the catalogue's answer to "what does this variant look
 * like" is the hydrated `Listing`, which applies the gallery fallback and is
 * public.
 *
 * The mount names the WHOLE path rather than `/:id/variants`, and that is
 * load-bearing here in a way it is not on the seller side. `router.use(prefix,
 * mw)` runs its middleware for every request matching the prefix, and four
 * established siblings live under `/:id/variants/:variantId` — the variant
 * PATCH and DELETE, the inventory absolute-set (`inventory:write`) and the
 * levels read (`products:read`). On the short prefix this line would put
 * `products:write` in front of all four, and a member holding `inventory:write`
 * alone would silently stop being able to restock.
 */
router.use(
  '/:id/variants/:variantId/images',
  requireStorePermission('products:write'),
  validateId('id'),
  makeVariantImageRouter(loadStoreProduct),
);

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
