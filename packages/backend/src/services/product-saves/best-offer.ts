/**
 * The current best offer for a saved product, and why there is none (#80 API
 * rules 3 and 4, acceptance 7).
 *
 * The whole file is one seam onto #57. It calls `listOffers` — the SAME
 * comparison read a product page uses, cheapest first, with
 * `deriveNativeCheckoutEligibility` already applied — and never queries the
 * `offers` table itself. Two paths deciding what "the best offer" means would
 * disagree the first time one of them forgot a filter, and the one people would
 * notice is the saved list, days later, showing a price nobody can buy at.
 *
 * ## Absence is a value with a reason, and that is acceptance 7
 *
 * "Saved-product pages remain useful when all prior offers expire." A saved
 * product with nothing to buy has to say WHICH kind of nothing it is:
 * - `no_offers_recorded` — nothing was ever observed for this product.
 * - `all_offers_retired` — offers exist and every one has lapsed or been
 *   withdrawn.
 * - `no_eligible_offer` — offers are live but the buyer's own preferences
 *   (condition segment, seller, configuration) exclude all of them.
 *
 * The third is the one that matters most and is the reason the preferences are
 * applied HERE rather than by the caller: reported as `all_offers_retired` it
 * would send a buyer to look for a product that is on sale, when the answer is
 * to widen their own filter.
 */

import type { ConditionGroup, SavedProductOffer } from '@mercaria/shared-types';
import { listOffers } from '../offers/offer.service.js';

/** The buyer's own narrowing, applied to the comparison read. */
export interface BestOfferPreferences {
  readonly preferredCanonicalVariantId?: string | null;
  readonly preferredConditionGroup?: ConditionGroup | null;
  readonly preferredMerchantId?: string | null;
}

/**
 * How many offers to read before deciding.
 *
 * The read is cheapest-first, so the FIRST offer is the answer when no
 * preference narrows it. A small page is fetched anyway because a merchant
 * preference is applied in JavaScript — `listOffers` takes no merchant filter,
 * and adding one to #57's contract for #80's benefit would put a saved-list
 * concern into the comparison read every product page runs.
 */
const BEST_OFFER_SCAN_LIMIT = 25;

/**
 * The best offer a buyer could act on for one canonical product, given their
 * own preferences — or a reasoned absence.
 */
export async function readBestOfferForProduct(
  canonicalProductId: string,
  preferences: BestOfferPreferences = {},
): Promise<SavedProductOffer> {
  const live = await listOffers({
    canonicalProductId,
    limit: BEST_OFFER_SCAN_LIMIT,
    ...(preferences.preferredConditionGroup
      ? { conditionGroups: [preferences.preferredConditionGroup] }
      : {}),
  });

  if (live.offers.length === 0) {
    // `includeStale` defaults to excluding lapsed offers, so an empty live page
    // is either "never had any" or "had some and they all went". Distinguishing
    // them is one more read and it is worth it: the two send a buyer to
    // completely different next actions.
    const everything = await listOffers({
      canonicalProductId,
      limit: 1,
      includeStale: true,
    });
    return {
      state: 'none',
      reason: everything.offers.length === 0 ? 'no_offers_recorded' : 'all_offers_retired',
    };
  }

  const matching = live.offers.filter((offer) => {
    if (
      preferences.preferredCanonicalVariantId &&
      offer.canonicalVariantId !== preferences.preferredCanonicalVariantId
    ) {
      return false;
    }
    if (preferences.preferredMerchantId && offer.merchantId !== preferences.preferredMerchantId) {
      return false;
    }
    return true;
  });

  const best = matching[0];
  if (!best) return { state: 'none', reason: 'no_eligible_offer' };

  return {
    state: 'available',
    offerId: best.id,
    canonicalVariantId: best.canonicalVariantId,
    ...(best.price ? { price: { amount: best.price.amount, currency: best.price.currency } } : {}),
    availability: best.availability,
    conditionKey: best.condition.key,
    ...(best.condition.group ? { conditionGroup: best.condition.group } : {}),
    nativeCheckoutEligible: best.checkout.eligible,
    ...(best.listingId ? { listingId: best.listingId } : {}),
    ...(best.merchantId ? { merchantId: best.merchantId } : {}),
  };
}
