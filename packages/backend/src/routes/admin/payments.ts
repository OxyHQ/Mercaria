import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { makeRateLimiter } from '../../lib/rate-limit.js';
import { onboardingLinkSchema } from '../../middleware/payments-schemas.js';
import {
  createStoreOnboardingLinkHandler,
  getStorePaymentAccountHandler,
  refreshStorePaymentAccountHandler,
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
 * ADR 0001 D9 says a store member with `store:manage` may onboard. Deciding
 * where a store's money is settled — and starting an identity-verification flow
 * in the store's name — is the owner's, and `store:manage` is the one
 * permission `admin` does not have.
 *
 * ## The gateway calls are metered on their own scope
 *
 * Minting a link (which can open a connected account) and refreshing one are
 * gateway calls whose cost is somebody else's rate limit, so they share the
 * dedicated `payments` scope. The read is not metered separately: it is one
 * indexed local query, which the screen re-reads while a seller finishes
 * onboarding in another tab.
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

router.post(
  '/account/refresh',
  makeRateLimiter('payments'),
  requireStorePermission('store:manage'),
  refreshStorePaymentAccountHandler,
);

export default router;
