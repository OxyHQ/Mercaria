/**
 * `/internal/search-intent/*` — the operator surface (#95).
 *
 * Behind the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list
 * #54/#56/#57/#58/#60/#62/#68/#70/#78 use, and NOT a seventh: reading how a
 * query was interpreted is the same power over the same graph as reading what a
 * query returns. An empty list means the router is not MOUNTED at all — 404,
 * never 401 — which is the rule every operator surface here follows.
 *
 * It stays mounted while `NL_INTENT_ENABLED` is off, the `/internal/backfill`
 * rule: the evidence has to be readable during the incident that turned the
 * model half off, and the benchmark an operator runs to turn it back on is here.
 *
 * Route ORDER is load-bearing: the two literal collections precede
 * `/turns/:turnId`, so no parameter route can swallow them.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import {
  intentBenchmarkRunSchema,
  intentEnablementSchema,
} from '../middleware/search-intent-schemas.js';
import {
  intentMetricsHandler,
  intentTurnTraceHandler,
  listIntentBenchmarkRunsHandler,
  listIntentEnablementsHandler,
  publishIntentEnablementHandler,
  runIntentBenchmarkHandler,
} from '../controllers/internal-search-intent.controller.js';

const router = Router();

router.use(requireCatalogOperator);
router.use(makeRateLimiter('admin'));

router.get('/metrics', intentMetricsHandler);

router.get('/benchmark-runs', listIntentBenchmarkRunsHandler);
router.post(
  '/benchmark-runs',
  validateBody(intentBenchmarkRunSchema),
  runIntentBenchmarkHandler,
);

router.get('/enablements', listIntentEnablementsHandler);
router.post('/enablements', validateBody(intentEnablementSchema), publishIntentEnablementHandler);

router.get('/turns/:turnId', intentTurnTraceHandler);

export default router;
