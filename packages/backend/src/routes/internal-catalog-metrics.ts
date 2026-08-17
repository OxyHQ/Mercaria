/**
 * `/internal/catalog-metrics` — the catalog observability operator surface
 * (#367 W16/W17).
 *
 * ## The same allow-list, not a seventh
 *
 * `CATALOG_OPERATOR_OXY_USER_IDS`, which #54/#55/#56/#57/#58/#60/#62/#68/#70/#78
 * and the eleven #367 domains already use. Reading how much of the catalogue is
 * translated is not a different power from publishing a taxonomy change, and a
 * new list would have to be granted to the same people, drift from it, and become
 * the one somebody forgets when an operator leaves. Empty list ⇒ **not mounted**
 * (404, never 401).
 *
 * ## The route set is CLOSED and read-only
 *
 * Four GETs and nothing else. There is deliberately no "recompute", no "clear
 * this counter", no "resolve this finding" and no repair of any kind:
 *
 * - Every integrity check is a DETECTION whose subject can legitimately be
 *   mid-migration — a category suppressed for a cutover, a redirect staged ahead
 *   of one — so a repair here would be a way to make the catalogue agree with a
 *   dashboard. That is the `payment_discrepancies` posture and this domain has no
 *   reason to diverge from it.
 * - A clearable counter is a counter that means nothing. `mustStayZero` is
 *   process-local precisely so its non-zero value survives until somebody looks;
 *   an endpoint that zeroed it would be a way to close an incident without fixing
 *   it.
 *
 * The closure is asserted twice, from both sides. `contract-gates.test.ts` reads
 * the registered set off this router's own stack and asserts it EXACTLY rather
 * than by containment, so a fifth route is a build failure and a decision.
 * `routes/__tests__/internal-catalog-metrics.test.ts` asserts the same closure
 * from OUTSIDE, over HTTP on the mounted app, which additionally catches a write
 * handler mounted under this prefix by anything other than this file — and covers
 * the gate itself: allow-listed passes, non-operator 403, the payments list does
 * not open it, and an EMPTY list is 404 from the mount rather than 401.
 *
 * ## Why this is a separate router from `/internal/catalog-governance`
 *
 * That surface already answers `GET /queues` and `GET /quality`, and this domain
 * CONSUMES both rather than re-deriving them. They are kept apart because they
 * are different questions with different owners: governance answers "what does
 * the catalogue contain and who changed it", and this answers "is the machinery
 * that maintains it working". Folding them together would put a metrics read
 * behind a change-request surface's rate limit and make either one's route set
 * impossible to assert.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import {
  catalogIntegrityHandler,
  catalogLatencyHandler,
  catalogMetricsHandler,
  catalogPublicationTraceHandler,
} from '../controllers/catalog-metrics.controller.js';

const router = Router();

// Order is load-bearing: the operator gate needs a verified caller, so
// `authenticateToken` runs first.
//
// NO rate limiter, which matches every sibling on this allow-list
// (`/internal/catalog-governance`, `/internal/matching`, `/internal/search`,
// `/internal/catalog-attributes` — none of them mounts one). The bound here is
// the allow-list itself: the caller set is a handful of named Oxy accounts, so a
// per-IP bucket would be one bucket for the whole operator team and the first
// real incident — when several of them are refreshing these reads at once — is
// exactly when it would trip. `/internal/payments` does mount one because its
// surface can MOVE MONEY; this one is four read-only GETs.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** Every defined metric, each `measured` or `unmeasured` with a named seam. */
router.get('/', catalogMetricsHandler);

/**
 * The six periodic integrity checks.
 *
 * There is no sweep loop in this domain: this is the route a scheduled probe
 * calls, and its cadence is `oxy-infra`'s configuration rather than a constant
 * compiled into the image — the same division that keeps scraping and alerting
 * out of this repository.
 */
router.get('/integrity', catalogIntegrityHandler);

/** The W16 latency budgets against what this task has observed. */
router.get('/latency', catalogLatencyHandler);

/**
 * One publication, hop by hop.
 *
 * Opens from a draft id or a listing id and nothing else — the handle kind is a
 * two-member closed set checked before any read, so "every draft this merchant
 * started" is unaskable rather than refused.
 */
router.get('/trace/:handleKind/:handle', catalogPublicationTraceHandler);

export default router;
