/**
 * The offer half of a search page: availability, lowest price, condition
 * segments, the price filter and the official-channel filter — for EVERY
 * product on the page, in a bounded number of statements.
 *
 * ## Where each rule it implements comes from
 *
 * - **#68 freshness.** Every offer here is projected through `projectOffer`,
 *   which assesses freshness against the SOURCE's own contract, and only
 *   `current` / `warning` offers reach a summary (`isCurrentForSummary`, #68's
 *   own predicate, imported rather than restated). #70 freshness rule 3 —
 *   "stale/expired price cannot be presented as a current best price" — is
 *   therefore a property of the projection rather than of a filter here.
 * - **#70 freshness rule 1.** A product with no current offer keeps its result
 *   and carries NO summary. Absence is the answer; a zero price is not.
 * - **#70 freshness rule 5.** A restricted or unpublished native listing stops
 *   contributing sellable availability the moment the status changes, because
 *   `deriveNativeCheckoutEligibility` reads `listings.status` LIVE inside the
 *   projection. Nothing here caches it.
 * - **#70 filter 3.** A price bound is applied in ONE named currency, and an
 *   offer in another currency is converted once per request through
 *   `fx.service` with the rate map's provider and `asOf` reported back. An
 *   offer whose currency has no rate is EXCLUDED and its currency is named in
 *   the response, because an unconvertible price cannot be shown to satisfy a
 *   bound and silently keeping it would be exactly the raw cross-currency
 *   comparison #70 forbids.
 * - **#70 filter 7.** "Official/authorized channel" is read LIVE from #55's
 *   temporal relationships for the product's own brand, so a lapsed
 *   authorization stops qualifying with no sweep having run — the same reason
 *   #55 refuses to trust `status` alone.
 *
 * ## Ranking lives in #74 and none of it lives here
 *
 * Offers are ordered by price because that is how the CHEAPEST slice is
 * identified for a summary. Which offer a shopper should be shown is
 * `selected-offer.port.ts`, which fails closed. Nothing in this module reads a
 * fee, a commission, a referral, a plan or a payment rail, and
 * `search-relevance-isolation.test.ts` fails the build if it starts to.
 */

import { ALL_CURRENCY_CODES } from '@mercaria/shared-types';
import type {
  ConditionGroup,
  CurrencyCode,
  Offer,
  ProductOfferSummary,
  SearchFilters,
  SearchFxContext,
  SearchSelectedOffer,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  loadOffersWithChannel,
  rankProductOfferIds,
  type SearchOfferScope,
} from '../../db/search/searchOfferRepository.js';
import { findCurrentRelationships } from '../../db/commerce-graph/relationshipRepository.js';
import { buildOfferProjectionContext } from '../offers/offer.service.js';
import { projectOffer } from '../offers/offer-projection.js';
import {
  isCurrentForSummary,
  summariseProjectedOffers,
  SUMMARY_OFFER_LIMIT,
} from '../offer-freshness/product-summary.js';
import { convert, getRates } from '../fx.service.js';
import { selectSearchOffer } from './selected-offer.port.js';
import { log } from '../../lib/logger.js';

/** Everything a product result learns from its offers. */
export interface ProductOfferContext {
  readonly summary?: ProductOfferSummary;
  readonly conditionGroups: readonly ConditionGroup[];
  readonly selectedOffer?: SearchSelectedOffer;
  /** Whether any current offer satisfied the price bound, when one was asked. */
  readonly satisfiesPrice: boolean;
  /** Whether any current offer came from an official or authorized channel. */
  readonly fromOfficialChannel: boolean;
}

/** The page-wide outcome: one context per product, plus the FX it converted with. */
export interface SearchOfferContexts {
  readonly byProductId: ReadonlyMap<string, ProductOfferContext>;
  readonly fx?: SearchFxContext;
}

/** A product with no offers at all, so a caller never branches on `undefined`. */
const EMPTY_CONTEXT: ProductOfferContext = {
  conditionGroups: [],
  // No offers means no offer satisfies a bound, and none came from an official
  // channel. Both defaults are the EXCLUDING ones: an unknown must never
  // satisfy a filter (`~/AGENTS.md` — unknown is never a soft yes).
  satisfiesPrice: false,
  fromOfficialChannel: false,
};

/**
 * The block reasons that mean a native listing is NOT PUBLISHED.
 *
 * #70 freshness rule 5 — "removed/restricted native listings stop contributing
 * sellable availability promptly" — needs one more predicate than #68's
 * freshness gives, and the difference is worth stating because it caught a real
 * bug on this file's first realdb run.
 *
 * `nativeOfferFreshness` measures how long ago the CONVERGER ran, so a native
 * offer whose listing was restricted five minutes ago is still perfectly
 * `current`: the projection marks it `checkout.eligible: false` and
 * `listOffersForComparison` still returns it, correctly, because `GET /offers`
 * shows an ineligible row with its reasons. A SEARCH SUMMARY is a different
 * claim — "this product starts at 100 €" — and a price nobody can act on has no
 * business being that number.
 *
 * TWO reasons and not the whole set, deliberately. `out_of_stock` and
 * `seller_not_payment_ready` also block checkout and are NOT removals: an
 * out-of-stock listing is still the product's price, and a seller who has not
 * finished Stripe onboarding has not withdrawn anything. Excluding those would
 * empty a young marketplace's search results for a reason nobody asked for.
 */
const NATIVE_UNPUBLISHED_REASONS = new Set(['listing_restricted', 'listing_not_active']);

/**
 * Whether a projected offer may contribute to a product's summary.
 *
 * #68's freshness predicate, AND the publication test above for native offers.
 * An external offer is unaffected: a retailer's page is not something Mercaria
 * publishes, and its availability is the source's statement.
 */
function contributesToSummary(offer: Offer): boolean {
  if (!isCurrentForSummary(offer)) return false;
  if (offer.kind !== 'native') return true;
  if (offer.checkout.eligible === true) return true;
  return !offer.checkout.reasons.some((reason) => NATIVE_UNPUBLISHED_REASONS.has(reason));
}

/** Narrow a wire currency string to the presentment set, or answer `null`. */
function asCurrencyCode(value: string): CurrencyCode | null {
  return (ALL_CURRENCY_CODES as readonly string[]).includes(value)
    ? (value as CurrencyCode)
    : null;
}

/**
 * Which currencies the page must be able to convert FROM, to answer the bound.
 *
 * Collected across every offer first and converted with ONE rate map, rather
 * than a `getRates` per product: the rate lookup is cached and cheap, but a
 * per-product call would make the page's FX behaviour depend on how many
 * products it happened to return.
 */
function collectPricedCurrencies(offers: readonly Offer[]): Set<string> {
  const currencies = new Set<string>();
  for (const offer of offers) {
    if (offer.price !== undefined) currencies.add(offer.price.currency);
  }
  return currencies;
}

/**
 * Whether one offer's price falls inside the bound, once converted.
 *
 * THREE answers, not two, and the third is the reason this is not a boolean.
 * `unconvertible` covers an unpriced offer, a currency outside Mercaria's
 * presentment set, and a pair the rate map could not serve — all of which mean
 * "Mercaria cannot say", and none of which may be reported as "too expensive".
 * The caller names those currencies in {@link SearchFxContext} so the exclusion
 * is visible rather than silent, which is #70's "explicit FX behavior".
 */
type PriceVerdict = 'within' | 'outside' | 'unconvertible';

function evaluatePriceBound(
  offer: Offer,
  filter: NonNullable<SearchFilters['price']>,
  target: CurrencyCode,
  rates: Awaited<ReturnType<typeof getRates>> | null,
): PriceVerdict {
  if (offer.price === undefined) return 'unconvertible';
  const source = asCurrencyCode(offer.price.currency);
  if (source === null) return 'unconvertible';

  let amount: number;
  if (source === target) {
    // A same-currency comparison needs no rate at all, so it stays answerable
    // on a page where FX is unavailable entirely.
    amount = offer.price.amount;
  } else if (rates === null) {
    return 'unconvertible';
  } else {
    try {
      // `convert` throws when either side has no rate — it never fabricates
      // one. That refusal IS the answer here, so it is caught and reported
      // rather than allowed to fail the page.
      amount = convert({ amount: offer.price.amount, currency: source }, target, rates).amount;
    } catch {
      return 'unconvertible';
    }
  }

  if (filter.minMinor !== undefined && amount < filter.minMinor) return 'outside';
  if (filter.maxMinor !== undefined && amount > filter.maxMinor) return 'outside';
  return 'within';
}

/**
 * Which of these brands have at least one merchant holding a live official or
 * authorized-reseller relationship — read once for the whole page.
 *
 * `findCurrentRelationships` evaluates the validity window in the statement, so
 * an authorization that lapsed a minute ago produces no qualifying merchant
 * whether or not any sweep has run (#55's public-read rule).
 */
async function loadOfficialMerchantsByBrand(
  db: DatabaseOrTransaction,
  brandIds: readonly string[],
  market: string | undefined,
  now: Date,
): Promise<Map<string, Set<string>>> {
  const byBrand = new Map<string, Set<string>>();
  for (const brandId of brandIds) {
    const rows = await findCurrentRelationships(db, {
      kinds: ['merchant_official_channel_for_brand', 'merchant_authorized_reseller_for_brand'],
      brandId,
      ...(market === undefined ? {} : { market }),
      at: now,
    });
    const merchantIds = new Set<string>();
    for (const row of rows) {
      if (row.merchantId !== null) merchantIds.add(row.merchantId);
    }
    byBrand.set(brandId, merchantIds);
  }
  return byBrand;
}

/**
 * Build the offer context for a whole page of products.
 *
 * Statement budget, per page and independent of the page's width: one ranking
 * pass, one hydration, `buildOfferProjectionContext`'s own fixed set, one
 * `getRates` when a price filter is present, and one relationship read per
 * DISTINCT BRAND when the official-channel filter is present. The last is the
 * only term that scales with the page, and it scales with distinct brands
 * rather than with results — a page of twenty phones from one brand is one
 * read.
 */
export async function buildSearchOfferContexts(
  db: DatabaseOrTransaction,
  input: {
    products: readonly { canonicalProductId: string; brandId: string | null }[];
    filters: SearchFilters;
    now: Date;
  },
): Promise<SearchOfferContexts> {
  const productIds = input.products.map((product) => product.canonicalProductId);
  if (productIds.length === 0) return { byProductId: new Map() };

  const scope: SearchOfferScope = {
    ...(input.filters.market === undefined ? {} : { market: input.filters.market }),
    ...(input.filters.offerKinds === undefined ? {} : { kinds: input.filters.offerKinds }),
    ...(input.filters.availability === undefined
      ? {}
      : { availability: input.filters.availability }),
    ...(input.filters.conditionGroups === undefined
      ? {}
      : { conditionGroups: input.filters.conditionGroups }),
    ...(input.filters.merchantIds === undefined ? {} : { merchantIds: input.filters.merchantIds }),
  };

  const ranked = await rankProductOfferIds(db, {
    canonicalProductIds: productIds,
    // The SAME depth `readProductOfferSummary` uses, imported rather than
    // chosen — see that constant's own comment. Two depths would make one
    // product's `currentOfferCount` differ between a search page and its own
    // product page, with nothing in either response saying why.
    limitPerProduct: SUMMARY_OFFER_LIMIT,
    scope,
    now: input.now,
  });

  const offerIds = ranked.map((row) => row.offerId);
  const rows = await loadOffersWithChannel(db, offerIds);
  const context = await buildOfferProjectionContext(rows, input.now, db);
  const projectedById = new Map<string, Offer>();
  for (const row of rows) {
    projectedById.set(
      row.offer.id,
      projectOffer(row.offer, row.storefrontOperatorMerchantId, context),
    );
  }

  // Regroup in the RANKED order — `loadOffersWithChannel` returns rows in
  // whatever order the planner produced, and the summary's "first priced offer
  // is the cheapest" rule depends on the cheapest-first order the ranking pass
  // established. Reading them back through `ranked` is what preserves it.
  const projectedByProduct = new Map<string, Offer[]>();
  for (const row of ranked) {
    const offer = projectedById.get(row.offerId);
    if (offer === undefined) continue;
    const list = projectedByProduct.get(row.canonicalProductId) ?? [];
    list.push(offer);
    projectedByProduct.set(row.canonicalProductId, list);
  }

  const priceFilter = input.filters.price;
  const target = priceFilter === undefined ? null : asCurrencyCode(priceFilter.currency);
  let fx: SearchFxContext | undefined;
  let rates: Awaited<ReturnType<typeof getRates>> | null = null;

  if (priceFilter !== undefined && target !== null) {
    const currencies = collectPricedCurrencies([...projectedById.values()]);
    const quotes = [...currencies]
      .map(asCurrencyCode)
      .filter((code): code is CurrencyCode => code !== null && code !== target);
    if (quotes.length > 0) {
      // `getRates` never throws and omits a pair it cannot serve; the omission
      // surfaces as an unconvertible currency below rather than as an error.
      rates = await getRates(target, quotes);
    }
  }

  const officialBrands =
    input.filters.officialChannelOnly === true
      ? await loadOfficialMerchantsByBrand(
          db,
          [
            ...new Set(
              input.products.flatMap((product) =>
                product.brandId === null ? [] : [product.brandId],
              ),
            ),
          ],
          input.filters.market,
          input.now,
        )
      : new Map<string, Set<string>>();

  const unconvertible = new Set<string>();
  const byProductId = new Map<string, ProductOfferContext>();

  for (const product of input.products) {
    const projected = projectedByProduct.get(product.canonicalProductId) ?? [];
    if (projected.length === 0) {
      byProductId.set(product.canonicalProductId, EMPTY_CONTEXT);
      continue;
    }

    const current = projected.filter(contributesToSummary);
    if (current.length === 0) {
      byProductId.set(product.canonicalProductId, EMPTY_CONTEXT);
      continue;
    }

    const groups = new Set<ConditionGroup>();
    let satisfiesPrice = priceFilter === undefined;
    let fromOfficialChannel = false;
    const officialMerchants =
      product.brandId === null ? undefined : officialBrands.get(product.brandId);

    for (const offer of current) {
      // The projection's OWN segment, never a second derivation from the key.
      // `OfferConditionDTO.group` is absent exactly when the key is `unknown`,
      // and an unknown condition must not be asserted into a segment — a
      // "new/used context" a shopper reads is a claim, and Mercaria does not
      // have one for an offer whose source said nothing.
      if (offer.condition.group !== undefined) groups.add(offer.condition.group);

      if (priceFilter !== undefined && target !== null && !satisfiesPrice) {
        const verdict = evaluatePriceBound(offer, priceFilter, target, rates);
        if (verdict === 'within') satisfiesPrice = true;
        if (verdict === 'unconvertible' && offer.price !== undefined) {
          unconvertible.add(offer.price.currency);
        }
      }

      if (
        officialMerchants !== undefined &&
        offer.merchantId !== undefined &&
        officialMerchants.has(offer.merchantId)
      ) {
        fromOfficialChannel = true;
      }
    }

    // #74's seam, asked once per product with the offers it may choose among.
    // `undefined` while no selector is registered — see `selected-offer.port.ts`
    // for why nothing here fills that gap with a default.
    const selectedOffer = selectSearchOffer({
      canonicalProductId: product.canonicalProductId,
      offers: current,
      ...(input.filters.market === undefined ? {} : { market: input.filters.market }),
    });

    byProductId.set(product.canonicalProductId, {
      // The SUMMARY is derived from the contributing set, not from everything
      // fetched: `summariseProjectedOffers` applies #68's freshness filter and
      // knows nothing about publication, so handing it the raw list would put a
      // restricted listing's price back into `lowestPrice`.
      summary: summariseProjectedOffers(product.canonicalProductId, current),
      conditionGroups: [...groups].sort(),
      ...(selectedOffer === undefined ? {} : { selectedOffer }),
      satisfiesPrice,
      fromOfficialChannel,
    });
  }

  if (priceFilter !== undefined && target !== null && rates !== null) {
    fx = {
      currency: target,
      provider: rates.provider,
      asOf: rates.asOf,
      unconvertibleCurrencies: [...unconvertible].sort(),
    };
    if (unconvertible.size > 0) {
      log.general.warn(
        { currencies: [...unconvertible], target },
        '[search] offers in these currencies had no rate and were excluded from a price filter',
      );
    }
  }

  return { byProductId, ...(fx === undefined ? {} : { fx }) };
}
