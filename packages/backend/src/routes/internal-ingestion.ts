/**
 * `/internal/ingestion/*` — the external ingestion framework's operator surface
 * (#62).
 *
 * The `/internal/backfill` shape, on the SAME allow-list
 * (`CATALOG_OPERATOR_OXY_USER_IDS`): who may reshape the canonical catalogue,
 * who may migrate the native one into it and who may decide what an external
 * source is permitted to do are the same power over the same graph. A sixth
 * list beside payments, catalog, guest, analytics and retail would be a sixth
 * thing to keep in step for no separation it does not already have.
 *
 * A SEPARATE router rather than routes added to `internal-commerce-graph.ts`,
 * per ADR 0002 D25(a)'s file-ownership protocol — the same reason #56, #57, #58
 * and #60 each created their own behind this identical gate.
 *
 * Mount gated on the allow-list being non-empty (404 on a deployment with no
 * operators, never a 401 that would advertise the surface); the gate repeated in
 * middleware because mount and gate live in different files.
 *
 * **It stays mounted while `CATALOG_INGESTION_ENABLED` is off**, deliberately
 * and for `/internal/backfill`'s reason: the evidence has to be readable during
 * the incident that turned the loop off, and configuring a source, reviewing
 * its terms and draining it by hand is how a feed is brought up before the loop
 * is switched on at all.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import {
  changeSourceStatusHandler,
  configureSourceHandler,
  drainIngestionHandler,
  getIngestionSourceHandler,
  listIngestionSourcesHandler,
  listSourcePoliciesHandler,
  listSourceRejectionsHandler,
  listSourceRunsHandler,
  openSourceRunHandler,
  publishSourcePolicyHandler,
  releaseQuarantineHandler,
  sourceMetricsHandler,
  traceSourceObjectHandler,
} from '../controllers/ingestion-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — every configured source, its health, and which providers ship adapters. */
router.get('/sources', listIngestionSourcesHandler);

/** POST — register or reconfigure a source. It permits nothing until reviewed. */
router.post('/sources', configureSourceHandler);

/** POST — drive one dispatcher tick now. The same two steps the loop performs. */
router.post('/drain', drainIngestionHandler);

/** GET — one source with its effective rights. */
router.get('/sources/:sourceId', getIngestionSourceHandler);

/** GET — every rights/terms version this source has ever had. */
router.get('/sources/:sourceId/policies', listSourcePoliciesHandler);

/** POST — publish and activate a rights version, superseding the last. */
router.post('/sources/:sourceId/policies', publishSourcePolicyHandler);

/** POST — move the lifecycle. A reason is mandatory. */
router.post('/sources/:sourceId/status', changeSourceStatusHandler);

/** GET — the ten measurements, with the evidence cross-check beside them. */
router.get('/sources/:sourceId/metrics', sourceMetricsHandler);

/** GET — this source's passes, newest first. */
router.get('/sources/:sourceId/runs', listSourceRunsHandler);

/** POST — open a MANUAL pass. Absent `since` asks for a full enumeration. */
router.post('/sources/:sourceId/runs', openSourceRunHandler);

/**
 * GET — one external object's whole history.
 *
 * On its own path segment so neither parameter route swallows the other — the
 * `/internal/backfill/subjects/:subjectKey` arrangement, for its reason.
 */
router.get('/sources/:sourceId/objects/trace', traceSourceObjectHandler);

/** GET — the rejection residual: what this source published that was refused. */
router.get('/sources/:sourceId/rejections', listSourceRejectionsHandler);

/** POST — let a quarantined object back into the pipeline. */
router.post('/objects/:objectId/release', releaseQuarantineHandler);

export default router;
