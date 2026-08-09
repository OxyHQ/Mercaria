/**
 * `/merchant-claims/*` — the claimant-facing claim surface (#83).
 *
 * Every route is authenticated with an Oxy session (issue API rule 2) and
 * scoped to the caller's OWN claims: the service resolves each claim by id AND
 * claimant and answers 404 for anybody else's, so this router needs no
 * ownership middleware and cannot forget one.
 *
 * Mounted OUTSIDE `/admin`, deliberately. That whole tree is reached through
 * `loadStore`, which establishes a membership in one store — and a claim is
 * made by a PERSON about a merchant that may have no native store at all. A
 * claim surface under `/admin/stores/:storeId` would either exclude every
 * claimant without a store or invent a store to hang them on.
 *
 * Metered on its own `rl:merchant-claims:` bucket — the NETWORK axis of the
 * four the issue names (security control 1). The other three (per user, per
 * merchant, per domain) are durable counts in Postgres, because "how often may
 * this DOMAIN be challenged, across every claimant and every ECS task" is not
 * a question a per-IP bucket can answer.
 *
 * Route ORDER is load-bearing: `/contest` must precede `/:id`, or the
 * parameter route swallows it.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import {
  contestMerchantClaimSchema,
  openMerchantClaimSchema,
  submitMerchantClaimSchema,
  verifyMerchantClaimSchema,
} from '../middleware/merchant-claim-schemas.js';
import {
  contestClaimHandler,
  getMyClaimHandler,
  issueChallengeHandler,
  listMyClaimsHandler,
  openClaimHandler,
  submitClaimHandler,
  verifyClaimHandler,
} from '../controllers/merchant-claims.controller.js';

const router = Router();

router.use(authenticateToken);
router.use(makeRateLimiter('merchant-claims'));

/** POST /merchant-claims/contest — contest an incorrect existing claim. */
router.post('/contest', validateBody(contestMerchantClaimSchema), contestClaimHandler);

/** POST /merchant-claims — open a claim. */
router.post('/', validateBody(openMerchantClaimSchema), openClaimHandler);

/** GET /merchant-claims — the caller's own claims. */
router.get('/', listMyClaimsHandler);

/** GET /merchant-claims/:id — state polling. */
router.get('/:id', getMyClaimHandler);

/** POST /merchant-claims/:id/challenge — issue the one-time challenge. */
router.post('/:id/challenge', issueChallengeHandler);

/** POST /merchant-claims/:id/verify — attempt the proof. */
router.post('/:id/verify', validateBody(verifyMerchantClaimSchema), verifyClaimHandler);

/** POST /merchant-claims/:id/submit — send a document claim to review. */
router.post('/:id/submit', validateBody(submitMerchantClaimSchema), submitClaimHandler);

export default router;
