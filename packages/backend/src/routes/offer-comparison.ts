/**
 * Offer comparison API (#74) — the PUBLIC ranked read.
 *
 * A SEPARATE router from `/offers` rather than a mode on it, and the reason is
 * the contract each serves. `/offers` answers "every current offer on this
 * variant, cheapest first" — a keyset-paginated list with a stable SQL order
 * that #57 owns. This answers "which of them should this shopper see, in what
 * order, and why" — one page, ranked under a named policy, with every exclusion
 * and every signal beside it. Bolting the second onto the first would have made
 * the cursor mean two things and the response shape depend on a query parameter.
 *
 * `optionalAuth`, not `authenticateToken`: a comparison is public commercial
 * information. The signed-in half is a currency preference and nothing else — no
 * ranking input reads an account, and `OfferRankingFacts` has no field one could
 * be read into.
 *
 * Rate-limited under the `'listings'` scope, the same read-path budget `/offers`
 * uses: it is the same catalogue read with more arithmetic on top.
 *
 * There is deliberately NO write route, and none may be added. A "boost this
 * offer", "pin this result" or "hide this offer" endpoint is a sponsored
 * placement surface, and #74 states that sponsored placement, if introduced, is
 * a separate surface that cannot alter this score.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { optionalAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { offerComparisonQuerySchema } from '../middleware/ranking-schemas.js';
import { offerComparisonHandler } from '../controllers/offer-comparison.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'), optionalAuth);

/** GET /offer-comparison — the eligible offers, ranked, labelled and explained. */
router.get('/', validateQuery(offerComparisonQuerySchema), offerComparisonHandler);

export default router;
