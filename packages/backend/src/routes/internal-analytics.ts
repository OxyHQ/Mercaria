/**
 * `/internal/analytics/*` — the discovery-analytics operator surface (#77
 * "Dashboards").
 *
 * The `/internal/payments`, `/internal/commerce-graph` and
 * `/internal/guest-commerce` shape, applied to a FOURTH allow-list: mounted
 * OUTSIDE `/admin` because no store membership could authorize reading what
 * every market searched for; mount gated on the allow-list being non-empty (404
 * on a deployment with no operators, never a 401 that would advertise the
 * surface); the gate repeated in middleware because mount and gate live in
 * different files. Full reasoning: `routes/internal-payments.ts`.
 *
 * Reads, plus the two experiment decisions a person makes. Every other change
 * this domain could want is a recomputation the rollup performs on its own, so
 * an endpoint that forced one would add a way to change a NUMBER without adding
 * a way to change a FACT.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireAnalyticsOperator } from '../middleware/analytics-operator-authz.js';
import {
  getMetricSeriesHandler,
  getQueryReportHandler,
  healthHandler,
  listExperimentsHandler,
  listMetricDefinitionsHandler,
  publishExperimentHandler,
  runRollupNowHandler,
  stopExperimentHandler,
  traceHandler,
} from '../controllers/analytics-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireAnalyticsOperator);

/** Every metric definition — the catalogue a dashboard builds itself from. */
router.get('/metrics', listMetricDefinitionsHandler);

/** One metric's series, WITH its definition attached (acceptance 6). */
router.get('/metrics/:metricKey', getMetricSeriesHandler);

/** The top aggregate queries, above the reporting floor. */
router.get('/queries', getQueryReportHandler);

/** One search's derived events, or one checkout group's conversion answer. */
router.get('/trace', traceHandler);

/** The sink, retention and seam status — the numbers that must be zero. */
router.get('/health', healthHandler);

/** Every experiment version, its guardrails and its exposure counts. */
router.get('/experiments', listExperimentsHandler);

/** Publish a new experiment version, optionally activating it. */
router.post('/experiments', publishExperimentHandler);

/** Stop a running version, recording WHICH condition fired. */
router.post('/experiments/:experimentKey/stop', stopExperimentHandler);

/** Compute the next pending rollup day now. Not a repair — see the controller. */
router.post('/rollup', runRollupNowHandler);

export default router;
