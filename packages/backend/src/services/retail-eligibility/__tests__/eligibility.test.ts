/**
 * The retail eligibility derivation (#121) — acceptance 8's whole list as table
 * tests over the PURE function.
 *
 * Acceptance 8 names seven cases: territory, brand exclusion, document expiry,
 * recall, tax unknown, restricted category and client-bypass attempts. Six of
 * them are decisions the derivation makes, and they live here. The seventh —
 * client bypass — is partly here (the query type has no override field and the
 * waiver set cannot reach a recall) and partly in
 * `routes/__tests__/internal-retail-eligibility.test.ts`, because "a client
 * cannot override it" is also an HTTP property.
 *
 * These are table tests and not fixtures against a database on purpose: the
 * derivation is pure, so one fact set produces one verdict whether it came from
 * a row or from an object literal. `retail-eligibility.realdb.test.ts` then
 * pins the things a pure function cannot have — CHECKs, triggers, indexes.
 */

import { describe, expect, it } from 'vitest';
import {
  RETAIL_ELIGIBILITY_ACTIONS,
  RETAIL_ELIGIBILITY_ACTION_PRIORITY,
  RETAIL_ELIGIBILITY_REASONS,
  RETAIL_ELIGIBILITY_REASON_ACTION,
  RETAIL_ELIGIBILITY_REASON_VERDICT,
  RETAIL_FORBIDDEN_EVIDENCE_KINDS,
  RETAIL_RESALE_EVIDENCE_KINDS,
  RETAIL_UNWAIVABLE_REASONS,
  RETAIL_WAIVABLE_REASONS,
} from '@mercaria/shared-types';
import {
  deriveRetailEligibility,
  type RetailEligibilityDerivationInput,
  type RetailPolicyFacts,
} from '../eligibility.js';

const NOW = new Date('2026-08-09T12:00:00.000Z');
const YESTERDAY = new Date('2026-08-08T12:00:00.000Z');
const NEXT_YEAR = new Date('2027-08-09T12:00:00.000Z');

/** A policy version that permits the launch route and requires the launch evidence. */
const POLICY: RetailPolicyFacts = {
  id: 'policy-1',
  policyKey: 'mercaria-retail-eligibility',
  version: 1,
  permittedDestinationCountries: ['ES', 'FR'],
  permittedFulfilmentOriginCountries: ['ES', 'DE'],
  permittedChannels: ['mercaria_branded_checkout'],
  permittedCurrencies: ['EUR'],
  permittedFulfilmentMethods: ['standard_delivery'],
  permittedCustomerTypes: ['consumer'],
  requiredResaleEvidenceKinds: ['signed_supply_agreement'],
  requiredIdentifierSchemes: ['gtin'],
  requireCountryOfOrigin: true,
  requireResponsibleOperator: true,
  requireDeterministicProductMatch: false,
  minimumMatchConfidence: 0.95,
  maxQuantityPerOrder: 5,
  maxOrderValue: { amount: 100_000, currency: 'EUR' },
  manualExceptionsPermitted: false,
  exceptionDualApprovalRequired: true,
};

/**
 * The combination that is ELIGIBLE. Every case below is this minus one thing,
 * so a test that fails names exactly what it removed — and a fixture drifting
 * into ineligibility fails the first case rather than making the rest vacuous.
 */
function eligibleInput(): RetailEligibilityDerivationInput {
  return {
    query: {
      destinationCountry: 'ES',
      channel: 'mercaria_branded_checkout',
      currency: 'EUR',
      quantity: 1,
      orderValue: { amount: 4_999, currency: 'EUR' },
      fulfilmentMethod: 'standard_delivery',
      customerType: 'consumer',
      customerLanguage: 'es',
    },
    policy: POLICY,
    offer: {
      id: 'offer-1',
      supplierId: 'supplier-1',
      supplierSku: 'SKU-1',
      canonicalProductId: 'product-1',
      canonicalVariantId: 'variant-1',
      mappingConfidence: null,
      fulfilmentOriginCountries: ['ES'],
      brandKey: 'acme',
      categoryKey: 'kitchen-knives',
      identifierSchemes: ['gtin'],
    },
    agreement: {
      id: 'agreement-1',
      excludedBrands: [],
      excludedCategories: [],
      excludedProductRefs: [],
      catalogDataRightsGranted: true,
      imageRightsGranted: true,
      mapRestricted: false,
    },
    supply: { eligible: true, reasons: [] },
    categoryRule: {
      categoryKey: 'kitchen-knives',
      admissibility: 'permitted',
      requiredComplianceEvidenceKinds: ['gpsr_traceability_pack'],
      requiresAgeAssurance: false,
      dangerousGoodsRestricted: false,
      requiresAuthorizedDealer: false,
      requiresBatchTraceability: false,
    },
    marketCapability: {
      cancellationBeforeFulfilmentSupported: true,
      statutoryWithdrawalSupported: true,
      legalGuaranteeSupported: true,
      returnsSupported: true,
      defectHandlingSupported: true,
      refundThroughOriginalRailSupported: true,
      invoiceIssuanceSupported: true,
      recallNotificationSupported: true,
      deliveryEstimateAvailable: true,
      supportLanguages: ['es', 'en'],
      vatTreatment: 'destination_vat_oss',
      sellerRegistrationRecorded: true,
      importerOfRecord: 'not_applicable',
      dutyResponsibility: 'not_applicable',
      priceFinality: 'final',
    },
    resaleEvidence: [
      {
        id: 'resale-1',
        kind: 'signed_supply_agreement',
        reviewState: 'verified',
        expiresAt: NEXT_YEAR,
        agreementId: 'agreement-1',
        scopeBrandKeys: [],
        scopeCategoryKeys: [],
        scopeSupplierSkus: [],
        scopeDestinationCountries: [],
      },
    ],
    complianceEvidence: [
      {
        id: 'compliance-1',
        kind: 'gpsr_traceability_pack',
        reviewState: 'verified',
        expiresAt: NEXT_YEAR,
        canonicalProductId: 'product-1',
        canonicalVariantId: null,
        supplierSku: null,
        marketCountries: ['ES'],
      },
    ],
    suppressions: [],
    exception: null,
    traceability: {
      countryOfOrigin: 'ES',
      manufacturerIdentity: 'Acme S.L.',
      responsibleOperator: 'Acme S.L., Calle Falsa 1',
      batchTraceabilitySupported: true,
    },
    now: NOW,
  };
}

describe('the eligible baseline', () => {
  it('answers eligible with no reasons and no action', () => {
    const result = deriveRetailEligibility(eligibleInput());
    expect(result.verdict).toBe('eligible');
    expect(result.reasons).toEqual([]);
    expect(result.nextRequiredAction).toBe('none');
    // The evidence the answer RESTED on is part of the answer, both registries.
    expect(result.evidence.map((ref) => ref.id).sort()).toEqual(['compliance-1', 'resale-1']);
    expect(result.tax?.priceFinality).toBe('final');
    expect(result.fulfilmentOriginCountry).toBe('ES');
  });
});

describe('acceptance 8: territory', () => {
  it('refuses a destination the policy does not permit', () => {
    const input = eligibleInput();
    input.query.destinationCountry = 'US';
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('ineligible');
    expect(result.reasons).toContain('destination_not_permitted');
    expect(result.nextRequiredAction).toBe('not_available');
  });

  it('refuses an origin outside the permitted set — ADR 0004 D2.9', () => {
    const input = eligibleInput();
    // A supplier shipping from outside the EU customs territory at launch.
    input.offer.fulfilmentOriginCountries = ['CN'];
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('ineligible');
    expect(result.reasons).toContain('fulfilment_origin_not_permitted');
    expect(result.fulfilmentOriginCountry).toBeNull();
  });

  it('reports an UNDECLARED origin as an unknown route, not as a refused one', () => {
    // The two are different facts: "they ship from somewhere we forbid" and
    // "the source never said". Only the first is a settled refusal.
    const input = eligibleInput();
    input.offer.fulfilmentOriginCountries = [];
    input.marketCapability = null;
    const result = deriveRetailEligibility(input);
    expect(result.reasons).not.toContain('fulfilment_origin_not_permitted');
    expect(result.reasons).toContain('market_capability_unknown');
    expect(result.verdict).toBe('unknown');
  });

  it('refuses evidence scoped to another territory', () => {
    const input = eligibleInput();
    const evidence = input.resaleEvidence[0];
    if (!evidence) throw new Error('fixture lost its resale evidence');
    const scoped = { ...evidence, scopeDestinationCountries: ['FR'] };
    input.resaleEvidence = [scoped];
    const result = deriveRetailEligibility(input);
    expect(result.reasons).toContain('resale_evidence_out_of_scope');
    expect(result.verdict).toBe('ineligible');
  });
});

describe('acceptance 8: brand exclusion', () => {
  it('refuses a brand the agreement carves out', () => {
    const input = eligibleInput();
    if (!input.agreement) throw new Error('fixture lost its agreement');
    input.agreement.excludedBrands = ['acme'];
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('ineligible');
    expect(result.reasons).toContain('brand_excluded_by_agreement');
    expect(result.nextRequiredAction).toBe('not_available');
  });

  it('refuses an excluded category and an excluded SKU by their own reasons', () => {
    const input = eligibleInput();
    if (!input.agreement) throw new Error('fixture lost its agreement');
    input.agreement.excludedCategories = ['kitchen-knives'];
    input.agreement.excludedProductRefs = ['SKU-1'];
    const result = deriveRetailEligibility(input);
    expect(result.reasons).toContain('category_excluded_by_agreement');
    expect(result.reasons).toContain('sku_excluded_by_agreement');
  });

  it('does not confuse a DIFFERENT brand for the excluded one', () => {
    // The near-miss half: an exclusion list that matched everything would pass
    // the case above and be useless.
    const input = eligibleInput();
    if (!input.agreement) throw new Error('fixture lost its agreement');
    input.agreement.excludedBrands = ['globex'];
    expect(deriveRetailEligibility(input).verdict).toBe('eligible');
  });
});

describe('acceptance 8: document expiry', () => {
  it('a verified resale grant that lapsed yesterday removes eligibility, with no sweep', () => {
    const input = eligibleInput();
    const evidence = input.resaleEvidence[0];
    if (!evidence) throw new Error('fixture lost its resale evidence');
    input.resaleEvidence = [{ ...evidence, expiresAt: YESTERDAY }];
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('ineligible');
    expect(result.reasons).toContain('resale_evidence_expired');
    // The ACTION is a renewal, not a fresh collection: the document existed.
    expect(result.nextRequiredAction).toBe('renew_resale_evidence');
    // And the offending row is named, so an operator knows WHICH to renew.
    expect(result.evidence).toContainEqual(
      expect.objectContaining({ id: 'resale-1', state: 'expired' }),
    );
  });

  it('a lapsed compliance certificate does the same on its own registry', () => {
    const input = eligibleInput();
    const evidence = input.complianceEvidence[0];
    if (!evidence) throw new Error('fixture lost its compliance evidence');
    input.complianceEvidence = [{ ...evidence, expiresAt: YESTERDAY }];
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('ineligible');
    expect(result.reasons).toContain('compliance_evidence_expired');
  });

  it('the same evidence one second BEFORE its deadline is still effective', () => {
    // The boundary, both sides: an expiry check that fired a day early would
    // pass the two cases above and quietly darken a live catalogue.
    const input = eligibleInput();
    const evidence = input.resaleEvidence[0];
    if (!evidence) throw new Error('fixture lost its resale evidence');
    input.resaleEvidence = [{ ...evidence, expiresAt: new Date(NOW.getTime() + 1_000) }];
    expect(deriveRetailEligibility(input).verdict).toBe('eligible');
  });

  it('a REJECTED document past its date reports as rejected, not as expired', () => {
    // Only a verification can lapse. Telling an operator to "renew" a document
    // somebody refused sends them to do the wrong work.
    const input = eligibleInput();
    const evidence = input.resaleEvidence[0];
    if (!evidence) throw new Error('fixture lost its resale evidence');
    input.resaleEvidence = [{ ...evidence, reviewState: 'rejected', expiresAt: YESTERDAY }];
    const result = deriveRetailEligibility(input);
    expect(result.reasons).toContain('resale_evidence_rejected');
    expect(result.reasons).not.toContain('resale_evidence_expired');
  });
});

describe('acceptance 8: recall and the emergency path', () => {
  it('a live recall on the variant blocks, and asks for the suppression to be lifted', () => {
    const input = eligibleInput();
    input.suppressions = [
      {
        id: 'suppression-1',
        scope: 'canonical_variant',
        scopeRef: 'variant-1',
        kind: 'recall',
        severity: 'stop_sale_and_recover',
        effectiveFrom: YESTERDAY,
        liftedAt: null,
      },
    ];
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('ineligible');
    expect(result.reasons).toContain('product_recalled');
    expect(result.nextRequiredAction).toBe('lift_suppression');
  });

  it('a supplier kill switch blocks every offer of that supplier', () => {
    const input = eligibleInput();
    input.suppressions = [
      {
        id: 'suppression-2',
        scope: 'supplier',
        scopeRef: 'supplier-1',
        kind: 'kill_switch',
        severity: 'stop_sale',
        effectiveFrom: YESTERDAY,
        liftedAt: null,
      },
    ];
    expect(deriveRetailEligibility(input).reasons).toContain('supplier_suppressed');
  });

  it('a market kill switch blocks that destination and no other', () => {
    const input = eligibleInput();
    input.suppressions = [
      {
        id: 'suppression-3',
        scope: 'market',
        scopeRef: 'FR',
        kind: 'kill_switch',
        severity: 'stop_sale',
        effectiveFrom: YESTERDAY,
        liftedAt: null,
      },
    ];
    // Asking about ES, suppressed in FR.
    expect(deriveRetailEligibility(input).verdict).toBe('eligible');
    input.query.destinationCountry = 'FR';
    expect(deriveRetailEligibility(input).reasons).toContain('market_suppressed');
  });

  it('an ADVISORY safety notice records without blocking', () => {
    // A notice that is not a stop-sale must not silently delist a catalogue.
    const input = eligibleInput();
    input.suppressions = [
      {
        id: 'suppression-4',
        scope: 'canonical_variant',
        scopeRef: 'variant-1',
        kind: 'safety_notice',
        severity: 'advisory',
        effectiveFrom: YESTERDAY,
        liftedAt: null,
      },
    ];
    expect(deriveRetailEligibility(input).verdict).toBe('eligible');
  });

  it('a LIFTED recall and a FUTURE-DATED one both stop blocking', () => {
    const input = eligibleInput();
    input.suppressions = [
      {
        id: 'suppression-5',
        scope: 'canonical_variant',
        scopeRef: 'variant-1',
        kind: 'recall',
        severity: 'stop_sale',
        effectiveFrom: YESTERDAY,
        liftedAt: NOW,
      },
      {
        id: 'suppression-6',
        scope: 'canonical_product',
        scopeRef: 'product-1',
        kind: 'recall',
        severity: 'stop_sale',
        effectiveFrom: NEXT_YEAR,
        liftedAt: null,
      },
    ];
    expect(deriveRetailEligibility(input).verdict).toBe('eligible');
  });

  it('a recall is reported even with NO active policy version', () => {
    // "Why is this dark" must never answer "we could not tell you" about a
    // product somebody recalled — which is why suppressions run before the
    // policy-less early return.
    const input = eligibleInput();
    input.policy = null;
    input.suppressions = [
      {
        id: 'suppression-7',
        scope: 'canonical_variant',
        scopeRef: 'variant-1',
        kind: 'recall',
        severity: 'stop_sale',
        effectiveFrom: YESTERDAY,
        liftedAt: null,
      },
    ];
    const result = deriveRetailEligibility(input);
    expect(result.reasons).toContain('product_recalled');
    expect(result.reasons).toContain('policy_missing');
    // `ineligible` beats `unknown`: the recall is the harder fact.
    expect(result.verdict).toBe('ineligible');
  });
});

describe('acceptance 8: tax unknown', () => {
  it('an undetermined VAT treatment blocks as UNKNOWN, never as zero tax', () => {
    const input = eligibleInput();
    if (!input.marketCapability) throw new Error('fixture lost its market capability');
    input.marketCapability.vatTreatment = 'not_determined';
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('unknown');
    expect(result.reasons).toContain('tax_treatment_unknown');
    expect(result.nextRequiredAction).toBe('determine_tax_treatment');
    // The determination still travels, so #120 and #129 read what the gate read.
    expect(result.tax?.vatTreatment).toBe('not_determined');
  });

  it('an unresolved importer or duty responsibility blocks too', () => {
    const input = eligibleInput();
    if (!input.marketCapability) throw new Error('fixture lost its market capability');
    input.marketCapability.importerOfRecord = 'undetermined';
    input.marketCapability.dutyResponsibility = 'undetermined';
    const result = deriveRetailEligibility(input);
    expect(result.reasons).toContain('importer_of_record_unresolved');
    expect(result.reasons).toContain('duty_responsibility_unresolved');
    expect(result.verdict).toBe('unknown');
  });

  it('a route with no recorded capability at all is unknown, not permissive', () => {
    const input = eligibleInput();
    input.marketCapability = null;
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('unknown');
    expect(result.reasons).toContain('market_capability_unknown');
    expect(result.tax).toBeNull();
  });

  it('`additional_charges_possible` does NOT block — it forbids the CLAIM', () => {
    const input = eligibleInput();
    if (!input.marketCapability) throw new Error('fixture lost its market capability');
    input.marketCapability.priceFinality = 'additional_charges_possible';
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('eligible');
    expect(result.tax?.priceFinality).toBe('additional_charges_possible');
  });

  it('an unavailable refund rail or an unsupported withdrawal right blocks', () => {
    // "A buyer cannot be charged where returns or refunds are unresolved."
    const input = eligibleInput();
    if (!input.marketCapability) throw new Error('fixture lost its market capability');
    input.marketCapability.refundThroughOriginalRailSupported = false;
    input.marketCapability.statutoryWithdrawalSupported = false;
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('ineligible');
    expect(result.reasons).toContain('refund_rail_unavailable');
    expect(result.reasons).toContain('withdrawal_unsupported');
  });

  it('a route that supports no language the buyer speaks blocks', () => {
    const input = eligibleInput();
    input.query.customerLanguage = 'de';
    expect(deriveRetailEligibility(input).reasons).toContain('support_language_unavailable');
  });
});

describe('acceptance 8: restricted category', () => {
  it('a category with NO rule is unevaluated — unknown, and it blocks', () => {
    // ADR 0004 D12.3, reported honestly so it lands in the review queue rather
    // than reading as a refusal somebody decided.
    const input = eligibleInput();
    input.categoryRule = null;
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('unknown');
    expect(result.reasons).toContain('category_not_evaluated');
    expect(result.nextRequiredAction).toBe('evaluate_category');
  });

  it('a prohibited category is a settled refusal', () => {
    const input = eligibleInput();
    if (!input.categoryRule) throw new Error('fixture lost its category rule');
    input.categoryRule.admissibility = 'prohibited';
    input.categoryRule.requiredComplianceEvidenceKinds = [];
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('ineligible');
    expect(result.reasons).toContain('category_prohibited');
    expect(result.nextRequiredAction).toBe('not_available');
  });

  it('an age-gated category blocks: Mercaria has no approved age-assurance flow', () => {
    const input = eligibleInput();
    if (!input.categoryRule) throw new Error('fixture lost its category rule');
    input.categoryRule.requiresAgeAssurance = true;
    expect(deriveRetailEligibility(input).reasons).toContain('age_assurance_unavailable');
  });

  it('a dangerous-goods category blocks', () => {
    const input = eligibleInput();
    if (!input.categoryRule) throw new Error('fixture lost its category rule');
    input.categoryRule.dangerousGoodsRestricted = true;
    expect(deriveRetailEligibility(input).reasons).toContain('dangerous_goods_restricted');
  });

  it('an authorized-dealer category needs the distributor authorization', () => {
    const input = eligibleInput();
    if (!input.categoryRule) throw new Error('fixture lost its category rule');
    input.categoryRule.requiresAuthorizedDealer = true;
    expect(deriveRetailEligibility(input).reasons).toContain('resale_evidence_missing');
  });

  it('a required compliance document issued for ANOTHER market is a mismatch', () => {
    const input = eligibleInput();
    const evidence = input.complianceEvidence[0];
    if (!evidence) throw new Error('fixture lost its compliance evidence');
    input.complianceEvidence = [{ ...evidence, marketCountries: ['DE'] }];
    const result = deriveRetailEligibility(input);
    expect(result.reasons).toContain('compliance_evidence_market_mismatch');
    expect(result.reasons).not.toContain('compliance_evidence_missing');
  });

  it('a required compliance document nobody filed is MISSING, a different fact', () => {
    const input = eligibleInput();
    input.complianceEvidence = [];
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('unknown');
    expect(result.reasons).toContain('compliance_evidence_missing');
    expect(result.nextRequiredAction).toBe('collect_compliance_evidence');
  });
});

describe('acceptance 1: an affiliate feed is never resale authority', () => {
  it('the allowed and forbidden evidence vocabularies are DISJOINT', () => {
    const allowed = new Set<string>(RETAIL_RESALE_EVIDENCE_KINDS);
    for (const forbidden of RETAIL_FORBIDDEN_EVIDENCE_KINDS) {
      expect(allowed.has(forbidden)).toBe(false);
    }
    expect(RETAIL_FORBIDDEN_EVIDENCE_KINDS).toHaveLength(14);
  });

  it('a supplier with no signed agreement cannot be eligible however much else it has', () => {
    // The affiliate-only case: everything about the product is fine and there
    // is simply no grant, so it is UNKNOWN — a question for the evidence queue.
    const input = eligibleInput();
    input.resaleEvidence = [];
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('unknown');
    expect(result.reasons).toContain('resale_evidence_missing');
    expect(result.nextRequiredAction).toBe('collect_resale_evidence');
  });

  it('an UNVERIFIED grant authorizes nothing', () => {
    const input = eligibleInput();
    const evidence = input.resaleEvidence[0];
    if (!evidence) throw new Error('fixture lost its resale evidence');
    input.resaleEvidence = [{ ...evidence, reviewState: 'pending' }];
    const result = deriveRetailEligibility(input);
    expect(result.reasons).toContain('resale_evidence_unverified');
    expect(result.nextRequiredAction).toBe('verify_resale_evidence');
  });

  it('a grant under a DIFFERENT agreement version authorizes nothing', () => {
    const input = eligibleInput();
    const evidence = input.resaleEvidence[0];
    if (!evidence) throw new Error('fixture lost its resale evidence');
    input.resaleEvidence = [{ ...evidence, agreementId: 'agreement-superseded' }];
    expect(deriveRetailEligibility(input).reasons).toContain('resale_evidence_out_of_scope');
  });

  it('missing catalog-data or image rights blocks publication', () => {
    const input = eligibleInput();
    if (!input.agreement) throw new Error('fixture lost its agreement');
    input.agreement.imageRightsGranted = false;
    expect(deriveRetailEligibility(input).reasons).toContain('catalog_data_rights_missing');
  });

  it('a MAP-restricted agreement needs its acknowledgement on record', () => {
    const input = eligibleInput();
    if (!input.agreement) throw new Error('fixture lost its agreement');
    input.agreement.mapRestricted = true;
    const result = deriveRetailEligibility(input);
    expect(result.reasons).toContain('pricing_restriction_unresolved');
  });
});

describe('acceptance 3: an ambiguous product match stays ineligible', () => {
  it('an unmapped offer is UNKNOWN and asks for the match to be resolved', () => {
    const input = eligibleInput();
    input.offer.canonicalVariantId = null;
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('unknown');
    expect(result.reasons).toContain('product_mapping_missing');
    expect(result.nextRequiredAction).toBe('resolve_product_match');
  });

  it('a machine match below the policy floor is AMBIGUOUS — a settled refusal', () => {
    const input = eligibleInput();
    input.offer.mappingConfidence = 0.8;
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('ineligible');
    expect(result.reasons).toContain('product_mapping_ambiguous');
  });

  it('a machine match ABOVE the floor is accepted', () => {
    const input = eligibleInput();
    input.offer.mappingConfidence = 0.99;
    expect(deriveRetailEligibility(input).verdict).toBe('eligible');
  });

  it('a policy demanding a deterministic match refuses ANY confidence score', () => {
    const input = eligibleInput();
    input.policy = { ...POLICY, requireDeterministicProductMatch: true };
    input.offer.mappingConfidence = 0.999;
    expect(deriveRetailEligibility(input).reasons).toContain('product_mapping_ambiguous');
  });

  it('a missing required identifier is unknown, not a refusal', () => {
    const input = eligibleInput();
    input.offer.identifierSchemes = [];
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('unknown');
    expect(result.reasons).toContain('product_identifier_missing');
  });
});

describe('acceptance 4: destination, category and order-value limits are server-side', () => {
  it('a quantity above the ceiling is refused', () => {
    const input = eligibleInput();
    input.query.quantity = 6;
    expect(deriveRetailEligibility(input).reasons).toContain('quantity_above_limit');
  });

  it('an order value above the ceiling is refused', () => {
    const input = eligibleInput();
    input.query.orderValue = { amount: 100_001, currency: 'EUR' };
    expect(deriveRetailEligibility(input).reasons).toContain('order_value_above_limit');
  });

  it('the channel, the currency, the method and the customer type each gate on their own', () => {
    const cases: [Partial<RetailEligibilityDerivationInput['query']>, string][] = [
      [{ channel: 'mercaria_marketplace' }, 'channel_not_permitted'],
      [{ currency: 'USD' }, 'currency_not_permitted'],
      [{ fulfilmentMethod: 'freight_delivery' }, 'fulfilment_method_not_permitted'],
      [{ customerType: 'business' }, 'customer_type_not_permitted'],
    ];
    for (const [patch, expected] of cases) {
      const input = eligibleInput();
      Object.assign(input.query, patch);
      expect(deriveRetailEligibility(input).reasons, expected).toContain(expected);
    }
  });
});

describe('traceability requirements', () => {
  it('missing country of origin, responsible operator or batch capability each block', () => {
    const input = eligibleInput();
    if (!input.categoryRule) throw new Error('fixture lost its category rule');
    input.categoryRule.requiresBatchTraceability = true;
    input.traceability = {};
    input.offer.brandKey = null;
    const result = deriveRetailEligibility(input);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'country_of_origin_missing',
        'responsible_operator_missing',
        'traceability_capability_missing',
        'brand_identity_missing',
      ]),
    );
    expect(result.verdict).toBe('unknown');
  });

  it('a policy that does not require them accepts their absence', () => {
    // The lever exists so a deployment that has not wired #122's provider can
    // still operate — deliberately, auditably, on a NEW policy version.
    const input = eligibleInput();
    input.policy = {
      ...POLICY,
      requireCountryOfOrigin: false,
      requireResponsibleOperator: false,
    };
    input.traceability = { manufacturerIdentity: 'Acme S.L.' };
    expect(deriveRetailEligibility(input).verdict).toBe('eligible');
  });
});

describe('the three-valued combination', () => {
  it('`ineligible` beats `unknown` beats `eligible`', () => {
    const input = eligibleInput();
    // One unknown alone.
    input.complianceEvidence = [];
    expect(deriveRetailEligibility(input).verdict).toBe('unknown');
    // Add a settled refusal beside it: the harder fact wins.
    input.query.destinationCountry = 'US';
    const both = deriveRetailEligibility(input);
    expect(both.verdict).toBe('ineligible');
    expect(both.reasons).toEqual(expect.arrayContaining(['compliance_evidence_missing', 'destination_not_permitted']));
  });

  it('reasons are sorted and deduped, so two derivations serialize identically', () => {
    const input = eligibleInput();
    input.query.destinationCountry = 'US';
    input.resaleEvidence = [];
    const first = deriveRetailEligibility(input);
    const second = deriveRetailEligibility(eligibleInput());
    expect(first.reasons).toEqual([...first.reasons].sort());
    expect(new Set(first.reasons).size).toBe(first.reasons.length);
    expect(second.reasons).toEqual([]);
  });

  it('every reason has a verdict contribution and an action', () => {
    // A reason missing from either table would silently drop out of the answer.
    for (const reason of RETAIL_ELIGIBILITY_REASONS) {
      expect(RETAIL_ELIGIBILITY_REASON_VERDICT[reason], reason).toBeDefined();
      expect(RETAIL_ELIGIBILITY_REASON_ACTION[reason], reason).toBeDefined();
    }
    // …and every action is in the priority order, or `pickAction` could not
    // choose it and would silently fall back to `operator_review`.
    for (const action of RETAIL_ELIGIBILITY_ACTIONS) {
      expect(RETAIL_ELIGIBILITY_ACTION_PRIORITY, action).toContain(action);
    }
    expect(RETAIL_ELIGIBILITY_ACTION_PRIORITY).toHaveLength(RETAIL_ELIGIBILITY_ACTIONS.length);
  });
});

describe('acceptance 8: client-bypass attempts', () => {
  it('the waivable and unwaivable reason sets are DISJOINT', () => {
    const waivable = new Set<string>(RETAIL_WAIVABLE_REASONS);
    for (const unwaivable of RETAIL_UNWAIVABLE_REASONS) {
      expect(waivable.has(unwaivable), unwaivable).toBe(false);
    }
    // …and both name real reasons, so a typo cannot make a rule vacuous.
    const all = new Set<string>(RETAIL_ELIGIBILITY_REASONS);
    for (const reason of [...RETAIL_WAIVABLE_REASONS, ...RETAIL_UNWAIVABLE_REASONS]) {
      expect(all.has(reason), reason).toBe(true);
    }
  });

  it('an approved exception waives ONLY what it names', () => {
    const input = eligibleInput();
    input.policy = { ...POLICY, manualExceptionsPermitted: true };
    input.categoryRule = {
      categoryKey: 'kitchen-knives',
      admissibility: 'requires_approval',
      requiredComplianceEvidenceKinds: [],
      requiresAgeAssurance: false,
      dangerousGoodsRestricted: false,
      requiresAuthorizedDealer: false,
      requiresBatchTraceability: false,
    };
    input.complianceEvidence = [];
    input.exception = {
      id: 'exception-1',
      waivedReasons: ['category_requires_approval'],
      scopeDestinationCountries: ['ES'],
      canonicalVariantId: 'variant-1',
      expiresAt: NEXT_YEAR,
      secondApprovedByOxyUserId: 'operator-2',
    };
    const result = deriveRetailEligibility(input);
    expect(result.waivedReasons).toEqual(['category_requires_approval']);
    expect(result.appliedExceptionId).toBe('exception-1');
    expect(result.verdict).toBe('eligible');
  });

  it('an exception cannot waive a recall — the derivation removes only what the row names', () => {
    // The database refuses to STORE `product_recalled` in `waived_reasons`; this
    // asserts the second wall, in case a row ever reached the derivation anyway.
    const input = eligibleInput();
    input.policy = { ...POLICY, manualExceptionsPermitted: true };
    input.suppressions = [
      {
        id: 'suppression-8',
        scope: 'canonical_variant',
        scopeRef: 'variant-1',
        kind: 'recall',
        severity: 'stop_sale',
        effectiveFrom: YESTERDAY,
        liftedAt: null,
      },
    ];
    input.exception = {
      id: 'exception-2',
      waivedReasons: ['category_requires_approval'],
      scopeDestinationCountries: [],
      canonicalVariantId: null,
      expiresAt: NEXT_YEAR,
      secondApprovedByOxyUserId: 'operator-2',
    };
    const result = deriveRetailEligibility(input);
    expect(result.verdict).toBe('ineligible');
    expect(result.reasons).toContain('product_recalled');
  });

  it('an exception waives nothing under a policy that permits none', () => {
    const input = eligibleInput();
    input.categoryRule = {
      categoryKey: 'kitchen-knives',
      admissibility: 'requires_approval',
      requiredComplianceEvidenceKinds: [],
      requiresAgeAssurance: false,
      dangerousGoodsRestricted: false,
      requiresAuthorizedDealer: false,
      requiresBatchTraceability: false,
    };
    input.complianceEvidence = [];
    input.exception = {
      id: 'exception-3',
      waivedReasons: ['category_requires_approval'],
      scopeDestinationCountries: [],
      canonicalVariantId: null,
      expiresAt: NEXT_YEAR,
      secondApprovedByOxyUserId: 'operator-2',
    };
    // `manualExceptionsPermitted` is false on the baseline policy.
    const result = deriveRetailEligibility(input);
    expect(result.waivedReasons).toEqual([]);
    expect(result.reasons).toContain('category_requires_approval');
  });

  it('a HALF-APPROVED exception waives nothing under a dual-approval version', () => {
    const input = eligibleInput();
    input.policy = { ...POLICY, manualExceptionsPermitted: true };
    input.categoryRule = {
      categoryKey: 'kitchen-knives',
      admissibility: 'requires_approval',
      requiredComplianceEvidenceKinds: [],
      requiresAgeAssurance: false,
      dangerousGoodsRestricted: false,
      requiresAuthorizedDealer: false,
      requiresBatchTraceability: false,
    };
    input.complianceEvidence = [];
    input.exception = {
      id: 'exception-4',
      waivedReasons: ['category_requires_approval'],
      scopeDestinationCountries: [],
      canonicalVariantId: null,
      expiresAt: NEXT_YEAR,
      secondApprovedByOxyUserId: null,
    };
    expect(deriveRetailEligibility(input).reasons).toContain('category_requires_approval');
  });

  it('an EXPIRED or out-of-scope exception waives nothing', () => {
    const base = eligibleInput();
    base.policy = { ...POLICY, manualExceptionsPermitted: true };
    base.categoryRule = {
      categoryKey: 'kitchen-knives',
      admissibility: 'requires_approval',
      requiredComplianceEvidenceKinds: [],
      requiresAgeAssurance: false,
      dangerousGoodsRestricted: false,
      requiresAuthorizedDealer: false,
      requiresBatchTraceability: false,
    };
    base.complianceEvidence = [];

    const expired = structuredClone(base);
    expired.exception = {
      id: 'exception-5',
      waivedReasons: ['category_requires_approval'],
      scopeDestinationCountries: [],
      canonicalVariantId: null,
      expiresAt: YESTERDAY,
      secondApprovedByOxyUserId: 'operator-2',
    };
    expect(deriveRetailEligibility(expired).reasons).toContain('category_requires_approval');

    const wrongMarket = structuredClone(base);
    wrongMarket.exception = {
      id: 'exception-6',
      waivedReasons: ['category_requires_approval'],
      scopeDestinationCountries: ['FR'],
      canonicalVariantId: null,
      expiresAt: NEXT_YEAR,
      secondApprovedByOxyUserId: 'operator-2',
    };
    expect(deriveRetailEligibility(wrongMarket).reasons).toContain('category_requires_approval');
  });
});
