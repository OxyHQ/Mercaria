/**
 * Merchants API (#54) — PUBLIC reads over the canonical merchant layer.
 *
 * Identity data only: profiles, lookups and the derived checkout-eligibility
 * verdict. No writes live here — merchants are minted by ingestion (#62), the
 * backfill (#60) and claiming (#40/#83); linkage is operator-only under
 * `/internal/commerce-graph`. No auth: everything served is public catalogue
 * identity, and there is no viewer-specific hydration to attach. Rate-limited
 * under the `'listings'` scope, the closest read-path budget (the
 * `categories` precedent).
 *
 * Route ORDER is load-bearing: `/lookup` and `/by-native-store/:storeId` must
 * precede `/:idOrSlug`, or the parameter route swallows them.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import { merchantLookupQuerySchema } from '../middleware/commerce-graph-schemas.js';
import {
  getMerchant,
  getMerchantByNativeStore,
  getMerchantCheckoutEligibility,
  lookupMerchants,
} from '../controllers/merchants.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/** GET /merchants/lookup?domain=|alias= — exactly one criterion. */
router.get('/lookup', validateQuery(merchantLookupQuerySchema), lookupMerchants);

/** GET /merchants/by-native-store/:storeId — reverse lookup of a native store. */
router.get('/by-native-store/:storeId', getMerchantByNativeStore);

/** GET /merchants/:idOrSlug — public profile; merge tombstones redirect. */
router.get('/:idOrSlug', getMerchant);

/** GET /merchants/:idOrSlug/native-checkout-eligibility — derived, never stored. */
router.get('/:idOrSlug/native-checkout-eligibility', getMerchantCheckoutEligibility);

export default router;
