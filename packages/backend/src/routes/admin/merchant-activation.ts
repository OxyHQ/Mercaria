import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import {
  acceptActivationPolicySchema,
  updateActivationSettingsSchema,
} from '../../middleware/merchant-activation-schemas.js';
import {
  acceptStorePolicyHandler,
  getStoreActivationHandler,
  updateStoreActivationHandler,
} from '../../controllers/merchant-activation.controller.js';

/**
 * A store's activation surface (#85), mounted at
 * `/admin/stores/:storeId/activation`.
 *
 * Authentication and store membership are already established by the parent
 * (`admin/index.ts` runs `authenticateToken`, `admin/stores.ts` runs
 * `loadStore`), so this router only adds the permission.
 *
 * ## `store:manage` on all three, like payment onboarding and the fee schedule
 *
 * #85 permissions rule 1 asks that only owners or members with the correct
 * management permission perform each step, and rule 3 that "staff cannot accept
 * a new fee schedule or transfer store ownership without explicit permission".
 * Accepting the returns-and-fulfilment responsibilities is the same kind of act
 * as accepting a fee schedule — a binding commitment about what this business
 * owes its buyers — and `store:manage` is the one permission an `admin` does not
 * hold, which is exactly the line #88 and #46 already drew.
 *
 * The READ takes the same gate rather than a looser one, deliberately: a screen
 * that could show the readiness checklist but not act on it would be built
 * against a permission split this API then could not change without breaking it.
 * A store member who needs to know whether the store can sell has
 * `GET .../channels/readiness` (#87), which is the operational half and is
 * gated for operational people.
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('store:manage'), getStoreActivationHandler);

router.patch(
  '/',
  requireStorePermission('store:manage'),
  validateBody(updateActivationSettingsSchema),
  updateStoreActivationHandler,
);

router.post(
  '/policies',
  requireStorePermission('store:manage'),
  validateBody(acceptActivationPolicySchema),
  acceptStorePolicyHandler,
);

export default router;
