/**
 * THE retail eligibility derivation (#121) — PURE.
 *
 * Everything in this file is a function of facts the caller supplies plus a
 * clock. There is no database access, no clock reading beyond the `now` the
 * caller passes, and — most importantly — no parameter by which a caller could
 * change the answer. `getRetailEligibility` in
 * `retail-eligibility.service.ts` LOADS the facts and calls this; publication,
 * search, cart and checkout all read the result and none of them may compose
 * their own (#121 service contract: "clients cannot override it").
 *
 * ## Why the verdict is derived and never stored
 *
 * The inputs sit on eleven tables across three domains — supplier, agreement
 * and offer (#118), canonical product, variant and identifier (#56), and this
 * domain's policy, category rule, market capability, evidence and suppression
 * rows. A stored verdict beside them would be two representations of one fact,
 * and the place they must not disagree is a checkout gate. This is the exact
 * divergence `deriveNativeCheckoutEligibility` (#57) records from the
 * `onboarding_state` one-verdict rule, and it is what makes two of #121's
 * acceptance criteria true with no sweep having run:
 *
 *  - **(2) expiry removes eligibility automatically** — `expires_at` is read
 *    against the clock in `evidence-state.ts`;
 *  - **(5) recall suppression is immediate** — a committed `retail_suppressions`
 *    row is seen by the very next derivation, which is why the emergency path
 *    is testable INDEPENDENTLY of ordinary source refresh: the refresh path is
 *    not involved at all.
 *
 * ## `ineligible` beats `unknown` beats `eligible`
 *
 * A combination usually fails several ways at once. A settled refusal is a
 * HARDER FACT than a missing one, so it is what gets reported —
 * `deriveRetailCompleteness`'s severity-ordering rule (#120), applied to a
 * three-valued verdict. Both block; reporting the softer one would put an
 * expired certificate in the "collect evidence" queue and leave it there.
 *
 * ## Unknown is never a quiet yes, in both directions
 *
 * An absent category rule is `category_not_evaluated`, not "permitted". An
 * absent market-capability row is `market_capability_unknown`, not "we can
 * probably handle it". An absent document is `*_evidence_missing`, not "the
 * supplier presumably has one". Every one of those is `unknown`, and `unknown`
 * cannot publish or check out.
 */

import type {
  ProcurementEligibility,
  RetailComplianceEvidenceKind,
  RetailCustomerType,
  RetailEligibilityAction,
  RetailEligibilityEvidenceRef,
  RetailEligibilityReason,
  RetailEligibilityVerdict,
  RetailEvidenceReviewState,
  RetailEvidenceState,
  RetailFulfilmentMethod,
  RetailResaleEvidenceKind,
  RetailTaxDetermination,
  RetailVatTreatment,
  RetailCategoryAdmissibility,
  RetailCrossBorderResponsibility,
  RetailPriceFinality,
  RetailSuppressionKind,
  RetailSuppressionScope,
  RetailSuppressionSeverity,
} from '@mercaria/shared-types';
import {
  RETAIL_BLOCKING_SUPPRESSION_SEVERITIES,
  RETAIL_ELIGIBILITY_ACTION_PRIORITY,
  RETAIL_ELIGIBILITY_REASON_ACTION,
  RETAIL_ELIGIBILITY_REASON_VERDICT,
} from '@mercaria/shared-types';
import type { CurrencyCode, Money } from '@mercaria/shared-types';
import { deriveEvidenceState, summarizeEvidenceState } from './evidence-state.js';
import type { RetailTraceabilityFacts } from './traceability.port.js';

/* ------------------------------------------------------------------------- *
 * The fact shapes
 * ------------------------------------------------------------------------- */

/** The policy VERSION in force, as the derivation reads it. */
export interface RetailPolicyFacts {
  id: string;
  policyKey: string;
  version: number;
  permittedDestinationCountries: readonly string[];
  permittedFulfilmentOriginCountries: readonly string[];
  permittedChannels: readonly string[];
  permittedCurrencies: readonly string[];
  permittedFulfilmentMethods: readonly string[];
  permittedCustomerTypes: readonly string[];
  requiredResaleEvidenceKinds: readonly RetailResaleEvidenceKind[];
  requiredIdentifierSchemes: readonly string[];
  requireCountryOfOrigin: boolean;
  requireResponsibleOperator: boolean;
  requireDeterministicProductMatch: boolean;
  minimumMatchConfidence: number;
  maxQuantityPerOrder: number;
  maxOrderValue: Money | null;
  manualExceptionsPermitted: boolean;
  exceptionDualApprovalRequired: boolean;
}

/** The procurement offer's own identity and mapping (#118). */
export interface RetailOfferFacts {
  id: string;
  supplierId: string;
  supplierSku: string;
  canonicalProductId: string | null;
  canonicalVariantId: string | null;
  /** NULL = a deterministic or human mapping; a number = a machine one (#58). */
  mappingConfidence: number | null;
  /** Where this offer ships FROM. Empty = the source never said. */
  fulfilmentOriginCountries: readonly string[];
  /** The brand the canonical product belongs to, when one is resolved. */
  brandKey: string | null;
  /** The category slug the canonical product sits at, when one is resolved. */
  categoryKey: string | null;
  /** The #56 identifier schemes this product actually carries, active only. */
  identifierSchemes: readonly string[];
}

/** The agreement carve-outs and display rights this gate reads (#118). */
export interface RetailAgreementFacts {
  id: string;
  excludedBrands: readonly string[];
  excludedCategories: readonly string[];
  excludedProductRefs: readonly string[];
  catalogDataRightsGranted: boolean;
  imageRightsGranted: boolean;
  mapRestricted: boolean;
}

/** One policy version's rule for one category. */
export interface RetailCategoryRuleFacts {
  categoryKey: string;
  admissibility: RetailCategoryAdmissibility;
  requiredComplianceEvidenceKinds: readonly RetailComplianceEvidenceKind[];
  requiresAgeAssurance: boolean;
  dangerousGoodsRestricted: boolean;
  requiresAuthorizedDealer: boolean;
  requiresBatchTraceability: boolean;
}

/** What Mercaria can actually do on one route. */
export interface RetailMarketCapabilityFacts {
  cancellationBeforeFulfilmentSupported: boolean;
  statutoryWithdrawalSupported: boolean;
  legalGuaranteeSupported: boolean;
  returnsSupported: boolean;
  defectHandlingSupported: boolean;
  refundThroughOriginalRailSupported: boolean;
  invoiceIssuanceSupported: boolean;
  recallNotificationSupported: boolean;
  deliveryEstimateAvailable: boolean;
  supportLanguages: readonly string[];
  vatTreatment: RetailVatTreatment;
  sellerRegistrationRecorded: boolean;
  importerOfRecord: RetailCrossBorderResponsibility;
  dutyResponsibility: RetailCrossBorderResponsibility;
  priceFinality: RetailPriceFinality;
}

/** One resale-evidence row, as the derivation reads it. */
export interface RetailResaleEvidenceFacts {
  id: string;
  kind: RetailResaleEvidenceKind;
  reviewState: RetailEvidenceReviewState;
  expiresAt: Date | null;
  /** NULL = not scoped to one agreement version. */
  agreementId: string | null;
  scopeBrandKeys: readonly string[];
  scopeCategoryKeys: readonly string[];
  scopeSupplierSkus: readonly string[];
  scopeDestinationCountries: readonly string[];
}

/** One compliance-evidence row, as the derivation reads it. */
export interface RetailComplianceEvidenceFacts {
  id: string;
  kind: RetailComplianceEvidenceKind;
  reviewState: RetailEvidenceReviewState;
  expiresAt: Date | null;
  canonicalProductId: string | null;
  canonicalVariantId: string | null;
  supplierSku: string | null;
  marketCountries: readonly string[];
}

/** One live suppression, as the derivation reads it. */
export interface RetailSuppressionFacts {
  id: string;
  scope: RetailSuppressionScope;
  scopeRef: string;
  kind: RetailSuppressionKind;
  severity: RetailSuppressionSeverity;
  effectiveFrom: Date;
  liftedAt: Date | null;
}

/** One approved exception, as the derivation reads it. */
export interface RetailExceptionFacts {
  id: string;
  waivedReasons: readonly RetailEligibilityReason[];
  scopeDestinationCountries: readonly string[];
  canonicalVariantId: string | null;
  expiresAt: Date;
  /** Present exactly when a second operator approved — the four-eyes half. */
  secondApprovedByOxyUserId: string | null;
}

/** The exact question, in the shape the derivation reads (dimensions 6–12). */
export interface RetailEligibilityDerivationQuery {
  destinationCountry: string;
  channel: string;
  currency: CurrencyCode;
  quantity: number;
  orderValue: Money | null;
  fulfilmentMethod: RetailFulfilmentMethod;
  customerType: RetailCustomerType;
  /** The buyer's language, when the caller knows it — support coverage is per route. */
  customerLanguage: string | null;
}

/** Everything one derivation looks at. */
export interface RetailEligibilityDerivationInput {
  query: RetailEligibilityDerivationQuery;
  /** NULL = no active policy version, which is `policy_missing` and blocks. */
  policy: RetailPolicyFacts | null;
  offer: RetailOfferFacts;
  /** NULL = no agreement governs the offer; #118's own derivation already says so. */
  agreement: RetailAgreementFacts | null;
  /** #118's verdict, carried verbatim rather than restated. */
  supply: ProcurementEligibility;
  /** NULL = this category has no rule under the active version. */
  categoryRule: RetailCategoryRuleFacts | null;
  /** NULL = no capability recorded for this route, or no origin could be resolved. */
  marketCapability: RetailMarketCapabilityFacts | null;
  resaleEvidence: readonly RetailResaleEvidenceFacts[];
  complianceEvidence: readonly RetailComplianceEvidenceFacts[];
  suppressions: readonly RetailSuppressionFacts[];
  /** NULL = no live approved waiver covers this combination. */
  exception: RetailExceptionFacts | null;
  traceability: RetailTraceabilityFacts;
  now: Date;
}

/** What one derivation produces, before the service adds identity and a hash. */
export interface RetailEligibilityDerivation {
  verdict: RetailEligibilityVerdict;
  reasons: RetailEligibilityReason[];
  nextRequiredAction: RetailEligibilityAction;
  evidence: RetailEligibilityEvidenceRef[];
  /** The origin the route was evaluated for. NULL = none could be resolved. */
  fulfilmentOriginCountry: string | null;
  tax: RetailTaxDetermination | null;
  /** The exception that waived a reason, when one did. */
  appliedExceptionId: string | null;
  /** Reasons an exception removed — recorded so a waiver is never invisible. */
  waivedReasons: RetailEligibilityReason[];
}

/* ------------------------------------------------------------------------- *
 * The derivation
 * ------------------------------------------------------------------------- */

/** ISO country comparison is case-insensitive on the query, canonical on the row. */
function upper(value: string): string {
  return value.toUpperCase();
}

/**
 * Whether a scope-DOWN array covers a value. EMPTY means UNRESTRICTED here —
 * the `commerce_relationships.territories` semantics, and deliberately the
 * opposite of a policy's or an agreement's permit list, because a piece of
 * evidence is a positive fact being narrowed while a grant is a grant.
 */
function scopeCovers(scope: readonly string[], value: string | null): boolean {
  if (scope.length === 0) return true;
  if (value === null) return false;
  return scope.includes(value);
}

/** The suppression reason each scope produces. A recall overrides all of them. */
const SUPPRESSION_SCOPE_REASON: Record<RetailSuppressionScope, RetailEligibilityReason> = {
  supplier: 'supplier_suppressed',
  supplier_account: 'supplier_suppressed',
  canonical_product: 'product_suppressed',
  canonical_variant: 'product_suppressed',
  supplier_sku: 'product_suppressed',
  category: 'category_suppressed',
  market: 'market_suppressed',
  brand: 'brand_suppressed',
};

/** The reason each non-effective resale-evidence state produces. */
const RESALE_STATE_REASON: Record<
  Exclude<RetailEvidenceState, 'verified'>,
  RetailEligibilityReason
> = {
  unknown: 'resale_evidence_unverified',
  pending: 'resale_evidence_unverified',
  expired: 'resale_evidence_expired',
  revoked: 'resale_evidence_revoked',
  rejected: 'resale_evidence_rejected',
};

/** The reason each non-effective compliance-evidence state produces. */
const COMPLIANCE_STATE_REASON: Record<
  Exclude<RetailEvidenceState, 'verified'>,
  RetailEligibilityReason
> = {
  unknown: 'compliance_evidence_unverified',
  pending: 'compliance_evidence_unverified',
  expired: 'compliance_evidence_expired',
  revoked: 'compliance_evidence_revoked',
  rejected: 'compliance_evidence_rejected',
};

/**
 * Derive the verdict. Pure — the same facts always produce the same answer, and
 * the same answer for a real row and for a fixture.
 */
export function deriveRetailEligibility(
  input: RetailEligibilityDerivationInput,
): RetailEligibilityDerivation {
  const reasons = new Set<RetailEligibilityReason>();
  const evidence: RetailEligibilityEvidenceRef[] = [];
  const { query, policy, offer, now } = input;
  const destination = upper(query.destinationCountry);

  // ── Suppressions run FIRST and run whatever else is true ─────────────────
  // A recall must be visible in the answer even on a combination that is
  // ineligible for six other reasons, and even when no policy version is
  // active: "why is this dark" must never answer "we could not tell you"
  // about a product somebody recalled.
  const fulfilmentOriginCountry = resolveFulfilmentOrigin(offer, policy);
  for (const suppression of input.suppressions) {
    if (!isSuppressionLive(suppression, now)) continue;
    if (!suppressionAppliesTo(suppression, offer, destination)) continue;
    reasons.add(
      suppression.kind === 'recall'
        ? 'product_recalled'
        : SUPPRESSION_SCOPE_REASON[suppression.scope],
    );
  }

  if (!policy) {
    // Nothing else is answerable without a version to answer under, and a
    // decision that cannot cite one is not reproducible (acceptance 7) — so the
    // service does not record it either.
    reasons.add('policy_missing');
    return finish(reasons, evidence, null, fulfilmentOriginCountry, input);
  }

  // ── Policy scope: dimensions 6–11 ────────────────────────────────────────
  if (!policy.permittedDestinationCountries.includes(destination)) {
    reasons.add('destination_not_permitted');
  }
  if (
    offer.fulfilmentOriginCountries.length > 0 &&
    fulfilmentOriginCountry === null
  ) {
    // The offer said where it ships from and the policy permits none of them —
    // ADR 0004 D2.9's "any supplier shipping from outside the EU is ineligible",
    // as data on a policy version rather than a constant in code.
    reasons.add('fulfilment_origin_not_permitted');
  }
  if (!policy.permittedChannels.includes(query.channel)) {
    reasons.add('channel_not_permitted');
  }
  if (!policy.permittedCurrencies.includes(query.currency)) {
    reasons.add('currency_not_permitted');
  }
  if (!policy.permittedFulfilmentMethods.includes(query.fulfilmentMethod)) {
    reasons.add('fulfilment_method_not_permitted');
  }
  if (!policy.permittedCustomerTypes.includes(query.customerType)) {
    reasons.add('customer_type_not_permitted');
  }
  if (query.quantity > policy.maxQuantityPerOrder) {
    reasons.add('quantity_above_limit');
  }
  // The ceiling is only ever compared against an amount in ITS OWN currency:
  // this domain does no FX, and a policy that sets one is CHECK-constrained to
  // a single permitted currency, so a comparable pair is the only storable
  // configuration.
  if (
    policy.maxOrderValue &&
    query.orderValue &&
    query.orderValue.currency === policy.maxOrderValue.currency &&
    query.orderValue.amount > policy.maxOrderValue.amount
  ) {
    reasons.add('order_value_above_limit');
  }

  // ── Dimension 1–2: the supply chain, carried verbatim from #118 ──────────
  if (!input.supply.eligible) {
    reasons.add('supply_chain_ineligible');
  }

  // ── Resale authorization ─────────────────────────────────────────────────
  const agreement = input.agreement;
  if (agreement) {
    if (agreement.excludedBrands.length > 0 && offer.brandKey !== null &&
        agreement.excludedBrands.includes(offer.brandKey)) {
      reasons.add('brand_excluded_by_agreement');
    }
    if (agreement.excludedCategories.length > 0 && offer.categoryKey !== null &&
        agreement.excludedCategories.includes(offer.categoryKey)) {
      reasons.add('category_excluded_by_agreement');
    }
    if (agreement.excludedProductRefs.includes(offer.supplierSku)) {
      reasons.add('sku_excluded_by_agreement');
    }
    // Publishing an offer means showing the product: an image, a description
    // and a specification. Without both rights there is nothing lawful to show.
    if (!agreement.catalogDataRightsGranted || !agreement.imageRightsGranted) {
      reasons.add('catalog_data_rights_missing');
    }
  }

  const requiredResaleKinds = new Set(policy.requiredResaleEvidenceKinds);
  // An authorized-dealer category needs the grant that makes Mercaria one. It
  // is the same evidence question one rail over, so it joins the required set
  // rather than inventing a parallel check.
  if (input.categoryRule?.requiresAuthorizedDealer) {
    requiredResaleKinds.add('distributor_authorization');
  }
  // A MAP-restricted agreement needs its resolution ON RECORD before an offer
  // may be priced and published under it.
  if (agreement?.mapRestricted) {
    requiredResaleKinds.add('pricing_policy_acknowledgement');
  }

  for (const kind of [...requiredResaleKinds].sort()) {
    const ofKind = input.resaleEvidence.filter((row) => row.kind === kind);
    if (ofKind.length === 0) {
      reasons.add('resale_evidence_missing');
      continue;
    }
    const inScope = ofKind.filter((row) => resaleEvidenceCoversQuery(row, offer, agreement, destination));
    if (inScope.length === 0) {
      reasons.add('resale_evidence_out_of_scope');
      continue;
    }
    const state = summarizeEvidenceState(inScope, now);
    if (state === undefined || state === 'verified') {
      const accepted = inScope.find((row) => deriveEvidenceState(row, now) === 'verified');
      if (accepted) {
        evidence.push({
          registry: 'resale',
          id: accepted.id,
          kind: accepted.kind,
          state: 'verified',
          ...(accepted.expiresAt ? { expiresAt: accepted.expiresAt.toISOString() } : {}),
        });
      }
      continue;
    }
    reasons.add(RESALE_STATE_REASON[state]);
    // The row that produced the refusal is part of the answer: an operator
    // renewing an expired document needs to be told WHICH one.
    const offending = inScope.find((row) => deriveEvidenceState(row, now) === state);
    if (offending) {
      evidence.push({
        registry: 'resale',
        id: offending.id,
        kind: offending.kind,
        state,
        ...(offending.expiresAt ? { expiresAt: offending.expiresAt.toISOString() } : {}),
      });
    }
  }
  // A MAP restriction whose acknowledgement is merely absent is a question, not
  // a refusal — so it reports as an unresolved pricing restriction rather than
  // as missing resale evidence, which would send an operator after a contract.
  if (agreement?.mapRestricted &&
      !input.resaleEvidence.some(
        (row) =>
          row.kind === 'pricing_policy_acknowledgement' &&
          deriveEvidenceState(row, now) === 'verified' &&
          resaleEvidenceCoversQuery(row, offer, agreement, destination),
      )) {
    reasons.add('pricing_restriction_unresolved');
  }

  // ── Product identity and traceability ────────────────────────────────────
  if (offer.canonicalVariantId === null) {
    reasons.add('product_mapping_missing');
  } else if (offer.mappingConfidence !== null) {
    // A machine mapping. It is ambiguous when the policy demands a
    // deterministic one, or when its score is below the floor — either way it
    // is #59's to review, and it stays ineligible until then.
    if (policy.requireDeterministicProductMatch ||
        offer.mappingConfidence < policy.minimumMatchConfidence) {
      reasons.add('product_mapping_ambiguous');
    }
  }
  for (const scheme of policy.requiredIdentifierSchemes) {
    if (!offer.identifierSchemes.includes(scheme)) {
      reasons.add('product_identifier_missing');
    }
  }
  if (offer.brandKey === null && input.traceability.manufacturerIdentity === undefined) {
    reasons.add('brand_identity_missing');
  }
  if (policy.requireCountryOfOrigin && input.traceability.countryOfOrigin === undefined) {
    reasons.add('country_of_origin_missing');
  }
  if (policy.requireResponsibleOperator && input.traceability.responsibleOperator === undefined) {
    reasons.add('responsible_operator_missing');
  }
  if (input.categoryRule?.requiresBatchTraceability &&
      input.traceability.batchTraceabilitySupported !== true) {
    reasons.add('traceability_capability_missing');
  }

  // ── Category admissibility and the compliance registry ───────────────────
  const rule = input.categoryRule;
  if (!rule) {
    // ADR 0004 D12.3: an unevaluated category is ineligible by default. It is
    // reported as `unknown` so it lands in the review queue rather than reading
    // as a refusal somebody decided.
    reasons.add('category_not_evaluated');
  } else {
    if (rule.admissibility === 'prohibited') {
      reasons.add('category_prohibited');
    }
    if (rule.admissibility === 'requires_approval') {
      reasons.add('category_requires_approval');
    }
    if (rule.requiresAgeAssurance) {
      // Mercaria has no approved age-assurance flow. The flag means the
      // category needs one; there is none, so it blocks. When one exists this
      // reads a capability instead of being unconditional.
      reasons.add('age_assurance_unavailable');
    }
    if (rule.dangerousGoodsRestricted) {
      reasons.add('dangerous_goods_restricted');
    }
    for (const kind of rule.requiredComplianceEvidenceKinds) {
      const ofKind = input.complianceEvidence.filter(
        (row) => row.kind === kind && complianceEvidenceCoversSubject(row, offer),
      );
      if (ofKind.length === 0) {
        reasons.add('compliance_evidence_missing');
        continue;
      }
      const inMarket = ofKind.filter((row) => scopeCoversMarket(row.marketCountries, destination));
      if (inMarket.length === 0) {
        // A declaration issued for another market is not evidence for this one,
        // and saying so is different from saying nothing was collected.
        reasons.add('compliance_evidence_market_mismatch');
        continue;
      }
      const state = summarizeEvidenceState(inMarket, now);
      if (state === 'verified') {
        const accepted = inMarket.find((row) => deriveEvidenceState(row, now) === 'verified');
        if (accepted) {
          evidence.push({
            registry: 'compliance',
            id: accepted.id,
            kind: accepted.kind,
            state: 'verified',
            ...(accepted.expiresAt ? { expiresAt: accepted.expiresAt.toISOString() } : {}),
          });
        }
        continue;
      }
      if (state === undefined) {
        reasons.add('compliance_evidence_missing');
        continue;
      }
      reasons.add(COMPLIANCE_STATE_REASON[state]);
      const offending = inMarket.find((row) => deriveEvidenceState(row, now) === state);
      if (offending) {
        evidence.push({
          registry: 'compliance',
          id: offending.id,
          kind: offending.kind,
          state,
          ...(offending.expiresAt ? { expiresAt: offending.expiresAt.toISOString() } : {}),
        });
      }
    }
  }

  // ── Consumer capability and the tax gate ─────────────────────────────────
  const capability = input.marketCapability;
  let tax: RetailTaxDetermination | null = null;
  if (!capability) {
    reasons.add('market_capability_unknown');
  } else {
    if (!capability.cancellationBeforeFulfilmentSupported) reasons.add('cancellation_unsupported');
    if (!capability.statutoryWithdrawalSupported) reasons.add('withdrawal_unsupported');
    if (!capability.legalGuaranteeSupported) reasons.add('guarantee_unsupported');
    if (!capability.returnsSupported) reasons.add('returns_unsupported');
    if (!capability.defectHandlingSupported) reasons.add('defect_handling_unsupported');
    if (!capability.refundThroughOriginalRailSupported) reasons.add('refund_rail_unavailable');
    if (!capability.invoiceIssuanceSupported) reasons.add('invoice_issuance_unavailable');
    if (!capability.recallNotificationSupported) reasons.add('recall_notification_unavailable');
    if (!capability.deliveryEstimateAvailable) reasons.add('delivery_estimate_unavailable');
    if (
      capability.supportLanguages.length === 0 ||
      (query.customerLanguage !== null &&
        !capability.supportLanguages.includes(query.customerLanguage))
    ) {
      reasons.add('support_language_unavailable');
    }
    if (capability.vatTreatment === 'not_determined') reasons.add('tax_treatment_unknown');
    if (!capability.sellerRegistrationRecorded) reasons.add('tax_registration_missing');
    if (capability.importerOfRecord === 'undetermined') reasons.add('importer_of_record_unresolved');
    if (capability.dutyResponsibility === 'undetermined') reasons.add('duty_responsibility_unresolved');
    tax = {
      vatTreatment: capability.vatTreatment,
      importerOfRecord: capability.importerOfRecord,
      dutyResponsibility: capability.dutyResponsibility,
      // `additional_charges_possible` does NOT block: it is a determination,
      // and a route where charges may apply is sellable as long as the claim of
      // finality is not made. What it forbids is the CLAIM, which is #129's to
      // render from this value.
      priceFinality: capability.priceFinality,
      sellerRegistrationRecorded: capability.sellerRegistrationRecorded,
    };
  }

  return finish(reasons, evidence, tax, fulfilmentOriginCountry, input);
}

/**
 * Apply any live waiver, pick the verdict and the action, and sort.
 *
 * Split out because it runs on BOTH exits (the no-policy early return and the
 * full derivation), and a second copy of the waiver logic on one of those paths
 * is exactly how a recall becomes waivable by accident.
 */
function finish(
  reasons: Set<RetailEligibilityReason>,
  evidence: RetailEligibilityEvidenceRef[],
  tax: RetailTaxDetermination | null,
  fulfilmentOriginCountry: string | null,
  input: RetailEligibilityDerivationInput,
): RetailEligibilityDerivation {
  const waived: RetailEligibilityReason[] = [];
  let appliedExceptionId: string | null = null;

  const exception = input.exception;
  if (
    exception &&
    input.policy?.manualExceptionsPermitted === true &&
    exception.expiresAt.getTime() > input.now.getTime() &&
    (!input.policy.exceptionDualApprovalRequired ||
      exception.secondApprovedByOxyUserId !== null) &&
    scopeCovers(exception.scopeDestinationCountries, upper(input.query.destinationCountry)) &&
    (exception.canonicalVariantId === null ||
      exception.canonicalVariantId === input.offer.canonicalVariantId)
  ) {
    for (const reason of exception.waivedReasons) {
      // The database already refuses to STORE an unwaivable reason
      // (`retail_eligibility_exceptions_waived_reasons_check`). This loop
      // simply removes what the row names, so there is exactly one place the
      // waivable set is decided and it is not here.
      if (reasons.delete(reason)) {
        waived.push(reason);
        appliedExceptionId = exception.id;
      }
    }
  }

  const remaining = [...reasons].sort();
  const verdict = combineVerdict(remaining);
  return {
    verdict,
    reasons: remaining,
    nextRequiredAction: pickAction(remaining),
    // A stable order, so two derivations of one situation serialize identically
    // and the content hash of a decision is reproducible.
    evidence: evidence.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    fulfilmentOriginCountry,
    tax,
    appliedExceptionId,
    waivedReasons: waived.sort(),
  };
}

/** `ineligible` beats `unknown` beats `eligible` — see the module docblock. */
function combineVerdict(reasons: readonly RetailEligibilityReason[]): RetailEligibilityVerdict {
  if (reasons.length === 0) return 'eligible';
  if (reasons.some((reason) => RETAIL_ELIGIBILITY_REASON_VERDICT[reason] === 'ineligible')) {
    return 'ineligible';
  }
  return 'unknown';
}

/** The most actionable next step among the reasons, by the declared priority. */
function pickAction(reasons: readonly RetailEligibilityReason[]): RetailEligibilityAction {
  if (reasons.length === 0) return 'none';
  const actions = new Set(reasons.map((reason) => RETAIL_ELIGIBILITY_REASON_ACTION[reason]));
  return RETAIL_ELIGIBILITY_ACTION_PRIORITY.find((action) => actions.has(action)) ?? 'operator_review';
}

/**
 * The origin this route is evaluated for: the first of the offer's declared
 * origins that the policy permits, in the offer's own order.
 *
 * NULL when the offer declares none (the source never said) or when the policy
 * permits none of them. The two are told apart by the caller: an offer that
 * declared nothing produces `market_capability_unknown` (there is no route to
 * look up), while one whose origins are all refused produces
 * `fulfilment_origin_not_permitted`.
 */
function resolveFulfilmentOrigin(
  offer: RetailOfferFacts,
  policy: RetailPolicyFacts | null,
): string | null {
  if (!policy) return null;
  return (
    offer.fulfilmentOriginCountries
      .map(upper)
      .find((origin) => policy.permittedFulfilmentOriginCountries.includes(origin)) ?? null
  );
}

/** Live = raised, in effect, and not lifted. */
function isSuppressionLive(suppression: RetailSuppressionFacts, now: Date): boolean {
  if (suppression.liftedAt !== null) return false;
  if (suppression.effectiveFrom.getTime() > now.getTime()) return false;
  return RETAIL_BLOCKING_SUPPRESSION_SEVERITIES.includes(suppression.severity);
}

/** Does this suppression's scope contain the thing being asked about? */
function suppressionAppliesTo(
  suppression: RetailSuppressionFacts,
  offer: RetailOfferFacts,
  destination: string,
): boolean {
  switch (suppression.scope) {
    case 'supplier':
      return suppression.scopeRef === offer.supplierId;
    case 'supplier_account':
      // Account-scoped suppressions are loaded already filtered to this offer's
      // account, so reaching here means it applies.
      return true;
    case 'canonical_product':
      return suppression.scopeRef === offer.canonicalProductId;
    case 'canonical_variant':
      return suppression.scopeRef === offer.canonicalVariantId;
    case 'supplier_sku':
      return suppression.scopeRef === offer.supplierSku;
    case 'category':
      return suppression.scopeRef === offer.categoryKey;
    case 'market':
      return suppression.scopeRef === destination;
    case 'brand':
      return suppression.scopeRef === offer.brandKey;
  }
}

/** Whether a resale grant's scope covers this offer, agreement and destination. */
function resaleEvidenceCoversQuery(
  row: RetailResaleEvidenceFacts,
  offer: RetailOfferFacts,
  agreement: RetailAgreementFacts | null,
  destination: string,
): boolean {
  // Evidence collected under a SPECIFIC agreement version authorizes nothing
  // under a different one: superseding an agreement re-opens the question of
  // what its successor actually granted.
  if (row.agreementId !== null && row.agreementId !== agreement?.id) return false;
  if (!scopeCovers(row.scopeBrandKeys, offer.brandKey)) return false;
  if (!scopeCovers(row.scopeCategoryKeys, offer.categoryKey)) return false;
  if (!scopeCovers(row.scopeSupplierSkus, offer.supplierSku)) return false;
  if (!scopeCoversMarket(row.scopeDestinationCountries, destination)) return false;
  return true;
}

/** Whether a compliance document is ABOUT the product being asked about. */
function complianceEvidenceCoversSubject(
  row: RetailComplianceEvidenceFacts,
  offer: RetailOfferFacts,
): boolean {
  if (row.canonicalVariantId !== null) return row.canonicalVariantId === offer.canonicalVariantId;
  if (row.canonicalProductId !== null) return row.canonicalProductId === offer.canonicalProductId;
  if (row.supplierSku !== null) return row.supplierSku === offer.supplierSku;
  return false;
}

/** Market scope, upper-cased on both sides. Empty = unrestricted. */
function scopeCoversMarket(scope: readonly string[], destination: string): boolean {
  if (scope.length === 0) return true;
  return scope.map(upper).includes(destination);
}
