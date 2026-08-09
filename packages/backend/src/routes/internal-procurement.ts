/**
 * `/internal/procurement/*` — the supplier-order operations surface (#124
 * observability and operations).
 *
 * The `/internal/supplier-preflight` shape, on the SAME sixth allow-list
 * (`PROCUREMENT_OPERATOR_OXY_USER_IDS`) and deliberately not a seventh: reading
 * what Mercaria pays a supplier and acting on a supplier order are one power,
 * and splitting them would create a list to keep in sync with no distinction to
 * justify it.
 *
 * Mount gated on the allow-list being non-empty (404 on a deployment with no
 * operators, never a 401 that would advertise the surface); the gate repeated
 * in middleware because mount and gate live in different files.
 *
 * The surface stays mounted while every procurement lever is OFF, and that is
 * deliberate: the evidence has to be readable during the incident that turned
 * them off — the `/internal/backfill` and `/internal/ingestion` rule.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireProcurementOperator } from '../middleware/procurement-operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import { procurementExceptionResolutionSchema } from '../middleware/procurement-schemas.js';
import {
  procurementCancelHandler,
  procurementMetricsHandler,
  procurementQueuesHandler,
  procurementResolveExceptionHandler,
  procurementSubmitHandler,
  procurementTraceHandler,
} from '../controllers/procurement-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireProcurementOperator);

/** GET — submission latency and acceptance, ambiguity, lag, exceptions, refusals. */
router.get('/metrics', procurementMetricsHandler);

/** GET — open conditions and dead-lettered jobs, read from where they already live. */
router.get('/queues', procurementQueuesHandler);

/** GET — one purchase order's whole procurement trace. Opens from its id alone. */
router.get('/purchase-orders/:purchaseOrderId', procurementTraceHandler);

/** POST — enqueue the deterministic submission job. A second click claims the same row. */
router.post('/purchase-orders/:purchaseOrderId/submit', procurementSubmitHandler);

/** POST — open a durable cancellation request and enqueue its delivery. */
router.post('/purchase-orders/:purchaseOrderId/cancel', procurementCancelHandler);

/** POST — close one exception, attributably. The one mutation of a stored fact. */
router.post(
  '/exceptions/:exceptionId/resolve',
  validateBody(procurementExceptionResolutionSchema),
  procurementResolveExceptionHandler,
);

export default router;
