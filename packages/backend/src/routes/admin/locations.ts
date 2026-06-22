import { Router } from 'express';
import { validateBody, validateObjectId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { createLocationSchema, updateLocationSchema } from '../../middleware/schemas.js';
import {
  listStoreLocations,
  createStoreLocation,
  patchStoreLocation,
  deleteStoreLocation,
} from '../../controllers/admin/locations-admin.controller.js';

/**
 * Store locations sub-router, mounted at `/admin/stores/:storeId/locations`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router has already run
 * `authenticateToken` → `loadStore`, so `req.store`/`req.storeMembership` are
 * set. There is no `locations:read` permission; every location route (incl. the
 * read) is gated on `locations:write`. The store-protection invariants (a store
 * keeps ≥1 location; the default cannot be deleted) are enforced in
 * `location.service`.
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('locations:write'), listStoreLocations);
router.post(
  '/',
  requireStorePermission('locations:write'),
  validateBody(createLocationSchema),
  createStoreLocation,
);
router.patch(
  '/:id',
  requireStorePermission('locations:write'),
  validateObjectId('id'),
  validateBody(updateLocationSchema),
  patchStoreLocation,
);
router.delete(
  '/:id',
  requireStorePermission('locations:write'),
  validateObjectId('id'),
  deleteStoreLocation,
);

export default router;
