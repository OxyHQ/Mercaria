import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { setStorePermissionOverrideSchema } from '../../middleware/schemas.js';
import {
  listOverrides,
  putOverride,
  deleteOverride,
} from '../../controllers/admin/permission-overrides.controller.js';

/**
 * Store permission-override sub-router, mounted at
 * `/admin/stores/:storeId/permission-overrides`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router has already run
 * `authenticateToken` → `loadStore`, so `req.store`/`req.storeAccess` are set.
 * Every route requires `members:manage` — the permission that governs who may
 * do what on the store, now that WHO belongs to it is Oxy's (ADR 0012).
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('members:manage'), listOverrides);
router.put(
  '/:oxyUserId',
  requireStorePermission('members:manage'),
  validateBody(setStorePermissionOverrideSchema),
  putOverride,
);
router.delete('/:oxyUserId', requireStorePermission('members:manage'), deleteOverride);

export default router;
