/**
 * The SEAM onto current eligible offers (#57), and the reason it is a seam.
 *
 * #94's hard-constraint rule 6 is blunt: "price, shipping and availability use
 * current eligible offers rather than static product attributes". Honouring that
 * needs the offer model, which #57 is building in parallel and which does not
 * exist on `main` yet. There are exactly three things this issue could do about
 * that, and two of them are wrong:
 *
 * - Read a `price` attribute off `canonical_attribute_values`. That is the
 *   failure mode the rule exists to name, and it is invisible once shipped: the
 *   filter works, the numbers are plausible, and they are whatever a feed said
 *   last month. The registry refuses the key outright
 *   (`RESERVED_OFFER_FACT_KEYS`) so this is not reachable even by accident.
 * - Import `db/canonical/offerRepository` from a branch that has not merged.
 *   That is a build that only compiles on somebody's machine.
 * - Define the narrow PORT the evaluator needs, ship a default implementation
 *   that honestly reports it has no offer data, and let #57 supply the real one.
 *   That is this file.
 *
 * ## Why "no data" is safe rather than convenient
 *
 * {@link unavailableOfferFacts} answers `undefined` for every variant. Every
 * commerce constraint then evaluates `unknown`, and a HARD one with the default
 * `exclude_when_unknown` policy EXCLUDES the candidate. So before #57 lands, a
 * shopper who says "under 300 €" gets nothing rather than everything — the
 * fail-closed direction. Nothing anywhere reports such a constraint SATISFIED,
 * which is the property that must not be traded for results.
 *
 * ## What #57 has to supply, and nothing more
 *
 * One function, `factsForVariants`. It is deliberately batch-shaped (a search
 * page evaluates hundreds of variants) and deliberately returns a snapshot
 * rather than a query builder: the evaluator must not be able to issue its own
 * offer queries, because then "which offers count as eligible" would have two
 * definitions. Eligibility is #57's word, computed once, handed over.
 */

import type { CurrencyCode } from '@mercaria/shared-types';

/**
 * The commercial facts a constraint may ask about, for ONE canonical variant,
 * derived from the offers that are eligible right now.
 *
 * Every field is optional because every one of them is genuinely unknowable for
 * some variants: a variant nobody offers has no price, and a variant offered
 * only externally has no known delivered total. An absent field is `unknown`,
 * never a zero and never a default.
 */
export interface EligibleOfferFacts {
  /** The lowest eligible offer price, in minor units of {@link currency}. */
  readonly lowestPriceMinor?: number;
  /** The lowest KNOWN delivered total — present only when every component is known. */
  readonly lowestKnownTotalMinor?: number;
  /** The currency both amounts above are expressed in. */
  readonly currency?: CurrencyCode;
  /** Availability values across the eligible offers (`in_stock`, `preorder`, …). */
  readonly availability?: readonly string[];
  /** Condition values across the eligible offers (`new`, `refurbished`, …). */
  readonly conditions?: readonly string[];
  /** ISO 3166-1 alpha-2 territories the variant can actually be bought in. */
  readonly territories?: readonly string[];
  /** Whether at least one eligible offer comes from a brand's official channel. */
  readonly hasOfficialChannelOffer?: boolean;
  /** Whether at least one eligible offer reaches Mercaria's own checkout. */
  readonly hasNativeOffer?: boolean;
  /** Whether at least one eligible offer is an external/outbound one. */
  readonly hasExternalOffer?: boolean;
  /** Metres to the nearest eligible seller, when the seller has a location. */
  readonly nearestSellerMetres?: number;
}

/** The viewer context an eligibility computation legitimately depends on. */
export interface OfferFactsContext {
  /** The buyer's presentment currency, when they have one. */
  readonly currency?: CurrencyCode;
  /** The buyer's market, for territory-scoped eligibility. */
  readonly territory?: string;
  /** The buyer's coarse position, for a proximity constraint. */
  readonly latitude?: number;
  readonly longitude?: number;
}

/**
 * The one function #57 supplies.
 *
 * @returns A map from canonical variant id to its facts. A variant ABSENT from
 *   the map has no eligible offers at all, which is a different statement from a
 *   present entry with empty fields (offers exist, but say nothing about the
 *   facet asked). Both evaluate `unknown`; keeping them distinct is what lets an
 *   explanation say "nobody sells this" rather than "we do not know the price".
 */
export interface OfferFactsPort {
  factsForVariants(
    variantIds: readonly string[],
    context: OfferFactsContext,
  ): Promise<ReadonlyMap<string, EligibleOfferFacts>>;
}

/**
 * The default port: no offer data, honestly.
 *
 * NOT a stub returning plausible numbers, and not a throw. A throw would make
 * every search fail while #57 is in flight; plausible numbers would make every
 * price filter answer confidently and wrongly. An empty map makes every commerce
 * constraint `unknown`, which the evaluator then handles under the caller's
 * NAMED missing-data policy — the one path that is correct both before and after
 * #57 lands.
 */
export const unavailableOfferFacts: OfferFactsPort = {
  async factsForVariants(): Promise<ReadonlyMap<string, EligibleOfferFacts>> {
    return new Map();
  },
};

/**
 * The port the evaluator uses.
 *
 * A module-level `let` behind two functions rather than a parameter threaded
 * through every call: the alternative is an optional argument on
 * `evaluateConstraintSet`, and an optional argument that defaults to "no offer
 * data" is one a caller can forget in exactly the situation where forgetting
 * means a price filter silently answers `unknown` for a catalogue that has
 * offers. One registration at boot, one place to look.
 */
let registeredPort: OfferFactsPort = unavailableOfferFacts;

/** Register the real implementation. #57's wiring calls this once, at boot. */
export function registerOfferFactsPort(port: OfferFactsPort): void {
  registeredPort = port;
}

/** The port in force. Returns {@link unavailableOfferFacts} until #57 registers one. */
export function offerFactsPort(): OfferFactsPort {
  return registeredPort;
}

/** Whether a real offer source is wired. Read by validation, to warn honestly. */
export function offerFactsAvailable(): boolean {
  return registeredPort !== unavailableOfferFacts;
}

/** Restore the default. Test-only seam; production never un-registers a port. */
export function resetOfferFactsPort(): void {
  registeredPort = unavailableOfferFacts;
}
