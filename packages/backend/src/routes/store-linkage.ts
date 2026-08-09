/**
 * `/store-linkage/*` — the claimant-facing linkage surface (#84).
 *
 * Every route is authenticated with an Oxy session and scoped to the caller's
 * OWN requests: the service resolves each request by id AND claimant and answers
 * 404 for anybody else's, so this router needs no ownership middleware and
 * cannot forget one — the `/merchant-claims` shape, for its reason.
 *
 * Mounted OUTSIDE `/admin`, deliberately, and for a sharper reason than
 * `/merchant-claims` had. That whole tree is reached through `loadStore`, which
 * resolves `:storeId` from the PATH and establishes a membership in ONE store.
 * A linkage request either has no store yet (`create_store`) or names one in a
 * BODY beside a claim — so `loadStore` could not run on the first case at all,
 * and would authorize the wrong thing on the second. The permission check
 * therefore happens in the service, against the store the request actually
 * names, and `claimantMayLinkStore` is the one place it is spelled.
 *
 * Metered on the SAME `rl:merchant-claims:` bucket as #83. This is one journey —
 * prove you operate a merchant, then connect it to a store — and two buckets
 * would let a caller who exhausted one keep hammering the other half of it.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  applyStoreLinkageRequestSchema,
  openStoreLinkageRequestSchema,
  storeLinkageDiffQuerySchema,
} from '../middleware/store-linkage-schemas.js';
import {
  applyLinkageRequestHandler,
  getLinkageDiffHandler,
  getLinkageRequestHandler,
  listLinkageRequestsHandler,
  openLinkageRequestHandler,
} from '../controllers/store-linkage.controller.js';

const router = Router();

router.use(authenticateToken);
router.use(makeRateLimiter('merchant-claims'));

/**
 * GET /store-linkage/diff — compare a store against a canonical merchant.
 *
 * BEFORE `/requests/:id`, because express matches in declaration order and a
 * literal segment that follows a parameter route on the same prefix is
 * unreachable. It is on a different prefix here, so the order is defensive
 * rather than load-bearing — but `/merchant-claims` learned this the hard way
 * and the ordering convention is cheaper to keep than to re-derive.
 */
router.get('/diff', validateQuery(storeLinkageDiffQuerySchema), getLinkageDiffHandler);

/** POST /store-linkage/requests — open (or converge on) a linkage request. */
router.post('/requests', validateBody(openStoreLinkageRequestSchema), openLinkageRequestHandler);

/** GET /store-linkage/requests — the caller's own requests. */
router.get('/requests', listLinkageRequestsHandler);

/** GET /store-linkage/requests/:id — one request, with candidates and findings. */
router.get('/requests/:id', getLinkageRequestHandler);

/** POST /store-linkage/requests/:id/apply — apply it. Safe to retry. */
router.post(
  '/requests/:id/apply',
  validateBody(applyStoreLinkageRequestSchema),
  applyLinkageRequestHandler,
);

export default router;
