/**
 * `/internal/retail-reconciliation/*` — the zero-profit cost reconciliation
 * operator surface (#128 "Operator surface").
 *
 * ## On the SIXTH allow-list, and deliberately not the fifth
 *
 * `PROCUREMENT_OPERATOR_OXY_USER_IDS`, the list #122, #124 and #125 use. This
 * surface shows the supplier invoice by component, the final supplier item cost
 * and every supplier credit — Mercaria's wholesale cost base, which is the exact
 * power `procurement-operator-authz.ts` says that list exists for and which no
 * other list holds.
 *
 * `RETAIL_OPERATOR_OXY_USER_IDS` (the fifth) is the COMPLIANCE list: recalls,
 * eligibility policy versions, document verification. Mounting a wholesale-cost
 * read on it would widen what a compliance reviewer can see, and its own
 * docblock is explicit that "a compliance reviewer vetted to verify a
 * product-safety certificate is not thereby vetted to see Mercaria's cost base".
 *
 * Mount gated on the allow-list being non-empty (404 on a deployment with no
 * operators, never a 401 that would advertise the surface); the gate repeated in
 * middleware because the mount and the gate live in different files.
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
import { requireProcurementOperator } from '../middleware/procurement-operator-authz.js';
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

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
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
