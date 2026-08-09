/**
 * `/internal/offer-freshness/*` — the source-aware refresh, expiry and
 * catalogue-health operator surface (#68).
 *
 * The `/internal/ingestion` shape, on the SAME allow-list
 * (`CATALOG_OPERATOR_OXY_USER_IDS`): who may decide what an external source is
 * permitted to do and who may decide how long its facts are worth showing are
 * the same power over the same graph. A seventh list beside payments, catalog,
 * guest, analytics, retail and procurement would be a seventh thing to keep in
 * step for no separation it does not already have.
 *
 * A SEPARATE router rather than routes added to `internal-ingestion.ts`, per
 * ADR 0002 D25(a)'s file-ownership protocol — the same reason #56, #57, #58,
 * #60 and #62 each created their own behind this identical gate.
 *
 * **It stays mounted while `OFFER_REFRESH_ENABLED` is off**, deliberately and
 * for `/internal/ingestion`'s reason: publishing a source's freshness policy,
 * reading its quarantine board and draining it by hand is how a feed is brought
 * up before the loop is switched on, and the evidence has to be readable during
 * the incident that turned the loop off.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import {
  drainOfferFreshnessHandler,
  listFreshnessPoliciesHandler,
  listQuarantinesHandler,
  listRefreshTasksHandler,
  publishFreshnessPolicyHandler,
  releaseQuarantineHandler,
  requestRefreshHandler,
  sourceCatalogHealthHandler,
} from '../controllers/offer-freshness-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** POST — drive one refresh tick and one expiry sweep now. The loops' own bodies. */
router.post('/drain', drainOfferFreshnessHandler);

/** GET — one source's catalogue health: everything #68 §"Source health" lists. */
router.get('/sources/:sourceId/health', sourceCatalogHealthHandler);

/** GET — every freshness version this source has ever had. */
router.get('/sources/:sourceId/policies', listFreshnessPoliciesHandler);

/** POST — publish and activate a freshness version, superseding the last. */
router.post('/sources/:sourceId/policies', publishFreshnessPolicyHandler);

/** GET — this source's refresh queue, most urgent first. */
router.get('/sources/:sourceId/tasks', listRefreshTasksHandler);

/** POST — ask for a whole-source pass, or a targeted re-read of one object. */
router.post('/sources/:sourceId/refresh', requestRefreshHandler);

/** GET — this source's OPEN quarantine findings. */
router.get('/sources/:sourceId/quarantines', listQuarantinesHandler);

/**
 * POST — publish a quarantined run's output after all.
 *
 * On its own path segment rather than under the source, because a release is
 * about ONE finding and an operator reaching for it has its id from the board.
 * Routing it through a source would let a mistyped source id silently release
 * nothing, which reads as success.
 */
router.post('/quarantines/:quarantineId/release', releaseQuarantineHandler);

export default router;
