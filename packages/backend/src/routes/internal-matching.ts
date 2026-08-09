/**
 * `/internal/matching/*` — the matching domain's operator surface (#58).
 *
 * The `/internal/commerce-graph` shape, on the SAME allow-list
 * (`CATALOG_OPERATOR_OXY_USER_IDS`): who may reshape the canonical catalogue and
 * who may decide that two things are one thing are the same power over the same
 * graph, and a fifth list beside payments, catalog, offers and guest would be a
 * fifth thing to keep in step for no separation it does not already have.
 *
 * A SEPARATE router rather than routes added to `internal-canonical-catalog.ts`,
 * per ADR 0002 D25(a)'s file-ownership protocol — the same reason #56 and #57
 * each created their own behind this identical gate.
 *
 * Mount gated on the allow-list being non-empty (404 on a deployment with no
 * operators, never a 401 that would advertise the surface); the gate repeated in
 * middleware because mount and gate live in different files.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import {
  clearBlockedPairSchema,
  closeCategoryGateSchema,
  createMatchPolicySchema,
  evaluateSubjectSchema,
  openCategoryGateSchema,
  rejectMatchPairSchema,
  reviewMatchDecisionSchema,
  runMatchSweepSchema,
} from '../middleware/matching-schemas.js';
import {
  activateMatchPolicyHandler,
  clearBlockedPairHandler,
  closeCategoryGateHandler,
  createMatchPolicyHandler,
  drainMatchQueueHandler,
  evaluateSubjectHandler,
  listBenchmarkRunsHandler,
  listMatchPoliciesHandler,
  listMatchReviewsHandler,
  matchMetricsHandler,
  openCategoryGateHandler,
  rejectMatchPairHandler,
  reviewMatchDecisionHandler,
  runMatchSweepHandler,
  traceMatchDecisionHandler,
  traceMatchSubjectHandler,
} from '../controllers/matching-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — queue age, ambiguity rate and the sweeps' cursors (operations 5). */
router.get('/metrics', matchMetricsHandler);

/** GET — the review inbox #59 inherits. */
router.get('/reviews', listMatchReviewsHandler);

/** GET — every recorded benchmark run and the newest run's slices. */
router.get('/benchmarks', listBenchmarkRunsHandler);

/** GET — every policy version, plus the active one's open category gates. */
router.get('/policies', listMatchPoliciesHandler);

/** POST — draft a policy version. Drafts are editable; activation freezes them. */
router.post('/policies', validateBody(createMatchPolicySchema), createMatchPolicyHandler);

/** POST — activate a draft, superseding the incumbent in one transaction. */
router.post('/policies/:id/activate', activateMatchPolicyHandler);

/** POST — enable automatic matching for one category, citing its benchmark. */
router.post('/gates', validateBody(openCategoryGateSchema), openCategoryGateHandler);

/** POST — disable it. Attributable and reasoned, by CHECK. */
router.post(
  '/gates/:id/close',
  validateBody(closeCategoryGateSchema),
  closeCategoryGateHandler,
);

/** POST — record that a pair is wrong, so it is never proposed again. */
router.post('/blocked-pairs', validateBody(rejectMatchPairSchema), rejectMatchPairHandler);

/** POST — lift a rejection because evidence changed. */
router.post(
  '/blocked-pairs/:id/clear',
  validateBody(clearBlockedPairSchema),
  clearBlockedPairHandler,
);

/** POST — evaluate ONE subject now, instead of waiting for the dispatcher. */
router.post('/evaluate', validateBody(evaluateSubjectSchema), evaluateSubjectHandler);

/** POST — drain one queue batch now. */
router.post('/drain', drainMatchQueueHandler);

/** POST — enqueue one bounded page of a bulk re-evaluation. */
router.post('/sweep', validateBody(runMatchSweepSchema), runMatchSweepHandler);

/**
 * GET — every decision ever made about one subject.
 *
 * BEFORE `/decisions/:id`, and on its own path segment, so neither parameter
 * route swallows the other.
 */
router.get('/subjects/:subjectKey', traceMatchSubjectHandler);

/** GET — one decision, every candidate it considered, and its open blocks. */
router.get('/decisions/:id', traceMatchDecisionHandler);

/** POST — answer one review. `approved` or `rejected`, and nothing else. */
router.post(
  '/decisions/:id/review',
  validateBody(reviewMatchDecisionSchema),
  reviewMatchDecisionHandler,
);

export default router;
