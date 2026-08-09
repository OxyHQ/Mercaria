/**
 * Brand-relationship API (#55) — PUBLIC reads of VERIFIED relationships only.
 *
 * A separate router from `/brands` on purpose: #56 and #73 own the brand entity
 * surface, and the file-ownership protocol (ADR 0002 D25a) keeps each issue out
 * of the others' files. What lives here is the relationship VIEW of a brand,
 * which is #55's own.
 *
 * No auth: everything served is public catalogue identity — a verified,
 * scoped relationship and the badge it produces — and there is no
 * viewer-specific hydration to attach. Rate-limited under `'listings'`, the
 * closest read-path budget, following `routes/merchants.ts`.
 *
 * Route ORDER is load-bearing: `/official-channel` must precede the parameter
 * routes or a `:brandId` pattern would swallow it.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import {
  brandChannelsQuerySchema,
  officialChannelQuerySchema,
} from '../middleware/relationship-schemas.js';
import {
  getBrandChannels,
  getMerchantBrandRelationships,
  getOfficialChannelVerdict,
} from '../controllers/brand-relationships.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/** GET /brand-relationships/official-channel — the product page's question. */
router.get(
  '/official-channel',
  validateQuery(officialChannelQuerySchema),
  getOfficialChannelVerdict,
);

/** GET /brand-relationships/brands/:brandId/channels — direct channels and resellers, separately. */
router.get(
  '/brands/:brandId/channels',
  validateQuery(brandChannelsQuerySchema),
  getBrandChannels,
);

/** GET /brand-relationships/merchants/:merchantId/brands — the merchant-page mirror. */
router.get(
  '/merchants/:merchantId/brands',
  validateQuery(brandChannelsQuerySchema),
  getMerchantBrandRelationships,
);

export default router;
