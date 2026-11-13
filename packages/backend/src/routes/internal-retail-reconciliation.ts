/**
 * `/internal/retail-reconciliation/*` — the zero-profit cost reconciliation
 * operator surface (#128 "Operator surface").
 *
 * ## On the SIXTH key, and deliberately not the fifth
 *
 * `procurement.operate`, the key #122, #124 and #125 use. This
 * surface shows the supplier invoice by component, the final supplier item cost
 * and every supplier credit — Mercaria's wholesale cost base, which is the exact
 * power `middleware/operator-authz.ts` says that key exists for and which no
 * other key grants.
 *
 * `retail.operate` (the fifth) is the COMPLIANCE key: recalls,
 * eligibility policy versions, document verification. Mounting a wholesale-cost
 * read on it would widen what a compliance reviewer can see, and a compliance
 * reviewer vetted to verify a product-safety certificate is not thereby vetted
 * to see Mercaria's cost base.
 *
 * Mounted on every deployment; anyone without the key is answered 404, never a
 * 401 that would advertise the surface.
 *
 * The surface stays mounted while `RETAIL_RECONCILIATION_ENABLED` is off, and
 * that is deliberate: the evidence has to be readable during the incident that
 * turned the sweep off — the `/internal/backfill` and `/internal/procurement`
 * rule.
 *
 * ## READ, plus a CLOSED set of three writes
 *
 * Each write drives a path the sweep already runs on its own, so this adds a
 * trigger and no new way to move money. There is deliberately no "set this
 * variance", no "waive this adjustment", no "override this cost", no "mark this
 * reconciled" and no delete — every one would be a second, unreviewed write into
 * the financial record, and `retail-reconciliation-isolation.test.ts` enumerates
 * the registered routes EXACTLY so one cannot be added quietly.
 */

import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth.js';
import { requireProcurementOperator } from '../middleware/operator-authz.js';
import { validateBody, validateId } from '../middleware/validate.js';
import {
  listOpenAdjustmentsHandler,
  listReconciliationExceptionsHandler,
  reconcileRetailOrderHandler,
  resolveReconciliationExceptionHandler,
  retailReconciliationMetricsHandler,
  retailReconciliationTraceHandler,
  retryAdjustmentRefundHandler,
} from '../controllers/retail-reconciliation-operator.controller.js';

const router = Router();

// Authentication FIRST, then the operator gate — it asks Oxy about the verified
// caller's own session, which only `authenticateToken` establishes.
router.use(authenticateToken);
router.use(requireProcurementOperator);

/**
 * Every write body is `.strict()` and carries a MANDATORY reason.
 *
 * `.strict()` for `checkoutSchema`'s reason, sharpened here: a body able to
 * carry an unrecognised key is where an amount, an outcome or an account
 * eventually arrives on the one surface that touches reconciled money. The
 * reason is mandatory because the audit row's whole value is that it says WHY,
 * and an optional field is one nobody fills in.
 */
const operatorActionSchema = z.object({ reason: z.string().min(1).max(2_000) }).strict();

/** GET — the twelve items of #128's reconciliation view for one order. */
router.get('/orders/:orderId', validateId('orderId'), retailReconciliationTraceHandler);

/** GET — the open exception queue: missing evidence and mismatches. */
router.get('/exceptions', listReconciliationExceptionsHandler);

/** GET — what is still owed to buyers. */
router.get('/adjustments', listOpenAdjustmentsHandler);

/** GET — the ten metrics, each with the definition that makes it readable. */
router.get('/metrics', retailReconciliationMetricsHandler);

/** POST — run the sweep's own reconciliation for one order, now. */
router.post(
  '/orders/:orderId/reconcile',
  validateId('orderId'),
  validateBody(operatorActionSchema),
  reconcileRetailOrderHandler,
);

/** POST — drive the same idempotent refund the sweep drives. */
router.post(
  '/adjustments/:id/retry-refund',
  validateId('id'),
  validateBody(operatorActionSchema),
  retryAdjustmentRefundHandler,
);

/** POST — close a recording, attributably. */
router.post(
  '/exceptions/:id/resolve',
  validateId('id'),
  validateBody(operatorActionSchema),
  resolveReconciliationExceptionHandler,
);

export default router;
