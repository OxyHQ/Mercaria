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
import { merchantCatalogQuerySchema } from '../middleware/merchant-page-schemas.js';
import {
  getMerchant,
  getMerchantByNativeStore,
  getMerchantCheckoutEligibility,
  getMerchantClaimEligibility,
  lookupMerchants,
} from '../controllers/merchants.controller.js';
import {
  getMerchantCatalogHandler,
  getMerchantOffersHandler,
  getMerchantPageHandler,
} from '../controllers/merchant-pages.controller.js';

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

/**
 * GET /merchants/:idOrSlug/claim-eligibility — whether `Claim this merchant`
 * belongs on this page (#83). Public and evidence-free: it names nobody.
 */
router.get('/:idOrSlug/claim-eligibility', getMerchantClaimEligibility);

/**
 * The merchant PAGE (#73) — identity and aliases, standing in safe public
 * language, the operating organization when verified and useful, both channel
 * lists with their operators, the linked native store as a LINK, the verified
 * brand standings, the offer mix and the merchant-scoped review aggregate.
 *
 * Separate from `GET /:idOrSlug` rather than widening it: that route is #54's
 * identity read, several surfaces poll it, and turning it into a page read
 * would make every one of them pay for eleven joins they do not use.
 */
router.get('/:idOrSlug/page', getMerchantPageHandler);

/** GET /merchants/:idOrSlug/catalog — canonical products, deduplicated (#73). */
router.get(
  '/:idOrSlug/catalog',
  validateQuery(merchantCatalogQuerySchema),
  getMerchantCatalogHandler,
);

/** GET /merchants/:idOrSlug/offers — the offer-level comparison view (#73). */
router.get(
  '/:idOrSlug/offers',
  validateQuery(merchantCatalogQuerySchema),
  getMerchantOffersHandler,
);

export default router;
