/**
 * `/internal/backfill/*` — the staged migration's operator surface (#60).
 *
 * The `/internal/matching` shape, on the SAME key
 * (`catalog.operate`): who may reshape the canonical catalogue and
 * who may migrate the native one into it are the same power over the same graph,
 * and a separate key would be another grant to keep in step for no separation
 * it does not already have.
 *
 * A SEPARATE router rather than routes added to `internal-canonical-catalog.ts`,
 * per ADR 0002 D25(a)'s file-ownership protocol — the same reason #56, #57 and
 * #58 each created their own behind this identical gate.
 *
 * Mounted on every deployment; anyone without the key is answered 404, never a
 * 401 that would advertise the surface.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/operator-authz.js';
import {
  backfillFlagsHandler,
  backfillMetricsHandler,
  cancelBackfillRunHandler,
  listBackfillRecordsHandler,
  listBackfillRunsHandler,
  listConsistencyFindingsHandler,
  openBackfillRunHandler,
  runBackfillPageHandler,
  traceBackfillSubjectHandler,
} from '../controllers/backfill-operator.controller.js';

const router = Router();

// Authentication FIRST, then the operator gate — it asks Oxy about the verified
// caller's own session, which only `authenticateToken` establishes.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — every rollout lever's current value, plus the shadow-read counters. */
router.get('/flags', backfillFlagsHandler);

/** GET — throughput, ambiguity, unmatched rate, orphaned offers, dry-run vs apply. */
router.get('/metrics', backfillMetricsHandler);

/** GET — every run of the current mapping version. */
router.get('/runs', listBackfillRunsHandler);

/** POST — open a run (or return the open one covering the same work). */
router.post('/runs', openBackfillRunHandler);

/** POST — run ONE bounded page now. The canary's button. */
router.post('/runs/:id/page', runBackfillPageHandler);

/** POST — stop an open run. A reason is mandatory. */
router.post('/runs/:id/cancel', cancelBackfillRunHandler);

/** GET — one run's per-record report, with the evidence tally beside it. */
router.get('/runs/:id/records', listBackfillRecordsHandler);

/**
 * GET — every stage's verdict on one subject.
 *
 * On its own path segment so neither parameter route swallows the other — the
 * `/internal/matching/subjects/:subjectKey` arrangement, for its reason.
 */
router.get('/subjects/:subjectKey', traceBackfillSubjectHandler);

/** GET — the open two-way consistency findings. */
router.get('/findings', listConsistencyFindingsHandler);

export default router;
