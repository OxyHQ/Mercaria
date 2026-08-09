/**
 * `/internal/retail-eligibility/*` — the retail compliance operator surface
 * (#121 operations 1–8).
 *
 * The `/internal/analytics` shape, on its OWN allow-list
 * (`RETAIL_OPERATOR_OXY_USER_IDS`): approving a resale authorization, verifying
 * a product-safety certificate and LIFTING A RECALL is a compliance power, not
 * a payments one, not a catalogue-curation one, not a cart-diagnostic one and
 * not an analytics one. Sharing a list would grant whichever power the operator
 * was not vetted for, and this is the only one whose misuse puts an unsafe
 * product back on sale.
 *
 * Mount gated on the allow-list being non-empty (404 on a deployment with no
 * operators, never a 401 that would advertise the surface); the gate repeated in
 * middleware because mount and gate live in different files.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireRetailOperator } from '../middleware/retail-operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import {
  retailCategoryRuleSchema,
  retailComplianceEvidenceSchema,
  retailEligibilityExceptionDecisionSchema,
  retailEligibilityExceptionSchema,
  retailEligibilityPolicyCreateSchema,
  retailEligibilityPolicyDecisionSchema,
  retailEligibilityTraceSchema,
  retailEvidenceDecisionSchema,
  retailMarketCapabilitySchema,
  retailResaleEvidenceSchema,
  retailSuppressionLiftSchema,
  retailSuppressionSchema,
} from '../middleware/retail-eligibility-schemas.js';
import {
  activateRetailEligibilityPolicyHandler,
  approveRetailEligibilityExceptionHandler,
  createRetailEligibilityPolicyHandler,
  liftRetailSuppressionHandler,
  listRetailCategoryRulesHandler,
  listRetailEligibilityAuditsHandler,
  listRetailEligibilityExceptionsHandler,
  listRetailEligibilityPoliciesHandler,
  listRetailEvidenceHandler,
  listRetailSuppressionsHandler,
  raiseRetailSuppressionHandler,
  recordComplianceEvidenceHandler,
  recordResaleEvidenceHandler,
  recordRetailCategoryRuleHandler,
  recordRetailMarketCapabilityHandler,
  refuseForbiddenResaleEvidenceBody,
  rejectComplianceEvidenceHandler,
  rejectResaleEvidenceHandler,
  rejectRetailEligibilityExceptionHandler,
  requestRetailEligibilityExceptionHandler,
  retailEligibilityMetricsHandler,
  retireRetailEligibilityPolicyHandler,
  revokeComplianceEvidenceHandler,
  revokeResaleEvidenceHandler,
  revokeRetailEligibilityExceptionHandler,
  traceRetailEligibilityHandler,
  traceRetailEligibilitySubjectHandler,
  verifyComplianceEvidenceHandler,
  verifyResaleEvidenceHandler,
} from '../controllers/retail-eligibility-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireRetailOperator);

/** GET — the eligible-catalogue coverage, blocked checkouts and evidence queue. */
router.get('/metrics', retailEligibilityMetricsHandler);

/** GET — every policy version. */
router.get('/policies', listRetailEligibilityPoliciesHandler);

/** POST — draft a policy version. Drafts are editable; activation freezes them. */
router.post(
  '/policies',
  // BEFORE the schema, deliberately: an enum refuses `affiliate_product_feed`
  // as "invalid enum value", which reads as a typo rather than as an attempt at
  // something ADR 0004 D2.10 forbids. This answers WHY first, and a test pins
  // the message so a remount after the schema fails rather than regressing
  // quietly to the enum's wording.
  refuseForbiddenResaleEvidenceBody,
  validateBody(retailEligibilityPolicyCreateSchema),
  createRetailEligibilityPolicyHandler,
);

/** POST — publish a draft, superseding the incumbent in one transaction. */
router.post(
  '/policies/:id/activate',
  validateBody(retailEligibilityPolicyDecisionSchema),
  activateRetailEligibilityPolicyHandler,
);

/** POST — withdraw a version without a replacement. */
router.post(
  '/policies/:id/retire',
  validateBody(retailEligibilityPolicyDecisionSchema),
  retireRetailEligibilityPolicyHandler,
);

/** GET — one version's category rules and route determinations. */
router.get('/policies/:id/rules', listRetailCategoryRulesHandler);

/** POST — record (or correct) one category's admissibility and requirements. */
router.post(
  '/category-rules',
  validateBody(retailCategoryRuleSchema),
  recordRetailCategoryRuleHandler,
);

/** POST — record (or correct) one route's consumer, commercial and tax answer. */
router.post(
  '/market-capabilities',
  validateBody(retailMarketCapabilitySchema),
  recordRetailMarketCapabilityHandler,
);

/** GET — the expiring-document dashboard and the review queue's counters. */
router.get('/evidence', listRetailEvidenceHandler);

/** POST — file a resale grant. It arrives unverified and authorizes nothing. */
router.post(
  '/resale-evidence',
  validateBody(retailResaleEvidenceSchema),
  recordResaleEvidenceHandler,
);
router.post(
  '/resale-evidence/:id/verify',
  validateBody(retailEvidenceDecisionSchema),
  verifyResaleEvidenceHandler,
);
router.post(
  '/resale-evidence/:id/reject',
  validateBody(retailEvidenceDecisionSchema),
  rejectResaleEvidenceHandler,
);
router.post(
  '/resale-evidence/:id/revoke',
  validateBody(retailEvidenceDecisionSchema),
  revokeResaleEvidenceHandler,
);

/** POST — file a product-safety or regulatory document. */
router.post(
  '/compliance-evidence',
  validateBody(retailComplianceEvidenceSchema),
  recordComplianceEvidenceHandler,
);
router.post(
  '/compliance-evidence/:id/verify',
  validateBody(retailEvidenceDecisionSchema),
  verifyComplianceEvidenceHandler,
);
router.post(
  '/compliance-evidence/:id/reject',
  validateBody(retailEvidenceDecisionSchema),
  rejectComplianceEvidenceHandler,
);
router.post(
  '/compliance-evidence/:id/revoke',
  validateBody(retailEvidenceDecisionSchema),
  revokeComplianceEvidenceHandler,
);

/** GET — every suppression, and which subjects are currently stopped. */
router.get('/suppressions', listRetailSuppressionsHandler);

/** POST — THE emergency stop. A committed row blocks the next derivation. */
router.post(
  '/suppressions',
  validateBody(retailSuppressionSchema),
  raiseRetailSuppressionHandler,
);

/** POST — put a subject back on sale. The row survives; the lift is audited. */
router.post(
  '/suppressions/:id/lift',
  validateBody(retailSuppressionLiftSchema),
  liftRetailSuppressionHandler,
);

/** GET — the exception queue: awaiting a decision, or a second approver. */
router.get('/exceptions', listRetailEligibilityExceptionsHandler);

/** POST — request a waiver over WAIVABLE reasons only. */
router.post(
  '/exceptions',
  validateBody(retailEligibilityExceptionSchema),
  requestRetailEligibilityExceptionHandler,
);
router.post(
  '/exceptions/:id/approve',
  validateBody(retailEligibilityExceptionDecisionSchema),
  approveRetailEligibilityExceptionHandler,
);
router.post(
  '/exceptions/:id/reject',
  validateBody(retailEligibilityExceptionDecisionSchema),
  rejectRetailEligibilityExceptionHandler,
);
router.post(
  '/exceptions/:id/revoke',
  validateBody(retailEligibilityExceptionDecisionSchema),
  revokeRetailEligibilityExceptionHandler,
);

/** POST — the what-if: the exact question a checkout would ask, unrecorded. */
router.post('/trace', validateBody(retailEligibilityTraceSchema), traceRetailEligibilityHandler);

/** GET — the append-only audit trail, filterable by subject. */
router.get('/audits', listRetailEligibilityAuditsHandler);

/** GET — one evidence row or suppression, whole, with its own audit trail. */
router.get('/subjects/:registry/:id', traceRetailEligibilitySubjectHandler);

export default router;
