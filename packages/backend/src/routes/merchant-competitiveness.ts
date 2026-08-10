/**
 * `/merchant-competitiveness/*` — a merchant's own price analysis (#82
 * §"Merchant competitiveness", supporting #40).
 *
 * ## Why this is NOT under `/admin/stores/:storeId`
 *
 * The subject is a canonical-graph MERCHANT, not a native store. External and
 * affiliate offers name a merchant (#62 refuses to produce an offer for a source
 * with no merchant binding) while a native offer names a listing, so the entity a
 * competitiveness analysis is ABOUT is the merchant — and `store:manage` cannot
 * be checked against one, because a store's permission set says nothing about a
 * merchant somebody claimed.
 *
 * ## The gate is #83's verdict and it is NOT a fifth allow-list
 *
 * `merchants.claim_state = 'verified'` plus `claimed_by_oxy_user_id`, checked in
 * the service. An unclaimed merchant, a pending claim, a revoked one and a
 * caller who is somebody else all answer the SAME 404 — a distinguishable 403
 * would let anybody enumerate which merchants have been claimed. That is also why
 * revocation removes this surface with no sweep: it reads the verdict #83 writes.
 *
 * The rate-limit bucket is its own (`rl:merchant-competitiveness:`) because each
 * request costs one comparison read per subject examined, which is a very
 * different budget from a catalogue browse.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  merchantCompetitivenessQuerySchema,
  priceSignalFeedbackSchema,
  priceSignalListQuerySchema,
} from '../middleware/price-signal-schemas.js';
import {
  getMerchantCompetitivenessHandler,
  listMerchantPriceSignalFeedbackHandler,
  postPriceSignalFeedbackHandler,
} from '../controllers/price-signals.controller.js';

const router = Router();

router.use(authenticateToken);
router.use(makeRateLimiter('merchantCompetitiveness'));

/** GET — one page of the merchant's own subjects, as JSON or as a CSV export. */
router.get(
  '/:merchantId',
  validateQuery(merchantCompetitivenessQuerySchema),
  getMerchantCompetitivenessHandler,
);

/** POST — file a correction report against a signal about the merchant's own offer. */
router.post(
  '/:merchantId/feedback',
  validateBody(priceSignalFeedbackSchema),
  postPriceSignalFeedbackHandler,
);

/** GET — the merchant's own correction reports and where each stands. */
router.get(
  '/:merchantId/feedback',
  validateQuery(priceSignalListQuerySchema),
  listMerchantPriceSignalFeedbackHandler,
);

export default router;
