/**
 * Building a {@link CommercialPresentation} from facts that already exist
 * (#129, ADR 0004 D2.8/D9.1, ADR 0002 D8).
 *
 * Pure: every function here takes plain facts and returns a value. Nothing
 * reads a database, a configuration flag or a clock, which is what lets the
 * same four builders serve a listing variant, a cart group, a placed order, a
 * guest portal entry and a checkout summary without any of them composing a
 * legal role for itself (#129 §"Content and legal copy": *do not scatter legal
 * role logic across individual components*).
 *
 * The one thing these builders will NOT do is guess. There is no
 * `presentationFor(anything)` that falls back to `connected_marketplace` when
 * it cannot tell: the caller must have derived a {@link CommercialMode} from
 * real facts through `deriveCommercialMode`, because a default here would be
 * `Sold by ...` attached to whoever happened to own the row.
 */

import {
  commercialDisclosureKeys,
  type CommercialPresentation,
  type ConnectedMarketplacePresentation,
  type ExternalReferralPresentation,
  type InformationalPresentation,
  type MercariaRetailPresentation,
} from '@mercaria/shared-types';
import { config } from '../../config';
import { currentRetailCustomerTerms } from '../retail-fulfilment/customer-terms';

/**
 * Mercaria as seller of record, with the #117 disclosure and today's terms.
 *
 * Reads the terms from `currentRetailCustomerTerms()` — the same code constant
 * #126 snapshots onto a placed order — so what an offer promises and what an
 * order recorded come from one place. For a PLACED order use
 * {@link retailPresentationFromSnapshot} instead: the order recorded the
 * windows in force when it was made, and re-reading today's would show a buyer
 * terms they never agreed to.
 */
export function currentRetailPresentation(): MercariaRetailPresentation {
  const terms = currentRetailCustomerTerms();
  return {
    mode: 'mercaria_retail',
    sellerLegalEntityName: config.retail.sellerLegalEntityName,
    sellerLegalEntityCountry: config.retail.sellerLegalEntityCountry,
    supplierFulfilmentDisclosureKey: terms.supplierFulfilmentDisclosureKey,
    supplierFulfilmentDisclosureVersion: terms.supplierFulfilmentDisclosureVersion,
    rights: {
      termsVersion: terms.customerTermsVersion,
      cancellationWindowHours: terms.cancellationWindowHours,
      withdrawalWindowDays: terms.withdrawalWindowDays,
      returnWindowDays: terms.returnWindowDays,
      warrantyMonths: terms.warrantyMonths,
    },
    disclosures: commercialDisclosureKeys({ mode: 'mercaria_retail' }),
  };
}

/** The immutable role facts #126 wrote with the order. */
export interface RetailOrderRoleFacts {
  sellerLegalEntityName: string;
  sellerLegalEntityCountry: string;
  supplierFulfilmentDisclosureKey: string;
  supplierFulfilmentDisclosureVersion: number;
  customerTermsVersion: string;
  cancellationWindowHours: number;
  withdrawalWindowDays: number;
  returnWindowDays: number;
  warrantyMonths: number;
}

/**
 * Mercaria as seller of record, as ONE placed order recorded it.
 *
 * Everything comes off the snapshot and nothing from configuration or from
 * today's constants: #129 order rule 9 is that a later Oxy claim does not change
 * the original seller, and the same reasoning covers a terms revision, a
 * change of legal entity and a new disclosure version. A receipt reprinted next
 * year has to say what the buyer bought under.
 */
export function retailPresentationFromSnapshot(
  snapshot: RetailOrderRoleFacts,
): MercariaRetailPresentation {
  return {
    mode: 'mercaria_retail',
    sellerLegalEntityName: snapshot.sellerLegalEntityName,
    sellerLegalEntityCountry: snapshot.sellerLegalEntityCountry,
    supplierFulfilmentDisclosureKey: snapshot.supplierFulfilmentDisclosureKey,
    supplierFulfilmentDisclosureVersion: snapshot.supplierFulfilmentDisclosureVersion,
    rights: {
      termsVersion: snapshot.customerTermsVersion,
      cancellationWindowHours: snapshot.cancellationWindowHours,
      withdrawalWindowDays: snapshot.withdrawalWindowDays,
      returnWindowDays: snapshot.returnWindowDays,
      warrantyMonths: snapshot.warrantyMonths,
    },
    disclosures: commercialDisclosureKeys({ mode: 'mercaria_retail' }),
  };
}

/**
 * A connected merchant or a P2P seller, with Mercaria processing the payment.
 *
 * `sellerRole` defaults to `unknown` rather than `direct` when the caller has
 * not resolved the channel's operator. ADR 0002 D8 derives marketplace-ness by
 * comparing the offer's seller of record against `storefronts.merchant_id`, and
 * a surface with no offer row in hand — a native listing, a cart group, an
 * order — has not made that comparison. Reporting `direct` there would be the
 * stronger claim on no evidence.
 */
export function marketplacePresentation(input: {
  sellerKind: 'store' | 'user';
  sellerLabel: string;
  sellerRole?: 'direct' | 'marketplace' | 'unknown';
}): ConnectedMarketplacePresentation {
  return {
    mode: 'connected_marketplace',
    sellerKind: input.sellerKind,
    sellerLabel: input.sellerLabel,
    sellerRole: input.sellerRole ?? 'unknown',
    disclosures: commercialDisclosureKeys({ mode: 'connected_marketplace' }),
  };
}

/**
 * A destination outside Mercaria.
 *
 * `affiliateDisclosureRequired` is TRUE for #57's `affiliate` kind and false for
 * a plain `external` one, which is the distinction that kind exists to make: an
 * `external` destination is a retailer's own page Mercaria observed, an
 * `affiliate` destination is one Mercaria may be paid for. Only the second owes
 * a paid-relationship disclosure, and deriving it from the kind rather than
 * from a per-source flag is what keeps the two from disagreeing.
 *
 * The host is passed in already extracted, never the tracked URL: #66 and #65
 * both forbid Mercaria composing or mutating a tracking link, and a customer
 * surface has no reason to hold one.
 */
export function externalReferralPresentation(input: {
  offerKind: 'external' | 'affiliate';
  destinationMerchantLabel?: string;
  destinationHost?: string;
}): ExternalReferralPresentation {
  const affiliateDisclosureRequired = input.offerKind === 'affiliate';
  const presentation: ExternalReferralPresentation = {
    mode: 'external_referral',
    affiliateDisclosureRequired,
    disclosures: commercialDisclosureKeys({
      mode: 'external_referral',
      affiliateDisclosureRequired,
    }),
  };
  if (input.destinationMerchantLabel) {
    presentation.destinationMerchantLabel = input.destinationMerchantLabel;
  }
  if (input.destinationHost) {
    presentation.destinationHost = input.destinationHost;
  }
  return presentation;
}

/**
 * The seller a buyer reads, for a presentation that came off an ORDER.
 *
 * A `switch` over the union rather than a `sellerLabel` field, because the
 * union deliberately has no common one: a merchant's display name and
 * Mercaria's legal entity are different facts about different parties, and one
 * accessor reading both is how they get swapped.
 *
 * The two non-order modes THROW rather than returning a neutral string.
 * `orders.commercial_role` has exactly two members and a CHECK ties them to
 * `seller_type`, so an order in either of the other two is not a state the
 * database can be in — and a quiet fallback would turn that impossibility into
 * a blank seller on somebody's receipt, which is the one failure this whole
 * domain exists to prevent. A customer-facing surface that legitimately holds
 * an external or informational presentation renders it from `@mercaria/ui`'s
 * own `commercialSellerLabel`, which has copy for all four.
 */
export function orderSellerLabel(presentation: CommercialPresentation): string {
  switch (presentation.mode) {
    case 'mercaria_retail':
      return presentation.sellerLegalEntityName;
    case 'connected_marketplace':
      return presentation.sellerLabel;
    case 'external_referral':
    case 'informational':
      throw new Error(
        `An order cannot carry the \`${presentation.mode}\` commercial mode; ` +
          '`orders_commercial_role_seller_check` makes it unrepresentable.',
      );
  }
}

/** Context with no purchase action. */
export function informationalPresentation(): InformationalPresentation {
  return {
    mode: 'informational',
    disclosures: commercialDisclosureKeys({ mode: 'informational' }),
  };
}
