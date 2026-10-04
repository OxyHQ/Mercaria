import { Router } from 'express';
import { validateBody, validateId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { createLocationSchema, updateLocationSchema } from '../../middleware/schemas.js';
import {
  listStoreLocations,
  createStoreLocation,
  patchStoreLocation,
  deleteStoreLocation,
} from '../../controllers/admin/locations-admin.controller.js';
import {
  getPublicationHandler,
  listPublicationsHandler,
  locationPickupQueueHandler,
  publicationTrailHandler,
  putPublicationHandler,
  setPickupPauseHandler,
  setPublicationStateHandler,
  verifyPlaceLinkHandler,
} from '../../controllers/admin/pickup-admin.controller.js';
import {
  setPickupPauseSchema,
  setPublicationStateSchema,
  upsertLocationPublicationSchema,
} from '../../middleware/pickup-schemas.js';

/**
 * Store locations sub-router, mounted at `/admin/stores/:storeId/locations`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router has already run
 * `authenticateToken` → `loadStore`, so `req.store`/`req.storeAccess` are
 * set. There is no `locations:read` permission; every location route (incl. the
 * read) is gated on `locations:write`. The store-protection invariants (a store
 * keeps ≥1 location; the default cannot be deleted) are enforced in
 * `location.service`.
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('locations:write'), listStoreLocations);

/**
 * The PUBLICATION sub-surface (#93) — whether, and on what commerce terms, one
 * of these locations is offered to the public, and which GoWay place it trades
 * from. Its hours and closures are the place's, edited in GoWay (ADR 0013);
 * there is no route for them here.
 *
 * Mounted here rather than in a router of its own because a publication has no
 * existence apart from its location: the tenant scoping, the `:storeId` load
 * and the `locations:write` gate are all already in force, and a second mount
 * would be a second place that authorization could be got wrong.
 *
 * `/publications` (plural) is registered BEFORE `/:id` so the literal path is
 * not captured by the param route — the `/stats` precedent one router over.
 */
router.get('/publications', requireStorePermission('locations:write'), listPublicationsHandler);
router.get(
  '/:id/publication',
  requireStorePermission('locations:write'),
  validateId('id'),
  getPublicationHandler,
);
router.put(
  '/:id/publication',
  requireStorePermission('locations:write'),
  validateId('id'),
  validateBody(upsertLocationPublicationSchema),
  putPublicationHandler,
);
router.post(
  '/:id/publication/state',
  requireStorePermission('locations:write'),
  validateId('id'),
  validateBody(setPublicationStateSchema),
  setPublicationStateHandler,
);
router.post(
  '/:id/publication/pickup-pause',
  requireStorePermission('locations:write'),
  validateId('id'),
  validateBody(setPickupPauseSchema),
  setPickupPauseHandler,
);
router.post(
  '/:id/place-link/verify',
  requireStorePermission('locations:write'),
  validateId('id'),
  verifyPlaceLinkHandler,
);
router.get(
  '/:id/publication/events',
  requireStorePermission('locations:write'),
  validateId('id'),
  publicationTrailHandler,
);

/**
 * One BRANCH's own collection queue.
 *
 * Gated on `orders:fulfill` rather than `locations:write`: it lists ORDERS, and
 * the person standing at a counter is a fulfiller rather than somebody who may
 * edit a shop front. The two authorities are genuinely different people in a
 * shop with staff.
 */
router.get(
  '/:id/pickups',
  requireStorePermission('orders:fulfill'),
  validateId('id'),
  locationPickupQueueHandler,
);
router.post(
  '/',
  requireStorePermission('locations:write'),
  validateBody(createLocationSchema),
  createStoreLocation,
);
router.patch(
  '/:id',
  requireStorePermission('locations:write'),
  validateId('id'),
  validateBody(updateLocationSchema),
  patchStoreLocation,
);
router.delete(
  '/:id',
  requireStorePermission('locations:write'),
  validateId('id'),
  deleteStoreLocation,
);

export default router;
