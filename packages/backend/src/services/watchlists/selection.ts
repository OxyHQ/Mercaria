/**
 * Choosing ONE offer for a watchlist item, out of #74's ranked comparison (#81
 * item rules 1 and 2).
 *
 * Pure, and deliberately narrow: it receives a comparison somebody else asked
 * for and returns which row of it this item is priced from. Everything about
 * WHICH offers exist, whether they may be shown, and in what order, is #74's —
 * this file re-derives none of it and could not, because the facts eligibility
 * reads are not in the shape it is handed.
 *
 * ## The intent is `cheapest`, and that is a decision worth stating
 *
 * A watchlist tracks what a set of things would COST, so the selection key has
 * to be cost. Ranking under `balanced` would put a total on the page that no
 * ordering of the offers explains — the buyer would see a number and, beside it,
 * an offer that is not the cheapest one they could have had, with nothing saying
 * why. #74's `cheapest` intent is already three tiers (known total, then known
 * item price, then neither), so "the cheapest one whose price we actually know"
 * is the first row that survives the filters below rather than a second sort.
 *
 * ## A preferred VARIANT is a scope, not a filter
 *
 * When an item pins a configuration the comparison is asked about that canonical
 * VARIANT, so the narrowing happens in SQL and #74's `canonical_variant_match`
 * rule has nothing left to exclude. Only the merchant preference is applied
 * here, for the reason #80's `best-offer.ts` gives: `listOffers` takes no
 * merchant filter, and adding one to #57's contract for a watchlist's benefit
 * would put a list concern into the comparison read every product page runs.
 */

import type { Offer, RankedOffer } from '@mercaria/shared-types';
import { hasKnownPrice } from '@mercaria/shared-types';

/** What the selection is handed. */
export interface WatchlistOfferSelectionInput {
  /** #74's ranked comparison, in its own order. */
  readonly ranked: readonly RankedOffer[];
  /** Every offer the comparison considered, by id — including the excluded ones. */
  readonly offers: ReadonlyMap<string, Offer>;
  /** #81 model rule 7. `null` and `undefined` both mean "any seller". */
  readonly preferredMerchantId?: string | null;
}

/**
 * Which offer an item is priced from, or why none.
 *
 * The two refusals are computed from two DIFFERENT filters and are never
 * collapsed: `no_eligible_offer` means the buyer's own preference excluded
 * everything (the answer is to widen it), while `price_not_convertible` means
 * offers matched and not one of them carries a price this comparison can express
 * (the answer is nothing the buyer can do). Reporting the second as the first
 * would send somebody to loosen a filter that was never the problem.
 */
export type WatchlistOfferSelection =
  | { readonly state: 'selected'; readonly ranked: RankedOffer; readonly offer: Offer }
  | {
      readonly state: 'none';
      readonly reason: 'no_eligible_offer' | 'price_not_convertible';
    };

/**
 * The first ranked offer this item may be priced from.
 *
 * "May be priced from" is two conditions and their ORDER is what makes the two
 * refusals distinguishable: the preference is applied first, so a set narrowed
 * to nothing reports the preference, and only a set that survived it can report
 * an unusable price.
 */
export function selectWatchlistOffer(
  input: WatchlistOfferSelectionInput,
): WatchlistOfferSelection {
  const preferredMerchantId = input.preferredMerchantId ?? undefined;

  const matching = input.ranked.filter((ranked) => {
    if (preferredMerchantId === undefined) return true;
    const offer = input.offers.get(ranked.offerId);
    return offer !== undefined && offer.merchantId === preferredMerchantId;
  });

  if (matching.length === 0) return { state: 'none', reason: 'no_eligible_offer' };

  for (const ranked of matching) {
    if (!hasKnownPrice(ranked.cost.itemPrice)) continue;
    const offer = input.offers.get(ranked.offerId);
    // An offer the comparison ranked but did not return is not a state this
    // domain can act on: without the DTO there is no merchant, no availability
    // and no condition to record, so it is skipped rather than half-recorded.
    if (offer === undefined) continue;
    return { state: 'selected', ranked, offer };
  }

  return { state: 'none', reason: 'price_not_convertible' };
}
