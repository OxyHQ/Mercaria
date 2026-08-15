/**
 * The #74 seam: which offer of a matched product a shopper should be shown.
 *
 * #70's pipeline note draws the line and this module is where it lives: "#74
 * chooses which offer is best; it must not decide whether an unrelated product
 * matches the query", and the converse holds too — search must not decide which
 * offer wins, because a second answer to that question is exactly what #74
 * exists to prevent.
 *
 * ## It FAILS CLOSED, and that is the whole design
 *
 * No selector is registered. Until #74 registers one, every product result
 * carries NO `selectedOffer` — not the cheapest one under another name, not the
 * first row of the summary, not a native offer preferred by default. Each of
 * those would be a ranking decision made here under a name that does not say
 * so, and the one thing worse than a missing feature is a ranking nobody agreed
 * to that looks like one somebody did.
 *
 * What a result DOES carry is `offerSummary`, and the distinction is not
 * cosmetic: the summary reports the LOWEST PRICE, which is a fact about the
 * offers on a product, and it names no offer. A shopper sees "from 1,199 €" and
 * a link to the comparison; nothing claims one seller is the right one.
 *
 * ## Registration — NOTHING registers a selector today (#230)
 *
 * ONE function, the `registerProcurementPaymentAuthorizationReader` /
 * `registerGuestMessageTransport` shape. #74 has shipped and does NOT call
 * {@link registerSearchOfferSelector}; there is no production call site
 * anywhere, and `selected-offer-port.test.ts` fails the build if that stops
 * being true without this header changing with it.
 *
 * This module was written expecting #74 to fill the seam as shaped, and it did
 * not turn out that way. The measured reason, so nobody re-derives it:
 *
 * - `rankOfferComparison` — #74's published entry point, and the ONE function a
 *   discovery surface may call — is `async` and does its own four reads per
 *   subject (`listOffers`, `getRates`, `buildRankingFactContext`,
 *   `resolveRankingPolicy`). It also FETCHES the offers it ranks rather than
 *   accepting the ones a caller already holds. A selector here is synchronous
 *   and is HANDED its offers, so the two cannot be composed as they stand.
 * - The gap is not incidental. `SearchSelectedOffer.rankingPolicyVersion` has to
 *   name the version the choice was made under, and `resolveRankingPolicy` is a
 *   READ keyed on the comparison SUBJECT because the canary rollout buckets on
 *   it. Stamping `BUILTIN_RANKING_POLICY` synchronously instead would attribute
 *   an ordering to weights the rollout never consulted — exactly what #74
 *   refuses to do for `/offers`, and for the same reason.
 *
 * So filling this seam is a change to the port's SHAPE, not a registration
 * somebody forgot. It also needs product decisions search has not made: which
 * `OfferComparisonIntent` a query ranks under, which experience, and whether a
 * search result should recommend a seller at all. Nothing consumes
 * `selectedOffer` today — no storefront screen and no analytics envelope reads
 * it — so there is no consumer waiting on the answer either.
 *
 * The selector receives PROJECTED offers — already freshness-assessed, already
 * narrowed to what a comparison would show — so it cannot select something a
 * search page is not allowed to display, and it cannot reach the raw rows to
 * find out what a seller pays.
 */

import type { Offer, SearchSelectedOffer } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';

/** What a selector is given, per product. */
export interface SearchOfferSelectionInput {
  readonly canonicalProductId: string;
  /**
   * The current offers of that product, cheapest first, already projected.
   *
   * Never empty — a product with no current offer is not passed to a selector
   * at all, so an implementation has no "nothing to choose from" branch and
   * cannot answer one by inventing a placeholder.
   */
  readonly offers: readonly Offer[];
  /** The market in force, when the request named one. */
  readonly market?: string;
}

/**
 * A selector: given one product's current offers, which one leads.
 *
 * Synchronous and pure by contract, because a selector that had to read is a
 * selector that can block a search page.
 *
 * That contract was written on the assumption that #74's inputs — its policy
 * version, its weights — would be things a selector HOLDS rather than things it
 * fetches per product. #74 shipped otherwise: its policy is resolved by a read
 * keyed on each comparison subject. The assumption is left stated rather than
 * quietly relaxed, because it is the thing to revisit first if this seam is ever
 * filled (#230).
 *
 * Returning `undefined` is legitimate and means "no offer should lead here" —
 * a selector may decline, and the result then renders exactly as it does today.
 */
export type SearchOfferSelector = (
  input: SearchOfferSelectionInput,
) => SearchSelectedOffer | undefined;

let selector: SearchOfferSelector | null = null;

/**
 * Register the offer selector. Idempotent per process; a second registration
 * REPLACES the first and says so, because two selectors would be two rankings.
 */
export function registerSearchOfferSelector(next: SearchOfferSelector): void {
  if (selector !== null) {
    log.general.warn(
      {},
      '[search] an offer selector was already registered; replacing it',
    );
  }
  selector = next;
}

/** Test-only seam; production never calls it. */
export function resetSearchOfferSelector(): void {
  selector = null;
}

/**
 * Ask the registered selector, if there is one.
 *
 * Returns `undefined` when none is registered — the fail-closed default. It
 * never throws: a selector's failure must not empty a search page, and a
 * missing lead offer degrades a result rather than removing it.
 */
export function selectSearchOffer(
  input: SearchOfferSelectionInput,
): SearchSelectedOffer | undefined {
  if (selector === null) return undefined;
  try {
    return selector(input);
  } catch (error) {
    log.general.error(
      { err: error, canonicalProductId: input.canonicalProductId },
      '[search] the offer selector threw; the result will carry no lead offer',
    );
    return undefined;
  }
}
