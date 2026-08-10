/**
 * `/internal/ranking/*` — the ranking domain's operator surface (#74).
 *
 * On the SAME allow-list (`CATALOG_OPERATOR_OXY_USER_IDS`) every other catalogue
 * surface uses, and deliberately not a seventh list beside payments, catalog,
 * guest, analytics, retail and procurement: deciding what order a product's
 * offers appear in is the same power over the same graph as deciding which
 * offers exist, which is `/internal/offers`'.
 *
 * A SEPARATE router from `internal-offers.ts` rather than routes added to it,
 * per ADR 0002 D25(a)'s file-ownership protocol — #68's `/internal/offer-freshness`
 * made the same split for the same reason: two lifecycles over one graph, moving
 * at their own rates.
 *
 * Mounted while nothing is published: a deployment ranking under the built-in
 * policy is exactly when somebody needs to read what the built-in policy IS, and
 * gating this on having published one would make publishing the first impossible
 * to prepare for.
 *
 * SIX routes, and the set is closed. There is no "boost", no "pin", no "hide"
 * and no "set rank" — see `ranking-operator.controller.ts` for why those four
 * absences are the point rather than an omission.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  rankingComparisonQuerySchema,
  rankingPolicyActivateSchema,
  rankingPolicyCanarySchema,
  rankingPolicyCreateSchema,
  rankingTraceQuerySchema,
} from '../middleware/ranking-schemas.js';
import {
  activateRankingPolicyHandler,
  archiveRankingPolicyHandler,
  canaryRankingPolicyHandler,
  compareRankingPoliciesHandler,
  createRankingPolicyHandler,
  listRankingPoliciesHandler,
  stopRankingCanaryHandler,
  traceRankingHandler,
} from '../controllers/ranking-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — one comparison in full, including what eligibility refused and why. */
router.get('/trace', validateQuery(rankingTraceQuerySchema), traceRankingHandler);

/** GET — two policy versions over ONE eligible set, and the diff between them. */
router.get('/compare', validateQuery(rankingComparisonQuerySchema), compareRankingPoliciesHandler);

/** GET — the key's versions, plus the built-in one every impression may name. */
router.get('/policies', listRankingPoliciesHandler);

/** POST — publish a DRAFT. It serves nobody until it is ramped or activated. */
router.post('/policies', validateBody(rankingPolicyCreateSchema), createRankingPolicyHandler);

/** POST — start or ramp a canary over comparison SUBJECTS, never over people. */
router.post(
  '/policies/:id/canary',
  validateBody(rankingPolicyCanarySchema),
  canaryRankingPolicyHandler,
);

/** DELETE — stop a canary without promoting it. */
router.delete('/policies/:id/canary', stopRankingCanaryHandler);

/** POST — promote a version, or ROLL BACK by activating an earlier one. */
router.post(
  '/policies/:id/activate',
  validateBody(rankingPolicyActivateSchema),
  activateRankingPolicyHandler,
);

/** POST — retire a draft or a superseded version. Never a delete. */
router.post(
  '/policies/:id/archive',
  validateBody(rankingPolicyActivateSchema),
  archiveRankingPolicyHandler,
);

export default router;
