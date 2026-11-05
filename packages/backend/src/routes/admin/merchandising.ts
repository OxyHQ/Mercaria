import { Router } from 'express';
import { validateBody, validateId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import {
  createMerchandisingRuleSchema,
  merchandisingPreviewSchema,
  updateMerchandisingRuleSchema,
} from '../../middleware/merchandising-rules-schemas.js';
import {
  createStoreMerchandisingRule,
  deleteStoreMerchandisingRule,
  getStoreMerchandisingRule,
  listStoreMerchandisingRules,
  patchStoreMerchandisingRule,
  previewStoreMerchandising,
} from '../../controllers/admin/merchandising-rules.controller.js';

/**
 * Store merchandising rules, mounted at `/admin/stores/:storeId/merchandising`
 * (#89, `advanced_merchandising_rules`).
 *
 * The parent router has run `authenticateToken` → `loadStore`. The permissions
 * are the collections' own — reading on `products:read`, writing on
 * `collections:write` — because a rule arranges the same shelves a collection
 * does. The PLAN gate is a separate, second question asked by the service.
 */
const router = Router({ mergeParams: true });

router.get('/rules', requireStorePermission('products:read'), listStoreMerchandisingRules);
router.post(
  '/rules',
  requireStorePermission('collections:write'),
  validateBody(createMerchandisingRuleSchema),
  createStoreMerchandisingRule,
);
router.get(
  '/rules/:id',
  requireStorePermission('products:read'),
  validateId('id'),
  getStoreMerchandisingRule,
);
router.patch(
  '/rules/:id',
  requireStorePermission('collections:write'),
  validateId('id'),
  validateBody(updateMerchandisingRuleSchema),
  patchStoreMerchandisingRule,
);
router.delete(
  '/rules/:id',
  requireStorePermission('collections:write'),
  validateId('id'),
  deleteStoreMerchandisingRule,
);
router.post(
  '/preview',
  requireStorePermission('collections:write'),
  validateBody(merchandisingPreviewSchema),
  previewStoreMerchandising,
);

export default router;
