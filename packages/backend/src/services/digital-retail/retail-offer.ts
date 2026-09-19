/**
 * The seam toward the future public `mercaria_retail` offer (#57), for the
 * DIGITAL half (#1016 Workstream 5, ADR 0011 D13).
 *
 * ## Why a seam rather than a public offer
 *
 * Mercaria's unified public offer domain is #57 and does not exist. #118 met the
 * same wall for physical retail and answered it with `RetailOfferSourcingSeam` —
 * a projection carrying identity, availability and the derived verdict, and
 * structurally NOT carrying wholesale cost, supplier identity or agreement terms.
 * This is that, for digital supply, and #57's `mercaria_retail` offer kind
 * composes over it when it lands.
 *
 * ## Both projections are built FIELD BY FIELD, never by a spread
 *
 * A spread of a candidate row would carry every column it happens to have, so a
 * cost break or a credential hint added to `digital_procurement_offers` next year
 * would reach a public API by inheritance. Typing each field means a new column
 * cannot arrive here without somebody writing its name into a type that has no
 * property to hold it.
 */

import type {
  DigitalProcurementEligibility,
  DigitalRetailOfferView,
  DigitalRetailSourcingSeam,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import type { DigitalProcurementCandidate } from '../../db/digitalRetail/digitalProcurementOfferRepository.js';
import { findActivePricingPolicy } from '../../db/digitalRetail/pricingPolicyRepository.js';
import { config } from '../../config/index.js';
import { priceDigitalRetailOffer } from './pricing.js';

/**
 * Project one private candidate into the #57 seam.
 *
 * The eligibility verdict rides along because the seam's whole job is to let a
 * public surface ask "is there supply for this" without being able to ask
 * "from whom" or "at what cost".
 */
export function projectDigitalRetailSourcingSeam(
  candidate: DigitalProcurementCandidate,
  eligibility: DigitalProcurementEligibility,
): DigitalRetailSourcingSeam {
  return {
    digitalProcurementOfferId: candidate.offerId,
    canonicalProductId: candidate.canonicalProductId,
    canonicalVariantId: candidate.canonicalVariantId,
    productClass: candidate.productClass,
    fulfilmentCapability: candidate.fulfilmentCapability,
    mappingStatus: candidate.mappingStatus,
    eligibility,
    expectedFulfilmentSeconds: candidate.expectedFulfilmentSeconds,
  };
}

/** Why a public retail offer could not be composed. Closed, and all actionable. */
export type RetailOfferRefusal =
  | 'publication_disabled'
  | 'no_eligible_supply'
  | 'unmapped'
  | 'not_priced';

/** A public offer, or the reason there is not one. */
export type ComposeRetailOfferResult =
  | { readonly composed: true; readonly offer: DigitalRetailOfferView }
  | { readonly composed: false; readonly refusal: RetailOfferRefusal };

/**
 * Compose the one PUBLIC offer for a canonical variant in one market.
 *
 * The order of the refusals is the order a reader needs them in: the lever, then
 * whether any supply is eligible at all, then whether it is mapped exactly, then
 * whether a policy prices it. Each is a different remedy — a deployment switch, a
 * supplier problem, a catalogue problem, a commercial decision.
 *
 * **The cheapest eligible cost is what gets priced, and the supplier that
 * supplied it is not returned.** That is the whole privacy property in one line:
 * the retail price is a function of the POLICY and the class, so a buyer cannot
 * infer which supplier won, and this function has nothing to hand them if they
 * tried.
 */
export async function composeDigitalRetailOffer(
  candidates: readonly { candidate: DigitalProcurementCandidate; eligibility: DigitalProcurementEligibility }[],
  market: string,
  tx?: DatabaseOrTransaction,
): Promise<ComposeRetailOfferResult> {
  if (!config.digitalRetail.publicationEnabled) {
    return { composed: false, refusal: 'publication_disabled' };
  }
  const eligible = candidates.filter((entry) => entry.eligibility.eligible);
  if (eligible.length === 0) return { composed: false, refusal: 'no_eligible_supply' };

  // The cheapest ELIGIBLE cost prices the offer; which supplier it came from is
  // deliberately not carried past this line. Pricing off the cheapest rather than
  // off the one the selector would choose is the safe direction: the buyer's
  // price must not rise because routing preferred a stronger provenance.
  const cheapest = eligible.reduce((best, entry) =>
    entry.candidate.costAmount < best.candidate.costAmount ? entry : best,
  );
  const source = cheapest.candidate;
  if (!source.canonicalVariantId || source.mappingStatus !== 'exact') {
    return { composed: false, refusal: 'unmapped' };
  }

  const policy = await findActivePricingPolicy(market, source.productClass, tx);
  const priced = priceDigitalRetailOffer(
    { amount: source.costAmount, currency: source.costCurrency },
    policy,
  );
  if (!priced.priced) return { composed: false, refusal: 'not_priced' };

  return {
    composed: true,
    offer: {
      canonicalVariantId: source.canonicalVariantId,
      productClass: source.productClass,
      platform: source.platform,
      activationEcosystem: source.activationEcosystem,
      edition: source.edition,
      activationTerritories: source.activationTerritories,
      fulfilmentCapability: source.fulfilmentCapability,
      retailAmount: priced.retailAmount,
      currency: priced.currency,
      soldBy: 'mercaria',
      requiresPlatformAccountLink:
        source.fulfilmentCapability === 'external_account_link_activation',
      expectedFulfilmentSeconds: source.expectedFulfilmentSeconds,
    },
  };
}
