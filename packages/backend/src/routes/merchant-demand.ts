/**
 * `/merchant-demand/*` — the merchant-facing demand surfaces (#86).
 *
 * ## Why this is NOT under `/admin/stores/:storeId`
 *
 * The subject is a canonical-graph MERCHANT, not a native store. An external or
 * affiliate offer names a merchant (#62 refuses to produce an offer for a source
 * with no merchant binding) while a native offer names a listing, so the entity
 * a demand report is ABOUT is the merchant — and a store permission cannot be
 * checked against one until an active `native_store_links` row ties the two
 * together, which most merchants in this graph do not have.
 *
 * `analytics:read` is still the permission the linked-store route requires, and
 * `services/merchant-demand/access.ts` is where the two routes in meet.
 *
 * ## The preview is mounted separately and is UNAUTHENTICATED
 *
 * Two routers would be tidier and one is correct: they share a path prefix, and
 * splitting them would put `/merchant-demand/:id` and
 * `/merchant-demand/:id/preview` in different files where the ordering between
 * them is invisible. The preview carries `optionalAuth` so a signed-in visitor
 * is not treated differently from a signed-out one — the response is identical
 * either way, which is the property that makes it safe to cache and safe to
 * link.
 */

import { Router } from 'express';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateQuery } from '../middleware/validate.js';
import { merchantDemandQuerySchema } from '../middleware/merchant-demand-schemas.js';
import {
  getMerchantDemandHandler,
  getMerchantDemandPreviewHandler,
  listDemandMetricsHandler,
} from '../controllers/merchant-demand.controller.js';

const router = Router();

// Its own bucket. A demand read builds a snapshot when there is none for the
// window, which costs several aggregate scans — a very different budget from a
// catalogue browse, and one an unauthenticated preview shares.
router.use(makeRateLimiter('merchant-demand'));

/** The metric definitions, so a dashboard renders a legend without guessing. */
router.get('/metrics', listDemandMetricsHandler);

/** The UNCLAIMED merchant's bounded, rounded proof. Mounted before the id route. */
router.get(
  '/:merchantId/preview',
  optionalAuth,
  validateQuery(merchantDemandQuerySchema),
  getMerchantDemandPreviewHandler,
);

/** The CLAIMED merchant's dashboard. `?format=csv` is the export. */
router.get(
  '/:merchantId',
  authenticateToken,
  validateQuery(merchantDemandQuerySchema),
  getMerchantDemandHandler,
);

export default router;
