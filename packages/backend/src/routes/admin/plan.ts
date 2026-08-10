import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { merchantPlanCheckoutSchema } from '../../middleware/merchant-plans-schemas.js';
import {
  cancelStorePlanHandler,
  getPlanCatalogHandler,
  getStorePlanHandler,
  openPlanPortalHandler,
  startPlanCheckoutHandler,
} from '../../controllers/merchant-plans.controller.js';

/**
 * A store's plan, entitlements and billing surface (#89), mounted at
 * `/admin/stores/:storeId/plan`.
 *
 * Authentication and store membership are already established by the parent
 * (`admin/index.ts` runs `authenticateToken`, `admin/stores.ts` runs
 * `loadStore`), so this router only adds the permission.
 *
 * ## `store:manage` on all five, like the fee surface and for its reason
 *
 * The comparison, the upgrade, the portal and the cancellation are one
 * conversation — "what does Mercaria charge this store, and do we agree" — and
 * that is the owner's conversation. Splitting the read off would build a screen
 * against a permission boundary this API could then not move.
 *
 * ## The router is NOT flag-gated, and the flag is not what protects it
 *
 * `MERCHANT_BILLING_ENABLED` gates the two routes that would open a hosted
 * provider session, inside the service. Gating the MOUNT would take the plan
 * screen away from a merchant who already has a subscription the moment somebody
 * pulled the incident lever — and reading your own plan is not a thing an
 * incident lever should be able to remove.
 */
const router = Router({ mergeParams: true });

/** This store's plan, effective entitlements and usage. */
router.get('/', requireStorePermission('store:manage'), getStorePlanHandler);

/** The plan comparison, with exact current capabilities. */
router.get('/catalog', requireStorePermission('store:manage'), getPlanCatalogHandler);

/** Start a paid plan. Answers a hosted URL; creates no subscription. */
router.post(
  '/checkout',
  requireStorePermission('store:manage'),
  validateBody(merchantPlanCheckoutSchema),
  startPlanCheckoutHandler,
);

/** Open the provider's hosted billing portal. */
router.post('/portal', requireStorePermission('store:manage'), openPlanPortalHandler);

/** Cancel at the end of the paid period. There is deliberately no immediate one. */
router.post('/cancel', requireStorePermission('store:manage'), cancelStorePlanHandler);

export default router;
