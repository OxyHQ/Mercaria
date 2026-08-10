/**
 * `/internal/price-signals/*` — the price-signal operator surface (#82
 * §"Monitoring").
 *
 * On the SAME allow-list (`CATALOG_OPERATOR_OXY_USER_IDS`) every other catalogue
 * surface uses, and deliberately NOT a seventh list beside payments, catalog,
 * guest, analytics, retail and procurement: deciding what "good price" MEANS is
 * the same power over the same graph as deciding which offers exist and in what
 * order they appear, which is `/internal/offers`' and `/internal/ranking`'s.
 *
 * A SEPARATE router from `internal-price-history.ts` rather than routes added to
 * it, per ADR 0002 D25(a)'s file-ownership protocol: an observation store and a
 * claim about what those observations MEAN are two lifecycles over one graph.
 *
 * Mounted while `PRICE_SIGNALS_ENABLED` is off and while nothing is published,
 * because a deployment with no active policy version is exactly when somebody
 * needs to publish one — and because the evidence has to be readable during the
 * incident that turned the sweep off.
 *
 * ## The route set is CLOSED, and four absences are the point
 *
 * There is no "set this label", no "hide this observation", no "pin this price"
 * and no "suppress this signal". Every one of those would be a way to make a
 * price signal say something nobody measured, which is the single property that
 * makes it worth publishing — #78's operator surface makes the same three
 * refusals for the same reason. What an operator can do is publish a policy
 * version, activate one (which is also the rollback), queue a measurement, read
 * what it found, and answer a merchant's correction report.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  priceSignalFeedbackCloseSchema,
  priceSignalListQuerySchema,
  priceSignalPolicyActionSchema,
  priceSignalPolicyCreateSchema,
  priceSignalRunCreateSchema,
} from '../middleware/price-signal-schemas.js';
import {
  activatePriceSignalPolicyHandler,
  archivePriceSignalPolicyHandler,
  closePriceSignalFeedbackHandler,
  createPriceSignalPolicyHandler,
  createPriceSignalRunHandler,
  listPriceSignalPoliciesHandler,
  listPriceSignalRunsHandler,
  priceSignalFeedbackQueueHandler,
  priceSignalRunMetricsHandler,
  priceSignalSubjectTraceHandler,
} from '../controllers/price-signals.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — every version of the signal policy, newest first. */
router.get('/policies', validateQuery(priceSignalListQuerySchema), listPriceSignalPoliciesHandler);

/** POST — publish a DRAFT. It defines nothing until it is activated. */
router.post('/policies', validateBody(priceSignalPolicyCreateSchema), createPriceSignalPolicyHandler);

/** POST — promote a version, or ROLL BACK by activating an earlier one. */
router.post(
  '/policies/:id/activate',
  validateBody(priceSignalPolicyActionSchema),
  activatePriceSignalPolicyHandler,
);

/** POST — retire a draft or a superseded version. Never a delete. */
router.post(
  '/policies/:id/archive',
  validateBody(priceSignalPolicyActionSchema),
  archivePriceSignalPolicyHandler,
);

/** GET — the measurement runs and their counters. */
router.get('/runs', validateQuery(priceSignalListQuerySchema), listPriceSignalRunsHandler);

/** POST — queue one sweep, under a named policy version and a named cohort. */
router.post('/runs', validateBody(priceSignalRunCreateSchema), createPriceSignalRunHandler);

/** GET — coverage, the insufficient-data rate, the label distribution, the mass-change diff. */
router.get('/runs/:id/metrics', priceSignalRunMetricsHandler);

/** GET — one subject's recorded evaluations. Opens from a SUBJECT KEY and nothing else. */
router.get('/subjects/:subjectKey', priceSignalSubjectTraceHandler);

/** GET — the open correction reports and their summary by reason and outcome. */
router.get('/feedback', validateQuery(priceSignalListQuerySchema), priceSignalFeedbackQueueHandler);

/** POST — resolve or reject a correction report, attributably. */
router.post(
  '/feedback/:id/close',
  validateBody(priceSignalFeedbackCloseSchema),
  closePriceSignalFeedbackHandler,
);

export default router;
