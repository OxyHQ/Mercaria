import { Router } from 'express';
import { validateBody, validateId, validateQuery } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import {
  replenishmentOverrideSchema,
  replenishmentPlanQuerySchema,
  replenishmentSettingsSchema,
} from '../../middleware/replenishment-schemas.js';
import {
  deleteReplenishmentOverrideHandler,
  getReplenishmentPlanHandler,
  getReplenishmentSettingsHandler,
  putReplenishmentOverrideHandler,
  putReplenishmentSettingsHandler,
} from '../../controllers/admin/replenishment-admin.controller.js';

/**
 * Replenishment planning (#89 `replenishment_planning`), mounted at
 * `/admin/stores/:storeId/replenishment`. The parent has authenticated the
 * caller and loaded the store.
 *
 * ## Two permissions to READ, because a plan is two kinds of fact
 *
 * A plan row puts a variant's stock (`products:read`) beside its units sold
 * (`stats:read`), so reading one needs both: owner, admin, editor and viewer
 * by default. Changing what the plan is computed with is inventory work, so it
 * needs `inventory:write` (owner, admin, editor).
 *
 * ## Where the capability is checked
 *
 * In the service, on the plan and on every settings write — never here, so the
 * route and a future background caller cannot disagree. Reading the saved
 * settings and deleting an override are deliberately ungated: they only show or
 * remove what the store already made.
 */
const router = Router({ mergeParams: true });

const requireRead = [requireStorePermission('products:read'), requireStorePermission('stats:read')];
const requireWrite = requireStorePermission('inventory:write');

/** Writes pass the read gate too: their answer is the settings view, products and all. */
const requireReadWrite = [...requireRead, requireWrite];

router.get('/settings', ...requireRead, getReplenishmentSettingsHandler);
router.put(
  '/settings',
  ...requireReadWrite,
  validateBody(replenishmentSettingsSchema),
  putReplenishmentSettingsHandler,
);
router.put(
  '/overrides/:variantId',
  ...requireReadWrite,
  validateId('variantId'),
  validateBody(replenishmentOverrideSchema),
  putReplenishmentOverrideHandler,
);
router.delete(
  '/overrides/:variantId',
  ...requireReadWrite,
  validateId('variantId'),
  deleteReplenishmentOverrideHandler,
);
router.get(
  '/plan',
  ...requireRead,
  validateQuery(replenishmentPlanQuerySchema),
  getReplenishmentPlanHandler,
);

export default router;
