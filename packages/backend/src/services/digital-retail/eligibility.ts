/**
 * Derived digital procurement eligibility — and the seam toward the future public
 * `mercaria_retail` offer (#57), for the DIGITAL half (#1016, ADR 0011 D4).
 *
 * ## Eligibility is DERIVED, never stored
 *
 * There is no `eligible` column anywhere in `digital_procurement_offers`. This
 * function IS the verdict, recomputed from supplier, account, capability, rider
 * and offer facts every time it is asked — `procurement-eligibility.ts`'s rule,
 * one domain over, and for its reason: a stored verdict beside the facts it
 * derives from is two representations of one fact, and the place they must not
 * disagree is a checkout gate.
 *
 * ## Fail closed, with explainable reasons
 *
 * Every conjunct that fails adds a closed-set reason, sorted and deduped, so an
 * operator can see WHY a supplier is dark rather than just that it is. Unknown
 * facts are failures: no rider is `terms_missing`, an unmapped offer is
 * `offer_unmapped`, an out-of-window quote is `offer_quote_stale`, and an
 * AMBIGUOUS mapping is `offer_mapping_ambiguous` — the one this domain exists to
 * add, because an offer whose platform, edition, region or activation ecosystem
 * is not exactly determined must never fulfil a customer order.
 *
 * ## Pure, and that is what makes it testable
 *
 * It takes facts, not rows. `findProcurementCandidates` composes those facts in
 * one join so a checkout does not pay an N+1, and the tests drive this function
 * against fixtures with no database at all.
 */

import type {
  DigitalFulfilmentCapability,
  DigitalProcurementEligibility,
  DigitalProcurementIneligibilityReason,
  DigitalProcurementMappingStatus,
  DigitalRetailProductClass,
  DigitalSupplyProvenance,
  ProcurementAvailability,
  SupplierAccountState,
  SupplierRiskLevel,
  SupplierStatus,
} from '@mercaria/shared-types';

/** The supplier facts eligibility reads. */
export interface DigitalEligibilitySupplierFacts {
  readonly status: SupplierStatus;
  readonly riskLevel: SupplierRiskLevel;
}

/** The account facts eligibility reads. */
export interface DigitalEligibilityAccountFacts {
  readonly state: SupplierAccountState;
  /** The `purchase` capability's state, or null when the account has no such row. */
  readonly purchaseCapabilityState: 'enabled' | 'paused' | 'unavailable' | null;
}

/**
 * The rider facts eligibility reads, plus the two agreement dates it hangs off.
 *
 * `null` for the WHOLE object is the legible state: no rider means this
 * counterparty has authorized no digital supply at all, and that is
 * `terms_missing` rather than a silent absence.
 */
export interface DigitalEligibilityTermsFacts {
  readonly provenance: DigitalSupplyProvenance;
  readonly agreementApprovalState: string;
  readonly agreementEffectiveAt: Date | null;
  readonly agreementExpiresAt: Date | null;
  readonly termsExpiresAt: Date | null;
  readonly resaleRightsGranted: boolean;
  readonly permittedProductClasses: readonly string[];
  readonly permittedFulfilmentCapabilities: readonly string[];
  readonly permittedTerritories: readonly string[];
  readonly excludedBrands: readonly string[];
  readonly maxOrderCostAmount: number | null;
  readonly maxOrderCostCurrency: string | null;
}

/** The offer facts eligibility reads. */
export interface DigitalEligibilityOfferFacts {
  readonly id: string;
  readonly status: 'active' | 'retired';
  readonly mappingStatus: DigitalProcurementMappingStatus;
  readonly availability: ProcurementAvailability;
  readonly canonicalProductId: string | null;
  readonly canonicalVariantId: string | null;
  readonly productClass: DigitalRetailProductClass;
  readonly fulfilmentCapability: DigitalFulfilmentCapability;
  readonly brandSlug: string | null;
  readonly activationTerritories: readonly string[];
  readonly costAmount: number;
  readonly costCurrency: string;
  readonly quoteTtlSeconds: number | null;
  readonly expiresAt: Date | null;
  readonly lastConfirmedAt: Date;
  readonly expectedFulfilmentSeconds: number | null;
}

/** What one derivation looks at. */
export interface DigitalEligibilityInput {
  readonly supplier: DigitalEligibilitySupplierFacts;
  readonly account: DigitalEligibilityAccountFacts;
  /** Null when no rider governs the offer — `terms_missing`. */
  readonly terms: DigitalEligibilityTermsFacts | null;
  readonly offer: DigitalEligibilityOfferFacts;
  /** The territory the buyer needs the product to ACTIVATE in, when asked about one. */
  readonly activationTerritory?: string;
  /** The capability the order line requires, when the question has one. */
  readonly requiredCapability?: DigitalFulfilmentCapability;
  /** The most this order line may pay, in minor units of the offer's currency. */
  readonly maxAcceptedCostAmount?: number;
  /** Whether procurement is enabled at all on this deployment (ADR 0011 D14). */
  readonly procurementEnabled?: boolean;
  readonly now?: Date;
}

/** How fresh an offer's terms are, derived from the clock — never a column. */
export type DigitalOfferFreshness = 'fresh' | 'stale' | 'expired';

/** `expired` beats `stale`: a declared end is a harder fact than a quiet TTL. */
export function deriveDigitalOfferFreshness(
  offer: Pick<DigitalEligibilityOfferFacts, 'lastConfirmedAt' | 'quoteTtlSeconds' | 'expiresAt'>,
  now: Date = new Date(),
): DigitalOfferFreshness {
  if (offer.expiresAt && offer.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (
    offer.quoteTtlSeconds !== null &&
    offer.lastConfirmedAt.getTime() + offer.quoteTtlSeconds * 1_000 <= now.getTime()
  ) {
    return 'stale';
  }
  return 'fresh';
}

/** Whether a rider is approved AND inside both its own and its agreement's window. */
function termsActive(terms: DigitalEligibilityTermsFacts, now: Date): boolean {
  if (terms.agreementApprovalState !== 'approved') return false;
  if (!terms.agreementEffectiveAt) return false;
  if (terms.agreementEffectiveAt.getTime() > now.getTime()) return false;
  if (terms.agreementExpiresAt && terms.agreementExpiresAt.getTime() <= now.getTime()) return false;
  if (terms.termsExpiresAt && terms.termsExpiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Derive the verdict. Pure — same answer for a row and for a fixture.
 *
 * The ORDER of the conjuncts does not matter to the result (every failure is
 * collected, never short-circuited) and that is deliberate: an operator asking
 * "why is this supplier dark" wants every reason, not the first one.
 */
export function deriveDigitalProcurementEligibility(
  input: DigitalEligibilityInput,
): DigitalProcurementEligibility {
  const now = input.now ?? new Date();
  const reasons = new Set<DigitalProcurementIneligibilityReason>();

  if (input.procurementEnabled === false) reasons.add('procurement_disabled');

  if (input.supplier.status !== 'active') reasons.add('supplier_not_active');
  if (input.supplier.riskLevel === 'blocked') reasons.add('supplier_risk_blocked');

  if (input.account.state === 'killed') reasons.add('account_kill_switched');
  else if (input.account.state !== 'active') reasons.add('account_not_active');

  // The `purchase` capability is what actually buys. A missing row and a paused
  // one are DIFFERENT reasons: one is an account nobody finished configuring, the
  // other is an incident somebody is managing, and an operator needs to tell them
  // apart at a glance.
  if (input.account.purchaseCapabilityState === null) reasons.add('capability_missing');
  else if (input.account.purchaseCapabilityState !== 'enabled') reasons.add('capability_paused');

  const terms = input.terms;
  if (!terms) {
    reasons.add('terms_missing');
  } else {
    if (terms.agreementApprovalState !== 'approved') {
      reasons.add('agreement_not_approved');
    } else if (!termsActive(terms, now)) {
      // Approved but out of window: name WHICH end failed, because the remedy
      // differs — an expiry needs a renewal, a future start needs patience.
      const expired =
        (terms.agreementExpiresAt && terms.agreementExpiresAt.getTime() <= now.getTime()) ||
        (terms.termsExpiresAt && terms.termsExpiresAt.getTime() <= now.getTime());
      reasons.add(expired ? 'agreement_expired' : 'agreement_not_effective');
    }
    if (!terms.resaleRightsGranted) reasons.add('agreement_not_approved');
    if (!terms.permittedProductClasses.includes(input.offer.productClass)) {
      reasons.add('product_class_not_permitted');
    }
    if (!terms.permittedFulfilmentCapabilities.includes(input.offer.fulfilmentCapability)) {
      reasons.add('capability_not_permitted');
    }
    if (
      input.offer.brandSlug &&
      terms.excludedBrands.includes(input.offer.brandSlug.toLowerCase())
    ) {
      reasons.add('brand_excluded');
    }
    if (input.activationTerritory) {
      const territory = input.activationTerritory.toUpperCase();
      // Empty GRANTS none — the `supplier_agreements` semantics, unchanged.
      if (!terms.permittedTerritories.includes(territory)) reasons.add('territory_not_permitted');
    }
  }

  if (input.offer.status === 'retired') reasons.add('offer_retired');
  const freshness = deriveDigitalOfferFreshness(input.offer, now);
  if (freshness === 'expired') reasons.add('offer_expired');
  if (freshness === 'stale') reasons.add('offer_quote_stale');

  if (input.offer.mappingStatus === 'unmapped') reasons.add('offer_unmapped');
  if (input.offer.mappingStatus === 'ambiguous') reasons.add('offer_mapping_ambiguous');
  if (input.offer.canonicalVariantId === null) reasons.add('offer_unmapped');

  if (
    input.offer.availability === 'out_of_stock' ||
    input.offer.availability === 'discontinued'
  ) {
    reasons.add('offer_out_of_stock');
  }

  if (input.requiredCapability && input.offer.fulfilmentCapability !== input.requiredCapability) {
    reasons.add('capability_not_permitted');
  }

  if (input.activationTerritory && input.offer.activationTerritories.length > 0) {
    // An offer that names NO territory is unrestricted; one that names some is
    // restricted TO them. The two are different facts and the empty array is the
    // first, not the second — the opposite of the rider's grant semantics, and
    // the difference is that an offer DESCRIBES and a rider AUTHORIZES.
    if (!input.offer.activationTerritories.includes(input.activationTerritory.toUpperCase())) {
      reasons.add('territory_not_permitted');
    }
  }

  if (
    input.maxAcceptedCostAmount !== undefined &&
    input.offer.costAmount > input.maxAcceptedCostAmount
  ) {
    reasons.add('cost_above_bound');
  }
  if (
    terms?.maxOrderCostAmount != null &&
    terms.maxOrderCostCurrency === input.offer.costCurrency &&
    input.offer.costAmount > terms.maxOrderCostAmount
  ) {
    reasons.add('cost_above_bound');
  }

  const sorted = [...reasons].sort();
  return { eligible: sorted.length === 0, reasons: sorted };
}
