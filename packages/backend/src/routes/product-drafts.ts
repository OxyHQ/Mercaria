/**
 * `/stores/:storeId/product-drafts/*` — the authoring drafts (#367 step 5,
 * ADR 0007 D10).
 *
 * Mounted at that exact path in `app.ts` rather than under `/admin/stores`,
 * because ADR 0007 D10 finalizes it there. It carries its own
 * `authenticateToken` → `validateId('storeId')` → `loadStore` chain, which is
 * what `/admin/stores` does once for its whole tree — the three cannot be
 * inherited from a tree this router is not inside.
 *
 * Every route is behind `products:write`, the SAME permission the existing
 * `/admin/stores/:storeId/products` writes use. Deliberately not a new
 * permission string: `store_members_permissions_check` renders the tuple, so an
 * unlisted one is a runtime refusal at the row — and a merchant authoring a
 * product is doing precisely what that permission names. `products:read` is not
 * used even for the reads here, because a draft is unpublished work in progress
 * rather than catalogue, and the set of people who may see one is the set who
 * may write one.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { catalogRolloutGate } from '../middleware/catalog-rollout.js';
import { loadStore, requireStorePermission } from '../middleware/store-authz.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateId, validateQuery } from '../middleware/validate.js';
import {
  createProductDraftSchema,
  discardProductDraftQuerySchema,
  listProductDraftsQuerySchema,
  patchProductDraftSchema,
  upgradeProductDraftSchema,
} from '../middleware/catalog-authoring-schemas.js';
import {
  applyProductDraftUpgradeHandler,
  createProductDraftHandler,
  discardProductDraftHandler,
  getProductDraftHandler,
  listProductDraftsHandler,
  patchProductDraftHandler,
  previewProductDraftUpgradeHandler,
  publishProductDraftHandler,
  validateProductDraftHandler,
} from '../controllers/catalog-authoring.controller.js';

/** `mergeParams` so `:storeId` from the mount path is visible to the handlers. */
const router = Router({ mergeParams: true });

router.use(makeRateLimiter('admin'), authenticateToken, validateId('storeId'), loadStore);
/**
 * `CATALOG_ROLLOUT_COHORTS` (ADR 0007 D12) — the rollout stage this store is in.
 *
 * The richest subject in the epic and the reason the gate sits at `router.use`
 * here rather than per route: `mergeParams` puts `:storeId` on every request,
 * and a draft CREATE additionally carries `categoryId`, `productTypeKey`,
 * `locale` and `market` in its body — and `authenticateToken` above supplies the
 * caller, so all SIX dimensions including `internal_user` are answerable on one
 * surface. AFTER `loadStore`, so a request for a store the caller cannot
 * reach is refused as unauthorised rather than as un-rolled-out.
 */
router.use(catalogRolloutGate());

router.get(
  '/',
  requireStorePermission('products:write'),
  validateQuery(listProductDraftsQuerySchema),
  listProductDraftsHandler,
);
router.post(
  '/',
  requireStorePermission('products:write'),
  validateBody(createProductDraftSchema),
  createProductDraftHandler,
);

router.get(
  '/:draftId',
  requireStorePermission('products:write'),
  validateId('draftId'),
  getProductDraftHandler,
);
router.patch(
  '/:draftId',
  requireStorePermission('products:write'),
  validateId('draftId'),
  validateBody(patchProductDraftSchema),
  patchProductDraftHandler,
);
router.delete(
  '/:draftId',
  requireStorePermission('products:write'),
  validateId('draftId'),
  validateQuery(discardProductDraftQuerySchema),
  discardProductDraftHandler,
);

router.post(
  '/:draftId/validate',
  requireStorePermission('products:write'),
  validateId('draftId'),
  validateProductDraftHandler,
);
/**
 * The upgrade PREVIEW is a GET and applying it is a POST, on one path.
 *
 * ADR 0007 D10: a newer schema version produces a preview, never a silent
 * rewrite. Two verbs on one path is what makes "look" and "do" different
 * requests — a single endpoint returning a preview and applying it would make
 * the rewrite reachable by a client that only meant to look.
 */
router.get(
  '/:draftId/upgrade',
  requireStorePermission('products:write'),
  validateId('draftId'),
  previewProductDraftUpgradeHandler,
);
router.post(
  '/:draftId/upgrade',
  requireStorePermission('products:write'),
  validateId('draftId'),
  validateBody(upgradeProductDraftSchema),
  applyProductDraftUpgradeHandler,
);

router.post(
  '/:draftId/publish',
  requireStorePermission('products:write'),
  validateId('draftId'),
  publishProductDraftHandler,
);

export default router;
