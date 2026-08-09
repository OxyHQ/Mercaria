/**
 * The retail eligibility operator surface (#121 operations 1–8).
 *
 * Lives under `/internal/retail-eligibility/*` behind `requireRetailOperator`
 * — a FIFTH allow-list, because approving a resale authorization, verifying a
 * product-safety certificate and lifting a RECALL is a compliance power and not
 * a payments, catalogue, cart-diagnostic or analytics one.
 *
 * Nothing in this file can make an offer eligible directly. Every handler
 * writes DATA the derivation reads — a policy version, a category rule, a route
 * determination, an evidence row, a suppression, an exception — and every one
 * of them writes an audit row naming the operator and their reason, refusals
 * included.
 */

import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/postgres.js';
import {
  listRetailCategoryRules,
  listRetailEligibilityPolicies,
  listRetailMarketCapabilities,
  findRetailEligibilityPolicyById,
  type RetailEligibilityPolicyRecord,
} from '../db/retailEligibility/policyRepository.js';
import {
  countRetailEvidenceByState,
  findRetailComplianceEvidenceById,
  findRetailResaleEvidenceById,
  listExpiringRetailEvidence,
  listRetailResaleEvidence,
} from '../db/retailEligibility/evidenceRepository.js';
import {
  listRetailSuppressions,
  findRetailSuppressionById,
} from '../db/retailEligibility/suppressionRepository.js';
import { listRetailEligibilityExceptions } from '../db/retailEligibility/exceptionRepository.js';
import {
  listBlockedCheckoutDecisions,
  listRetailEligibilityAudits,
  listRetailEligibilityDecisionsForOffer,
  measureRetailEligibility,
} from '../db/retailEligibility/decisionRepository.js';
import {
  activateRetailEligibilityPolicyVersion,
  assertRetailPolicyEvidenceIsSufficient,
  draftRetailEligibilityPolicy,
  recordRetailCategoryRule,
  recordRetailMarketCapability,
  retireRetailEligibilityPolicyVersion,
  toRetailEligibilityPolicySummary,
} from '../services/retail-eligibility/policy.service.js';
import {
  recordComplianceEvidence,
  recordResaleEvidence,
  rejectComplianceEvidence,
  rejectResaleEvidence,
  revokeComplianceEvidence,
  revokeResaleEvidence,
  verifyComplianceEvidence,
  verifyResaleEvidence,
} from '../services/retail-eligibility/evidence.service.js';
import {
  liftRetailSuppressionAudited,
  raiseRetailSuppressionAudited,
  scanRetailSuppressionImpact,
} from '../services/retail-eligibility/recall.service.js';
import {
  approveRetailEligibilityExceptionAudited,
  rejectRetailEligibilityExceptionAudited,
  requestRetailEligibilityException,
  revokeRetailEligibilityExceptionAudited,
} from '../services/retail-eligibility/exception.service.js';
import { getRetailEligibility } from '../services/retail-eligibility/retail-eligibility.service.js';
import { retailOperatorId } from '../middleware/retail-operator-authz.js';
import { config } from '../config/index.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { notFound, respondWithError } from '../lib/errors/error-codes.js';
import type {
  RetailCategoryRuleBody,
  RetailComplianceEvidenceBody,
  RetailEligibilityExceptionBody,
  RetailEligibilityPolicyCreateBody,
  RetailEligibilityTraceBody,
  RetailMarketCapabilityBody,
  RetailResaleEvidenceBody,
  RetailSuppressionBody,
} from '../middleware/retail-eligibility-schemas.js';
import { log } from '../lib/logger.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

/** The operator projection: the DTO plus the row id and the audit columns. */
function policyView(row: RetailEligibilityPolicyRecord) {
  return {
    id: row.id,
    ...toRetailEligibilityPolicySummary(row),
    createdByOxyUserId: row.createdByOxyUserId,
    ...(row.approvedByOxyUserId ? { approvedByOxyUserId: row.approvedByOxyUserId } : {}),
  };
}

/** Read a request body that has already been through its `.strict()` schema. */
function body<T>(req: Request): T {
  return req.body as T;
}

/**
 * Refuse a body that offers something which can never authorize a resale,
 * naming the prohibition — mounted BEFORE `validateBody`.
 *
 * The order is the whole point and it has to be real rather than intended: a
 * `.strict()` schema with an enum refuses `affiliate_product_feed` as "invalid
 * enum value", which reads as a typo. Running this first means the operator is
 * told that an affiliate agreement grants linking and commission rights and
 * never a right to resell (ADR 0004 D2.10) — the answer that teaches the
 * policy. A test pins the message, so a route that remounted this after the
 * schema would fail rather than quietly regress to the enum's wording.
 */
export function refuseForbiddenResaleEvidenceBody(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    assertRetailPolicyEvidenceIsSufficient(req.body);
    next();
  } catch (err) {
    respondWithError(res, err, 'Failed to accept the resale evidence requirement');
  }
}

/* ── Policy versions ─────────────────────────────────────────────────────── */

/** GET /internal/retail-eligibility/policies */
export async function listRetailEligibilityPoliciesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const policyKey = typeof req.query.policyKey === 'string' ? req.query.policyKey : undefined;
    const rows = await listRetailEligibilityPolicies(getDb(), policyKey ? { policyKey } : undefined);
    sendSuccess(res, { policies: rows.map(policyView) });
  } catch (err) {
    log.general.error({ err }, 'Failed to list retail eligibility policies');
    respondWithError(res, err, 'Failed to list retail eligibility policies');
  }
}

/** POST /internal/retail-eligibility/policies — draft a version. */
export async function createRetailEligibilityPolicyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    // Field by field, never a spread of the parsed body — the
    // `projectRetailOfferSourcingSeam` rule: a field added to the schema later
    // cannot reach the repository without somebody typing it here.
    const input = body<RetailEligibilityPolicyCreateBody>(req);
    const row = await draftRetailEligibilityPolicy({
      policyKey: input.policyKey,
      version: input.version,
      name: input.name,
      summary: input.summary,
      effectiveStart: new Date(input.effectiveStart),
      ...(input.effectiveEnd ? { effectiveEnd: new Date(input.effectiveEnd) } : {}),
      ...(input.permittedDestinationCountries
        ? { permittedDestinationCountries: input.permittedDestinationCountries }
        : {}),
      ...(input.permittedFulfilmentOriginCountries
        ? { permittedFulfilmentOriginCountries: input.permittedFulfilmentOriginCountries }
        : {}),
      ...(input.permittedChannels ? { permittedChannels: input.permittedChannels } : {}),
      ...(input.permittedCurrencies ? { permittedCurrencies: input.permittedCurrencies } : {}),
      ...(input.permittedFulfilmentMethods
        ? { permittedFulfilmentMethods: input.permittedFulfilmentMethods }
        : {}),
      ...(input.permittedCustomerTypes
        ? { permittedCustomerTypes: input.permittedCustomerTypes }
        : {}),
      ...(input.requiredResaleEvidenceKinds
        ? { requiredResaleEvidenceKinds: input.requiredResaleEvidenceKinds }
        : {}),
      ...(input.requiredIdentifierSchemes
        ? { requiredIdentifierSchemes: input.requiredIdentifierSchemes }
        : {}),
      ...(input.requireCountryOfOrigin !== undefined
        ? { requireCountryOfOrigin: input.requireCountryOfOrigin }
        : {}),
      ...(input.requireResponsibleOperator !== undefined
        ? { requireResponsibleOperator: input.requireResponsibleOperator }
        : {}),
      ...(input.requireDeterministicProductMatch !== undefined
        ? { requireDeterministicProductMatch: input.requireDeterministicProductMatch }
        : {}),
      ...(input.minimumMatchConfidence !== undefined
        ? { minimumMatchConfidence: input.minimumMatchConfidence }
        : {}),
      ...(input.maxQuantityPerOrder !== undefined
        ? { maxQuantityPerOrder: input.maxQuantityPerOrder }
        : {}),
      ...(input.maxOrderValueMinor !== undefined && input.maxOrderValueCurrency
        ? {
            maxOrderValue: {
              amount: input.maxOrderValueMinor,
              currency: input.maxOrderValueCurrency,
            },
          }
        : {}),
      ...(input.manualExceptionsPermitted !== undefined
        ? { manualExceptionsPermitted: input.manualExceptionsPermitted }
        : {}),
      ...(input.exceptionDualApprovalRequired !== undefined
        ? { exceptionDualApprovalRequired: input.exceptionDualApprovalRequired }
        : {}),
      reason: input.reason,
      createdByOxyUserId: retailOperatorId(req),
    });
    sendSuccess(res, { policy: policyView(row) }, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to draft a retail eligibility policy');
    respondWithError(res, err, 'Failed to draft a retail eligibility policy');
  }
}

/** POST /internal/retail-eligibility/policies/:id/activate */
export async function activateRetailEligibilityPolicyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const row = await activateRetailEligibilityPolicyVersion({
      id: routeParam(req, 'id'),
      approvedByOxyUserId: retailOperatorId(req),
      reason: body<{ reason: string }>(req).reason,
    });
    sendSuccess(res, { policy: policyView(row) });
  } catch (err) {
    log.general.error({ err }, 'Failed to activate a retail eligibility policy');
    respondWithError(res, err, 'Failed to activate a retail eligibility policy');
  }
}

/** POST /internal/retail-eligibility/policies/:id/retire */
export async function retireRetailEligibilityPolicyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const row = await retireRetailEligibilityPolicyVersion({
      id: routeParam(req, 'id'),
      actorOxyUserId: retailOperatorId(req),
      reason: body<{ reason: string }>(req).reason,
    });
    sendSuccess(res, { policy: policyView(row) });
  } catch (err) {
    log.general.error({ err }, 'Failed to retire a retail eligibility policy');
    respondWithError(res, err, 'Failed to retire a retail eligibility policy');
  }
}

/** GET /internal/retail-eligibility/policies/:id/rules */
export async function listRetailCategoryRulesHandler(req: Request, res: Response): Promise<void> {
  try {
    const policyId = routeParam(req, 'id');
    const policy = await findRetailEligibilityPolicyById(getDb(), policyId);
    if (!policy) throw notFound(`Retail eligibility policy ${policyId} does not exist.`);
    const [rules, capabilities] = await Promise.all([
      listRetailCategoryRules(getDb(), policyId),
      listRetailMarketCapabilities(getDb(), policyId),
    ]);
    sendSuccess(res, { policy: policyView(policy), rules, capabilities });
  } catch (err) {
    log.general.error({ err }, 'Failed to read retail category rules');
    respondWithError(res, err, 'Failed to read retail category rules');
  }
}

/** POST /internal/retail-eligibility/category-rules */
export async function recordRetailCategoryRuleHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<RetailCategoryRuleBody>(req);
    const row = await recordRetailCategoryRule({
      policyId: input.policyId,
      categoryKey: input.categoryKey,
      admissibility: input.admissibility,
      ...(input.requiredComplianceEvidenceKinds
        ? { requiredComplianceEvidenceKinds: input.requiredComplianceEvidenceKinds }
        : {}),
      ...(input.requiresAgeAssurance !== undefined
        ? { requiresAgeAssurance: input.requiresAgeAssurance }
        : {}),
      ...(input.dangerousGoodsRestricted !== undefined
        ? { dangerousGoodsRestricted: input.dangerousGoodsRestricted }
        : {}),
      ...(input.requiresAuthorizedDealer !== undefined
        ? { requiresAuthorizedDealer: input.requiresAuthorizedDealer }
        : {}),
      ...(input.requiresBatchTraceability !== undefined
        ? { requiresBatchTraceability: input.requiresBatchTraceability }
        : {}),
      reason: input.reason,
      recordedByOxyUserId: retailOperatorId(req),
    });
    sendSuccess(res, { rule: row }, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to record a retail category rule');
    respondWithError(res, err, 'Failed to record a retail category rule');
  }
}

/** POST /internal/retail-eligibility/market-capabilities */
export async function recordRetailMarketCapabilityHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const input = body<RetailMarketCapabilityBody>(req);
    const row = await recordRetailMarketCapability({
      policyId: input.policyId,
      destinationCountry: input.destinationCountry,
      fulfilmentOriginCountry: input.fulfilmentOriginCountry,
      customerType: input.customerType,
      ...(input.cancellationBeforeFulfilmentSupported !== undefined
        ? { cancellationBeforeFulfilmentSupported: input.cancellationBeforeFulfilmentSupported }
        : {}),
      ...(input.statutoryWithdrawalSupported !== undefined
        ? { statutoryWithdrawalSupported: input.statutoryWithdrawalSupported }
        : {}),
      ...(input.legalGuaranteeSupported !== undefined
        ? { legalGuaranteeSupported: input.legalGuaranteeSupported }
        : {}),
      ...(input.returnsSupported !== undefined ? { returnsSupported: input.returnsSupported } : {}),
      ...(input.defectHandlingSupported !== undefined
        ? { defectHandlingSupported: input.defectHandlingSupported }
        : {}),
      ...(input.refundThroughOriginalRailSupported !== undefined
        ? { refundThroughOriginalRailSupported: input.refundThroughOriginalRailSupported }
        : {}),
      ...(input.invoiceIssuanceSupported !== undefined
        ? { invoiceIssuanceSupported: input.invoiceIssuanceSupported }
        : {}),
      ...(input.recallNotificationSupported !== undefined
        ? { recallNotificationSupported: input.recallNotificationSupported }
        : {}),
      ...(input.deliveryEstimateAvailable !== undefined
        ? { deliveryEstimateAvailable: input.deliveryEstimateAvailable }
        : {}),
      ...(input.supportLanguages ? { supportLanguages: input.supportLanguages } : {}),
      ...(input.vatTreatment ? { vatTreatment: input.vatTreatment } : {}),
      ...(input.sellerRegistrationRecorded !== undefined
        ? { sellerRegistrationRecorded: input.sellerRegistrationRecorded }
        : {}),
      ...(input.sellerRegistrationRef
        ? { sellerRegistrationRef: input.sellerRegistrationRef }
        : {}),
      ...(input.ossRelevant !== undefined ? { ossRelevant: input.ossRelevant } : {}),
      ...(input.iossRelevant !== undefined ? { iossRelevant: input.iossRelevant } : {}),
      ...(input.importerOfRecord ? { importerOfRecord: input.importerOfRecord } : {}),
      ...(input.dutyResponsibility ? { dutyResponsibility: input.dutyResponsibility } : {}),
      ...(input.priceFinality ? { priceFinality: input.priceFinality } : {}),
      ...(input.orderValueThresholdMinor !== undefined && input.orderValueThresholdCurrency
        ? {
            orderValueThreshold: {
              amount: input.orderValueThresholdMinor,
              currency: input.orderValueThresholdCurrency,
            },
          }
        : {}),
      ...(input.supplierInvoiceTaxNote
        ? { supplierInvoiceTaxNote: input.supplierInvoiceTaxNote }
        : {}),
      ...(input.customerInvoiceNote ? { customerInvoiceNote: input.customerInvoiceNote } : {}),
      reason: input.reason,
      recordedByOxyUserId: retailOperatorId(req),
    });
    sendSuccess(res, { capability: row }, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to record a retail market capability');
    respondWithError(res, err, 'Failed to record a retail market capability');
  }
}

/* ── Evidence ────────────────────────────────────────────────────────────── */

/** GET /internal/retail-eligibility/evidence?supplierId= */
export async function listRetailEvidenceHandler(req: Request, res: Response): Promise<void> {
  try {
    const supplierId = typeof req.query.supplierId === 'string' ? req.query.supplierId : undefined;
    const horizon = new Date(Date.now() + config.retailEligibility.expiryHorizonDays * DAY_MS);
    const [resale, expiring, counts] = await Promise.all([
      supplierId ? listRetailResaleEvidence(getDb(), { supplierId }) : Promise.resolve([]),
      listExpiringRetailEvidence(getDb(), { before: horizon }),
      countRetailEvidenceByState(getDb()),
    ]);
    sendSuccess(res, { resale, expiring, counts });
  } catch (err) {
    log.general.error({ err }, 'Failed to read retail evidence');
    respondWithError(res, err, 'Failed to read retail evidence');
  }
}

/** POST /internal/retail-eligibility/resale-evidence */
export async function recordResaleEvidenceHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<RetailResaleEvidenceBody>(req);
    const row = await recordResaleEvidence({
      supplierId: input.supplierId,
      ...(input.agreementId ? { agreementId: input.agreementId } : {}),
      ...(input.supplierAccountId ? { supplierAccountId: input.supplierAccountId } : {}),
      kind: input.kind,
      ...(input.scopeBrandKeys ? { scopeBrandKeys: input.scopeBrandKeys } : {}),
      ...(input.scopeCategoryKeys ? { scopeCategoryKeys: input.scopeCategoryKeys } : {}),
      ...(input.scopeSupplierSkus ? { scopeSupplierSkus: input.scopeSupplierSkus } : {}),
      ...(input.scopeDestinationCountries
        ? { scopeDestinationCountries: input.scopeDestinationCountries }
        : {}),
      ...(input.issuedAt ? { issuedAt: new Date(input.issuedAt) } : {}),
      ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
      ...(input.oxyFileId ? { oxyFileId: input.oxyFileId } : {}),
      ...(input.documentUrl ? { documentUrl: input.documentUrl } : {}),
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
      ...(input.issuer ? { issuer: input.issuer } : {}),
      ...(input.note ? { note: input.note } : {}),
      reason: input.reason,
      recordedByOxyUserId: retailOperatorId(req),
    });
    sendSuccess(res, { evidence: row }, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to record resale evidence');
    respondWithError(res, err, 'Failed to record resale evidence');
  }
}

/** POST /internal/retail-eligibility/resale-evidence/:id/verify */
export async function verifyResaleEvidenceHandler(req: Request, res: Response): Promise<void> {
  try {
    const row = await verifyResaleEvidence({
      id: routeParam(req, 'id'),
      verifiedByOxyUserId: retailOperatorId(req),
      reason: body<{ reason: string }>(req).reason,
    });
    sendSuccess(res, { evidence: row });
  } catch (err) {
    log.general.error({ err }, 'Failed to verify resale evidence');
    respondWithError(res, err, 'Failed to verify resale evidence');
  }
}

/** POST /internal/retail-eligibility/resale-evidence/:id/reject */
export async function rejectResaleEvidenceHandler(req: Request, res: Response): Promise<void> {
  try {
    const row = await rejectResaleEvidence({
      id: routeParam(req, 'id'),
      actorOxyUserId: retailOperatorId(req),
      reason: body<{ reason: string }>(req).reason,
    });
    sendSuccess(res, { evidence: row });
  } catch (err) {
    log.general.error({ err }, 'Failed to reject resale evidence');
    respondWithError(res, err, 'Failed to reject resale evidence');
  }
}

/** POST /internal/retail-eligibility/resale-evidence/:id/revoke */
export async function revokeResaleEvidenceHandler(req: Request, res: Response): Promise<void> {
  try {
    const row = await revokeResaleEvidence({
      id: routeParam(req, 'id'),
      revokedByOxyUserId: retailOperatorId(req),
      reason: body<{ reason: string }>(req).reason,
    });
    sendSuccess(res, { evidence: row });
  } catch (err) {
    log.general.error({ err }, 'Failed to revoke resale evidence');
    respondWithError(res, err, 'Failed to revoke resale evidence');
  }
}

/** POST /internal/retail-eligibility/compliance-evidence */
export async function recordComplianceEvidenceHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<RetailComplianceEvidenceBody>(req);
    const row = await recordComplianceEvidence({
      supplierId: input.supplierId,
      ...(input.canonicalProductId ? { canonicalProductId: input.canonicalProductId } : {}),
      ...(input.canonicalVariantId ? { canonicalVariantId: input.canonicalVariantId } : {}),
      ...(input.supplierSku ? { supplierSku: input.supplierSku } : {}),
      kind: input.kind,
      ...(input.marketCountries ? { marketCountries: input.marketCountries } : {}),
      ...(input.documentVersion ? { documentVersion: input.documentVersion } : {}),
      ...(input.issuer ? { issuer: input.issuer } : {}),
      ...(input.issuedAt ? { issuedAt: new Date(input.issuedAt) } : {}),
      ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
      ...(input.oxyFileId ? { oxyFileId: input.oxyFileId } : {}),
      ...(input.documentUrl ? { documentUrl: input.documentUrl } : {}),
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
      ...(input.note ? { note: input.note } : {}),
      reason: input.reason,
      recordedByOxyUserId: retailOperatorId(req),
    });
    sendSuccess(res, { evidence: row }, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to record compliance evidence');
    respondWithError(res, err, 'Failed to record compliance evidence');
  }
}

/** POST /internal/retail-eligibility/compliance-evidence/:id/verify */
export async function verifyComplianceEvidenceHandler(req: Request, res: Response): Promise<void> {
  try {
    const row = await verifyComplianceEvidence({
      id: routeParam(req, 'id'),
      verifiedByOxyUserId: retailOperatorId(req),
      reason: body<{ reason: string }>(req).reason,
    });
    sendSuccess(res, { evidence: row });
  } catch (err) {
    log.general.error({ err }, 'Failed to verify compliance evidence');
    respondWithError(res, err, 'Failed to verify compliance evidence');
  }
}

/** POST /internal/retail-eligibility/compliance-evidence/:id/reject */
export async function rejectComplianceEvidenceHandler(req: Request, res: Response): Promise<void> {
  try {
    const row = await rejectComplianceEvidence({
      id: routeParam(req, 'id'),
      actorOxyUserId: retailOperatorId(req),
      reason: body<{ reason: string }>(req).reason,
    });
    sendSuccess(res, { evidence: row });
  } catch (err) {
    log.general.error({ err }, 'Failed to reject compliance evidence');
    respondWithError(res, err, 'Failed to reject compliance evidence');
  }
}

/** POST /internal/retail-eligibility/compliance-evidence/:id/revoke */
export async function revokeComplianceEvidenceHandler(req: Request, res: Response): Promise<void> {
  try {
    const row = await revokeComplianceEvidence({
      id: routeParam(req, 'id'),
      revokedByOxyUserId: retailOperatorId(req),
      reason: body<{ reason: string }>(req).reason,
    });
    sendSuccess(res, { evidence: row });
  } catch (err) {
    log.general.error({ err }, 'Failed to revoke compliance evidence');
    respondWithError(res, err, 'Failed to revoke compliance evidence');
  }
}

/* ── Suppressions and recalls ────────────────────────────────────────────── */

/** GET /internal/retail-eligibility/suppressions */
export async function listRetailSuppressionsHandler(req: Request, res: Response): Promise<void> {
  try {
    const liveOnly = req.query.live === 'true';
    const [rows, impact] = await Promise.all([
      listRetailSuppressions(getDb(), { liveOnly }),
      scanRetailSuppressionImpact(getDb()),
    ]);
    sendSuccess(res, { suppressions: rows, impact });
  } catch (err) {
    log.general.error({ err }, 'Failed to list retail suppressions');
    respondWithError(res, err, 'Failed to list retail suppressions');
  }
}

/** POST /internal/retail-eligibility/suppressions — the emergency stop. */
export async function raiseRetailSuppressionHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<RetailSuppressionBody>(req);
    const { suppression, created } = await raiseRetailSuppressionAudited({
      scope: input.scope,
      scopeRef: input.scopeRef,
      kind: input.kind,
      severity: input.severity,
      source: input.source,
      ...(input.externalReference ? { externalReference: input.externalReference } : {}),
      ...(input.effectiveFrom ? { effectiveFrom: new Date(input.effectiveFrom) } : {}),
      reason: input.reason,
      raisedByOxyUserId: retailOperatorId(req),
    });
    sendSuccess(res, { suppression, created }, created ? 201 : 200);
  } catch (err) {
    log.general.error({ err }, 'Failed to raise a retail suppression');
    respondWithError(res, err, 'Failed to raise a retail suppression');
  }
}

/** POST /internal/retail-eligibility/suppressions/:id/lift */
export async function liftRetailSuppressionHandler(req: Request, res: Response): Promise<void> {
  try {
    const row = await liftRetailSuppressionAudited({
      id: routeParam(req, 'id'),
      liftedByOxyUserId: retailOperatorId(req),
      reason: body<{ reason: string }>(req).reason,
    });
    sendSuccess(res, { suppression: row });
  } catch (err) {
    log.general.error({ err }, 'Failed to lift a retail suppression');
    respondWithError(res, err, 'Failed to lift a retail suppression');
  }
}

/* ── Exceptions ──────────────────────────────────────────────────────────── */

/** GET /internal/retail-eligibility/exceptions */
export async function listRetailEligibilityExceptionsHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const rows = await listRetailEligibilityExceptions(getDb());
    sendSuccess(res, { exceptions: rows });
  } catch (err) {
    log.general.error({ err }, 'Failed to list eligibility exceptions');
    respondWithError(res, err, 'Failed to list eligibility exceptions');
  }
}

/** POST /internal/retail-eligibility/exceptions */
export async function requestRetailEligibilityExceptionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const input = body<RetailEligibilityExceptionBody>(req);
    const row = await requestRetailEligibilityException({
      policyId: input.policyId,
      supplierId: input.supplierId,
      ...(input.canonicalVariantId ? { canonicalVariantId: input.canonicalVariantId } : {}),
      ...(input.scopeDestinationCountries
        ? { scopeDestinationCountries: input.scopeDestinationCountries }
        : {}),
      waivedReasons: input.waivedReasons,
      justification: input.justification,
      expiresAt: new Date(input.expiresAt),
      reason: input.reason,
      requestedByOxyUserId: retailOperatorId(req),
    });
    sendSuccess(res, { exception: row }, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to request an eligibility exception');
    respondWithError(res, err, 'Failed to request an eligibility exception');
  }
}

/** POST /internal/retail-eligibility/exceptions/:id/approve */
export async function approveRetailEligibilityExceptionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const row = await approveRetailEligibilityExceptionAudited({
      id: routeParam(req, 'id'),
      approvedByOxyUserId: retailOperatorId(req),
      reason: body<{ reason: string }>(req).reason,
    });
    sendSuccess(res, { exception: row });
  } catch (err) {
    log.general.error({ err }, 'Failed to approve an eligibility exception');
    respondWithError(res, err, 'Failed to approve an eligibility exception');
  }
}

/** POST /internal/retail-eligibility/exceptions/:id/reject */
export async function rejectRetailEligibilityExceptionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const row = await rejectRetailEligibilityExceptionAudited({
      id: routeParam(req, 'id'),
      rejectedByOxyUserId: retailOperatorId(req),
      reason: body<{ reason: string }>(req).reason,
    });
    sendSuccess(res, { exception: row });
  } catch (err) {
    log.general.error({ err }, 'Failed to reject an eligibility exception');
    respondWithError(res, err, 'Failed to reject an eligibility exception');
  }
}

/** POST /internal/retail-eligibility/exceptions/:id/revoke */
export async function revokeRetailEligibilityExceptionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const row = await revokeRetailEligibilityExceptionAudited({
      id: routeParam(req, 'id'),
      revokedByOxyUserId: retailOperatorId(req),
      reason: body<{ reason: string }>(req).reason,
    });
    sendSuccess(res, { exception: row });
  } catch (err) {
    log.general.error({ err }, 'Failed to revoke an eligibility exception');
    respondWithError(res, err, 'Failed to revoke an eligibility exception');
  }
}

/* ── Trace, metrics and audit ────────────────────────────────────────────── */

/**
 * POST /internal/retail-eligibility/trace — the what-if.
 *
 * `record: false`: an operator asking why something is dark must not pollute
 * the measurement of what the catalogue actually answered to buyers.
 */
export async function traceRetailEligibilityHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = body<RetailEligibilityTraceBody>(req);
    const result = await getRetailEligibility(
      {
        procurementOfferId: input.procurementOfferId,
        ...(input.canonicalVariantId ? { canonicalVariantId: input.canonicalVariantId } : {}),
        channel: input.channel,
        destinationCountry: input.destinationCountry,
        currency: input.currency,
        quantity: input.quantity,
        ...(input.orderValueMinor !== undefined && input.orderValueCurrency
          ? { orderValue: { amount: input.orderValueMinor, currency: input.orderValueCurrency } }
          : {}),
        fulfilmentMethod: input.fulfilmentMethod,
        customerType: input.customerType,
        ...(input.at ? { at: input.at } : {}),
      },
      { surface: 'operator', record: false },
    );
    const history = await listRetailEligibilityDecisionsForOffer(getDb(), {
      procurementOfferId: input.procurementOfferId,
      limit: 20,
    });
    sendSuccess(res, { eligibility: result, history });
  } catch (err) {
    log.general.error({ err }, 'Failed to trace retail eligibility');
    respondWithError(res, err, 'Failed to trace retail eligibility');
  }
}

/**
 * GET /internal/retail-eligibility/metrics — the eligible-catalogue percentage
 * and the checkouts eligibility blocked (#121 operations 6–7).
 */
export async function retailEligibilityMetricsHandler(req: Request, res: Response): Promise<void> {
  try {
    const days = Number.parseInt(String(req.query.days ?? '7'), 10);
    const since = new Date(Date.now() - (Number.isFinite(days) ? days : 7) * DAY_MS);
    const supplierId = typeof req.query.supplierId === 'string' ? req.query.supplierId : undefined;
    const [coverage, blockedCheckouts, evidenceCounts] = await Promise.all([
      measureRetailEligibility(getDb(), { since, ...(supplierId ? { supplierId } : {}) }),
      listBlockedCheckoutDecisions(getDb(), { since, limit: 50 }),
      countRetailEvidenceByState(getDb()),
    ]);
    sendSuccess(res, {
      since: since.toISOString(),
      coverage,
      blockedCheckouts,
      evidenceCounts,
    });
  } catch (err) {
    log.general.error({ err }, 'Failed to read retail eligibility metrics');
    respondWithError(res, err, 'Failed to read retail eligibility metrics');
  }
}

/** GET /internal/retail-eligibility/audits?subjectTable=&subjectId= */
export async function listRetailEligibilityAuditsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const subjectTable =
      typeof req.query.subjectTable === 'string' ? req.query.subjectTable : undefined;
    const subjectId = typeof req.query.subjectId === 'string' ? req.query.subjectId : undefined;
    const rows = await listRetailEligibilityAudits(getDb(), {
      ...(subjectTable ? { subjectTable } : {}),
      ...(subjectId ? { subjectId } : {}),
    });
    sendSuccess(res, { audits: rows });
  } catch (err) {
    log.general.error({ err }, 'Failed to read the retail eligibility audit trail');
    respondWithError(res, err, 'Failed to read the retail eligibility audit trail');
  }
}

/**
 * GET /internal/retail-eligibility/subjects/:registry/:id — one evidence row or
 * one suppression, whole, with its own audit trail.
 */
export async function traceRetailEligibilitySubjectHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const registry = routeParam(req, 'registry');
    const id = routeParam(req, 'id');
    const subject =
      registry === 'resale'
        ? await findRetailResaleEvidenceById(getDb(), id)
        : registry === 'compliance'
          ? await findRetailComplianceEvidenceById(getDb(), id)
          : registry === 'suppression'
            ? await findRetailSuppressionById(getDb(), id)
            : undefined;
    if (!subject) {
      throw notFound(`No ${registry} subject ${id}.`);
    }
    const table =
      registry === 'resale'
        ? 'retail_resale_evidence'
        : registry === 'compliance'
          ? 'retail_compliance_evidence'
          : 'retail_suppressions';
    const audits = await listRetailEligibilityAudits(getDb(), {
      subjectTable: table,
      subjectId: id,
    });
    sendSuccess(res, { registry, subject, audits });
  } catch (err) {
    log.general.error({ err }, 'Failed to trace a retail eligibility subject');
    respondWithError(res, err, 'Failed to trace a retail eligibility subject');
  }
}
