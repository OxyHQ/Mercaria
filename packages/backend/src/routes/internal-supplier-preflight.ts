/**
 * `/internal/supplier-preflight/*` — the supply-operations surface (#122
 * operations 1–8).
 *
 * The `/internal/retail-eligibility` shape, on its OWN allow-list
 * (`PROCUREMENT_OPERATOR_OXY_USER_IDS`): reading Mercaria's wholesale cost base
 * and flipping a market kill switch are supply-operations powers, not
 * compliance, payments, catalogue, cart-diagnostic or analytics ones. Sharing a
 * list would grant whichever power the operator was not vetted for.
 *
 * Mount gated on the allow-list being non-empty (404 on a deployment with no
 * operators, never a 401 that would advertise the surface); the gate repeated
 * in middleware because mount and gate live in different files.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireProcurementOperator } from '../middleware/procurement-operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import {
  supplierPreflightSweepSchema,
  supplierSourcingPolicyCreateSchema,
  supplierSourcingPolicyDecisionSchema,
  supplierSuppressionLiftSchema,
  supplierSuppressionSchema,
} from '../middleware/supplier-preflight-schemas.js';
import {
  activateSupplierSourcingPolicyHandler,
  createSupplierSourcingPolicyHandler,
  liftSupplierSuppressionHandler,
  listSupplierSourcingPoliciesHandler,
  listSupplierSuppressionsHandler,
  raiseSupplierSuppressionHandler,
  refuseForbiddenSourcingSignalBody,
  retireSupplierSourcingPolicyHandler,
  runSupplierPreflightSweepHandler,
  supplierAccountHealthHandler,
  supplierPreflightMetricsHandler,
  supplierQuoteTraceHandler,
  supplierSourcingTraceHandler,
} from '../controllers/supplier-preflight-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireProcurementOperator);

/** GET — quote latency, failure, expiry, stock discrepancy, provider health. */
router.get('/metrics', supplierPreflightMetricsHandler);

/** GET — one supplier account's health verdict and live provider quota. */
router.get('/accounts/:accountId/health', supplierAccountHealthHandler);

/** GET — one quote, with the destination coarse and the hold id redacted. */
router.get('/quotes/:quoteId', supplierQuoteTraceHandler);

/** GET — one checkout group's whole sourcing trail. No buyer handle opens it. */
router.get('/traces/:checkoutGroupId', supplierSourcingTraceHandler);

/** GET — every sourcing policy version. */
router.get('/policies', listSupplierSourcingPoliciesHandler);

/** POST — draft a sourcing policy version. Drafts are editable; activation freezes them. */
router.post(
  '/policies',
  // BEFORE the schema, deliberately: `.strict()` refuses
  // `affiliateCommissionWeight` as "unrecognized key", which reads as a typo
  // rather than as an attempt at something #122 selection 3 forbids. This
  // answers WHY first, and a test pins the message so a remount after the
  // schema fails rather than regressing quietly to the schema's wording.
  refuseForbiddenSourcingSignalBody,
  validateBody(supplierSourcingPolicyCreateSchema),
  createSupplierSourcingPolicyHandler,
);

/** POST — publish a draft, superseding the incumbent in one transaction. */
router.post(
  '/policies/:id/activate',
  validateBody(supplierSourcingPolicyDecisionSchema),
  activateSupplierSourcingPolicyHandler,
);

/** POST — withdraw a version without a replacement. */
router.post(
  '/policies/:id/retire',
  validateBody(supplierSourcingPolicyDecisionSchema),
  retireSupplierSourcingPolicyHandler,
);

/** GET — every suppression, live by default. */
router.get('/suppressions', listSupplierSuppressionsHandler);

/** POST — THE kill switch. Always an operator origin; the body cannot claim otherwise. */
router.post(
  '/suppressions',
  validateBody(supplierSuppressionSchema),
  raiseSupplierSuppressionHandler,
);

/** POST — put a route back into service. The row survives; the lift is audited. */
router.post(
  '/suppressions/:id/lift',
  validateBody(supplierSuppressionLiftSchema),
  liftSupplierSuppressionHandler,
);

/** POST — run one sweep pass now. Adds no capability the timer does not have. */
router.post(
  '/sweep',
  validateBody(supplierPreflightSweepSchema),
  runSupplierPreflightSweepHandler,
);

export default router;
