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
 * ## Registration
 *
 * ONE function, the `registerProcurementPaymentAuthorizationReader` /
 * `registerGuestMessageTransport` shape. #74 calls
 * {@link registerSearchOfferSelector} at composition time with an implementation
 * that reads its own policy version, and nothing else in #70 changes.
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
 * Synchronous and pure by contract. A selector that had to read is a selector
 * that can block a search page, and #74's own inputs (its policy version, its
 * weights) are things it holds, not things it fetches per product.
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
