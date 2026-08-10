/**
 * `/internal/search/*` — the search domain's operator surface (#70).
 *
 * On the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#55/#56/#57/#58/
 * #60/#62/#68 use, and deliberately not a seventh list: reading what a query
 * returns and how a rollout is going is the same power over the same graph as
 * reshaping the catalogue, and a new list would be another thing to keep in
 * step for a separation it does not have.
 *
 * A separate ROUTER from `internal-canonical-catalog.ts`, per ADR 0002 D25(a)'s
 * file-ownership protocol — the reason #57 and #62 each created their own
 * behind this identical gate.
 *
 * Mounted while the public search lever is OFF, the `/internal/backfill` rule:
 * the rollout evidence has to be readable during the incident that turned the
 * surface off, and a shadow run is inspected precisely while shoppers see
 * nothing.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import { searchExplainBodySchema } from '../middleware/search-schemas.js';
import {
  searchExplainHandler,
  searchShadowMetricsHandler,
} from '../controllers/search-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — the shadow comparison counters and the lever they were taken under. */
router.get('/shadow', searchShadowMetricsHandler);

/** POST — what one query returns right now, with its full pipeline trace. */
router.post('/explain', validateBody(searchExplainBodySchema), searchExplainHandler);

export default router;
