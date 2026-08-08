import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { makeRateLimiter } from '../../lib/rate-limit.js';
import { onboardingLinkSchema } from '../../middleware/payments-schemas.js';
import {
  createStoreOnboardingLinkHandler,
  getStorePaymentAccountHandler,
} from '../../controllers/payments.controller.js';

/**
 * A store's payment onboarding, mounted at `/admin/stores/:storeId/payments`.
 *
 * Authentication and store membership are already established by the parent
 * (`admin/index.ts` runs `authenticateToken`, `admin/stores.ts` runs
 * `loadStore`), so this router only adds the permission and the meter.
 *
 * ## `store:manage`, not `settings:write`
 *
 * ADR 0001 D9 says a store member with `store:manage` may onboard, and the
 * permission matters more here than the ADR line: `settings:write` belongs to
 * `admin` and `staff`, and it opens the return policy and the low-stock
 * threshold. Deciding where a store's money is settled — and starting an
 * identity-verification flow in the store's name — is the owner's, and
 * `store:manage` is the one permission `admin` does not have.
 *
 * ## Link minting is metered on its own scope
 *
 * Every mint is a Stripe API call, and the create path behind it can bring a
 * connected account into existence. The `admin` limiter above it meters the
 * whole dashboard as one budget, which is the wrong grain for a route whose
 * cost is somebody else's rate limit — hence a dedicated `payments` scope with
 * its own Redis prefix (sharing one would halve both budgets, `ERR_ERL_DOUBLE_COUNT`).
 * The read is not metered separately: it is one indexed local query, and the
 * dashboard polls it while a seller finishes onboarding in another tab.
 */
const router = Router({ mergeParams: true });

router.get('/account', requireStorePermission('store:manage'), getStorePaymentAccountHandler);

router.post(
  '/account/onboarding-link',
  makeRateLimiter('payments'),
  requireStorePermission('store:manage'),
  validateBody(onboardingLinkSchema),
  createStoreOnboardingLinkHandler,
);

export default router;
