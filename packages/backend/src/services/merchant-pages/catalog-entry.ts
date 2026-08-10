/**
 * One canonical-product card, derived from the offers a scope currently makes
 * of it (#73 catalogue-browse rules 1, 2 and 6; acceptance 5).
 *
 * PURE, over ALREADY-PROJECTED offers. That matters twice: the freshness
 * verdict, the seller role and the checkout eligibility on each offer were
 * computed by #57's `projectOffer` from LIVE facts, so a card can never claim a
 * price whose listing a jury restricted a second ago; and the card's own
 * derivations are testable against exact inputs rather than against whatever a
 * fixture happened to write.
 *
 * ## The card has no rating, and that is the point
 *
 * `MERCHANT_CATALOG_FORBIDDEN_ENTRY_FIELDS` names `rating`, `ratingCount`,
 * `reviewCount`, `merchantRating` and `sellerRating` as values a gate scans
 * for. A merchant page already carries one star rating — the merchant's, under
 * its own scope label — and a second one on every card beside it is read as the
 * same measurement. That is #73 trust rule 5 ("merchant ratings never become
 * product ratings") and #76 UI rule 6, and the enforcement is that the field
 * does not exist rather than that a serializer remembers not to fill it.
 *
 * ## Bounded, and it says so
 *
 * The offers reaching this function are the cheapest `SUMMARY_OFFER_LIMIT` of
 * the product in scope — the SAME depth `readProductOfferSummary` and #70's
 * search page use, so `currentOfferCount` means the same number on a merchant
 * page, a search page and a product page. A product with more current offers
 * than that in one scope is one whose exact count nobody is deciding anything
 * from.
 */

import { CONDITION_KEY_GROUP, rollUpOfferAvailability } from '@mercaria/shared-types';
import type {
  ConditionGroup,
  MerchantCatalogEntry,
  Offer,
  OfferAvailability,
} from '@mercaria/shared-types';
import { isCurrentForSummary } from '../offer-freshness/product-summary.js';

/** The canonical product facts a card renders, as the hydration read them. */
export interface CatalogEntryProduct {
  readonly canonicalProductId: string;
  readonly slug: string;
  readonly name: string;
  readonly brand?: { readonly id: string; readonly slug: string; readonly name: string };
  readonly categoryId?: string;
  readonly image?: {
    readonly fileId: string | null;
    readonly sourceUrl: string | null;
    readonly alt: string | null;
  };
}

/**
 * Build one card.
 *
 * `projected` must arrive CHEAPEST FIRST — the order both the ranking statement
 * and `summariseProjectedOffers` rely on — because the representative offer is
 * taken as the first CURRENT one rather than by comparing integers across
 * currencies. Comparing a 1,199 EUR offer against a 4,500 PLN one by their
 * minor units answers with whichever currency has the smaller unit, which is
 * why no module in this domain does arithmetic on a price at all.
 *
 * `pageMerchantId` is whose page this is, and the only thing it decides is
 * `hasOtherSellers` — the flag a marketplace operator's page needs so a card
 * can say "and N other sellers" instead of implying the operator sells all of
 * it (#73 storefront rule 5).
 */
export function toMerchantCatalogEntry(input: {
  product: CatalogEntryProduct;
  projected: readonly Offer[];
  pageMerchantId: string;
}): MerchantCatalogEntry {
  const current = input.projected.filter(isCurrentForSummary);

  const channels = new Set<string>();
  const groups = new Set<ConditionGroup>();
  const availabilities: OfferAvailability[] = [];
  let hasOtherSellers = false;

  for (const offer of current) {
    if (offer.storefrontId !== undefined) channels.add(offer.storefrontId);
    // `condition.key` is absent when the source's wording did not map (#90);
    // an unmapped condition contributes to NO segment, because filing it under
    // one would be Mercaria guessing what the retailer meant.
    const key = offer.condition.key;
    if (key !== undefined) groups.add(CONDITION_KEY_GROUP[key]);
    availabilities.push(offer.availability);
    if (offer.merchantId !== undefined && offer.merchantId !== input.pageMerchantId) {
      hasOtherSellers = true;
    }
  }

  const representative = current[0];

  return {
    canonicalProductId: input.product.canonicalProductId,
    slug: input.product.slug,
    name: input.product.name,
    ...(input.product.brand === undefined ? {} : { brand: input.product.brand }),
    ...(input.product.categoryId === undefined ? {} : { categoryId: input.product.categoryId }),
    ...(input.product.image === undefined ? {} : { image: input.product.image }),
    ...(representative === undefined ? {} : { representativeOffer: representative }),
    currentOfferCount: current.length,
    eligibleChannelCount: channels.size,
    conditionGroups: [...groups].sort(),
    availability: rollUpOfferAvailability(availabilities),
    hasOtherSellers,
  };
}
