/**
 * Derived procurement eligibility — and the seam toward the future public
 * `mercaria_retail` offer (#57).
 *
 * ## Eligibility is DERIVED, never stored
 *
 * #118 offer item 15 says it outright, and the payments domain already
 * demonstrates why: a stored verdict beside the facts it derives from is two
 * representations of one fact, and the place they must not disagree is a
 * checkout gate. So there is no `eligible` column anywhere in the schema —
 * this function IS the verdict, recomputed from supplier, account, agreement
 * and offer facts every time it is asked.
 *
 * ## Fail closed, with explainable reasons
 *
 * Every conjunct that fails adds a closed-set reason
 * (`PROCUREMENT_INELIGIBILITY_REASONS`), sorted and deduped, so an operator
 * can see WHY an offer is dark rather than just that it is. Unknown facts are
 * failures: no agreement is `agreement_missing`, an unmapped offer is
 * `offer_unmapped`, an out-of-window quote is `offer_quote_stale`.
 *
 * ## The #57 seam
 *
 * The unified offer domain is not built. `projectRetailOfferSourcingSeam` is
 * what #118 exposes INSTEAD of extending it: a projection carrying identity,
 * availability and the verdict — and structurally NOT carrying wholesale
 * cost, credentials or agreement terms, because `RetailOfferSourcingSeam`
 * has no such properties. When #57 lands, its `mercaria_retail` offer kind
 * composes over this projection.
 */

import type {
  AgreementChannel,
  ProcurementAvailability,
  ProcurementEligibility,
  ProcurementIneligibilityReason,
  ProcurementOfferStatus,
  RetailOfferSourcingSeam,
  SupplierAccountState,
  SupplierRiskLevel,
  SupplierStatus,
} from '@mercaria/shared-types';
import {
  agreementGrantsRetailDropship,
  agreementPermitsChannel,
  agreementPermitsDestination,
  isAgreementActive,
  type AgreementScopeFacts,
} from './agreement-scope.js';

/** The supplier facts eligibility reads. */
export interface EligibilitySupplierFacts {
  status: SupplierStatus;
  riskLevel: SupplierRiskLevel;
}

/** The account facts eligibility reads. */
export interface EligibilityAccountFacts {
  state: SupplierAccountState;
}

/** The offer facts eligibility reads. */
export interface EligibilityOfferFacts {
  id: string;
  status: ProcurementOfferStatus;
  availability: ProcurementAvailability;
  canonicalProductId: string | null;
  canonicalVariantId: string | null;
  eligibleDestinationCountries: string[];
  lastConfirmedAt: Date;
  quoteTtlSeconds: number | null;
  expiresAt: Date | null;
  deliveryDaysMin: number | null;
  deliveryDaysMax: number | null;
}

/** What one derivation looks at. `agreement` is null when none governs the offer. */
export interface EligibilityInput {
  supplier: EligibilitySupplierFacts;
  account: EligibilityAccountFacts;
  agreement: AgreementScopeFacts | null;
  offer: EligibilityOfferFacts;
  /** The concrete destination being asked about, when the question has one. */
  destinationCountry?: string;
  /** The channel being asked about, when the question has one. */
  channel?: AgreementChannel;
  now?: Date;
}

/** How fresh an offer's terms are, derived from the clock — never a column. */
export type ProcurementOfferFreshness = 'fresh' | 'stale' | 'expired';

/** `expired` beats `stale`: a declared end is a harder fact than a quiet TTL. */
export function deriveOfferFreshness(
  offer: Pick<EligibilityOfferFacts, 'lastConfirmedAt' | 'quoteTtlSeconds' | 'expiresAt'>,
  now: Date = new Date(),
): ProcurementOfferFreshness {
  if (offer.expiresAt && offer.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (
    offer.quoteTtlSeconds !== null &&
    offer.lastConfirmedAt.getTime() + offer.quoteTtlSeconds * 1_000 <= now.getTime()
  ) {
    return 'stale';
  }
  return 'fresh';
}

/** Derive the verdict. Pure — same answer for a row and for a fixture. */
export function deriveProcurementEligibility(input: EligibilityInput): ProcurementEligibility {
  const now = input.now ?? new Date();
  const reasons = new Set<ProcurementIneligibilityReason>();

  if (input.supplier.status !== 'active') reasons.add('supplier_not_active');
  if (input.supplier.riskLevel === 'blocked') reasons.add('supplier_risk_blocked');

  if (input.account.state === 'killed') reasons.add('account_kill_switched');
  else if (input.account.state !== 'active') reasons.add('account_not_active');

  const agreement = input.agreement;
  if (!agreement) {
    reasons.add('agreement_missing');
  } else {
    if (agreement.approvalState !== 'approved') {
      reasons.add('agreement_not_approved');
    } else if (!isAgreementActive(agreement, now)) {
      // Approved but out of window: name WHICH end of the window failed.
      if (agreement.expiresAt && agreement.expiresAt.getTime() <= now.getTime()) {
        reasons.add('agreement_expired');
      } else {
        reasons.add('agreement_not_effective');
      }
    }
    // The retail-dropship rights conjunction (ADR 0004 D2.10): an agreement
    // that grants less can be approved and active and still source nothing.
    if (!agreementGrantsRetailDropship(agreement)) {
      reasons.add('agreement_rights_insufficient');
    }
    if (input.destinationCountry && !agreementPermitsDestination(agreement, input.destinationCountry)) {
      reasons.add('destination_not_permitted');
    }
    if (input.channel && !agreementPermitsChannel(agreement, input.channel)) {
      reasons.add('channel_not_permitted');
    }
  }

  if (input.offer.status === 'retired') reasons.add('offer_retired');
  const freshness = deriveOfferFreshness(input.offer, now);
  if (freshness === 'expired') reasons.add('offer_expired');
  if (freshness === 'stale') reasons.add('offer_quote_stale');
  if (input.offer.canonicalVariantId === null) reasons.add('offer_unmapped');
  if (
    input.offer.availability === 'out_of_stock' ||
    input.offer.availability === 'discontinued'
  ) {
    reasons.add('offer_out_of_stock');
  }
  if (
    input.destinationCountry &&
    !input.offer.eligibleDestinationCountries.includes(input.destinationCountry.toUpperCase())
  ) {
    reasons.add('destination_not_permitted');
  }

  const sorted = [...reasons].sort();
  return { eligible: sorted.length === 0, reasons: sorted };
}

/**
 * Project one offer plus its verdict into the #57 seam shape.
 *
 * Field-by-field on purpose — never a spread of the offer row, so a column
 * added to `procurement_offers` later (a cost break, a credential hint) can
 * NEVER reach this projection without someone typing it here, into a type
 * that has no property to hold it.
 */
export function projectRetailOfferSourcingSeam(
  offer: EligibilityOfferFacts,
  eligibility: ProcurementEligibility,
): RetailOfferSourcingSeam {
  return {
    procurementOfferId: offer.id,
    canonicalProductId: offer.canonicalProductId,
    canonicalVariantId: offer.canonicalVariantId,
    availability: offer.availability,
    eligibility,
    estimatedDeliveryDaysMin: offer.deliveryDaysMin,
    estimatedDeliveryDaysMax: offer.deliveryDaysMax,
  };
}
