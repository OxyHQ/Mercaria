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
 * ## Every offer-side filter is answered by ONE offer (#438)
 *
 * The offer-side filters split at the SQL boundary. Market, kind, availability,
 * condition and merchant are columns on `offers`, so they narrow the ranking
 * statement itself and are same-offer by construction. The two that cannot be
 * expressed there — the price bound, which needs a conversion context, and the
 * official-channel test, which needs a validity window — are answered HERE, and
 * they used to be answered SEPARATELY: each was a boolean set by the first offer
 * that satisfied it on its own. So a product passed `price <= X` AND
 * `officialChannelOnly` when its cheap offer was unofficial and its official
 * offer was expensive, and the shopper got a product where neither was true of
 * the thing they could actually buy — epic #367 Workstream 10's "price and
 * availability constraints must match one eligible offer", arriving between two
 * filters that were each individually correct.
 *
 * {@link SearchOfferMatch} is the fix, and it is a SHAPE rather than a check:
 * there is no per-requirement result anywhere for a caller to combine, and the
 * one value that reports success names the single offer that produced it. The
 * SQL half of the same rule is `buildEntityPredicate` (#367's facets), which
 * nests its offer `exists` INSIDE the variant one rather than beside it.
 *
 * ## Ranking lives in #74 and none of it lives here
 *
 * Offers are ordered by price because that is how the CHEAPEST slice is
 * identified for a summary. Which offer a shopper should be shown is
 * `selected-offer.port.ts`, which fails closed. Nothing in this module reads a
 * fee, a commission, a referral, a plan or a payment rail, and
 * `search-relevance-isolation.test.ts` fails the build if it starts to.
 */

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
import { asCurrencyCode, projectCurrencyExclusions } from '../fx-exclusions.js';
import { selectSearchOffer } from './selected-offer.port.js';
import { log } from '../../lib/logger.js';

/**
 * Whether ONE offer answered every offer-side requirement the service applies,
 * and WHICH offer that was.
 *
 * This is the SAME-OFFER invariant, held by the shape rather than by a check.
 * It replaced two independent booleans — "some current offer was inside the
 * price bound" and "some current offer came from an official channel" — which
 * were separately representable, so a product passed both filters when offer A
 * was cheap and unofficial and offer B was official and expensive. No single
 * offer satisfied both, and the shopper who asked for "official channel, under
 * X" was shown a product where neither was true of the thing they could buy
 * (#438).
 *
 * The fix is that there is nowhere in this type to write a per-requirement
 * result down. `matched` carries the id of the ONE offer that answered
 * everything, so the wrong answer has no shape to be written in — the rule
 * `buildEntityPredicate` (#367's facets) holds one layer down in SQL, where the
 * offer `exists` is nested INSIDE the variant one rather than sitting beside it.
 *
 * A STRING discriminant because this backend compiles with `strict: false`:
 * TypeScript does not narrow a union on the truthiness of a boolean-literal
 * discriminant, so a `matched: true | false` version would leave every caller
 * holding the whole union.
 */
export type SearchOfferMatch =
  /** Neither service-side requirement was asked, so there is nothing to match. */
  | { readonly outcome: 'not_requested' }
  /** One offer answered every requirement, and it is this one. */
  | { readonly outcome: 'matched'; readonly offerId: string }
  /** Requirements were asked and no SINGLE offer answered all of them. */
  | { readonly outcome: 'unmatched' };

/** Everything a product result learns from its offers. */
export interface ProductOfferContext {
  readonly summary?: ProductOfferSummary;
  readonly conditionGroups: readonly ConditionGroup[];
  readonly selectedOffer?: SearchSelectedOffer;
  /**
   * Whether ONE current offer answered every service-side offer requirement.
   *
   * The SQL-scope filters (market, kind, availability, condition, merchant) are
   * not here because they are already same-offer by construction: they are
   * columns on `offers` and narrow the ranking statement itself.
   */
  readonly offerMatch: SearchOfferMatch;
}

/** The page-wide outcome: one context per product, plus the FX it converted with. */
export interface SearchOfferContexts {
  readonly byProductId: ReadonlyMap<string, ProductOfferContext>;
  readonly fx?: SearchFxContext;
}

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

/** The rate map `getRates` answers with, or `null` when none was needed. */
type RateMap = Awaited<ReturnType<typeof getRates>> | null;

/**
 * The price half of a page's requirement set.
 *
 * `uninterpretable` is a bound whose OWN currency is outside Mercaria's
 * presentment set. `SearchPriceFilter.currency` is a loose three-or-four-letter
 * string at the schema boundary, so a shopper can send one; nothing can be
 * shown to satisfy it, and every offer is therefore refused rather than
 * admitted. That is the same direction as every other unknown here.
 */
type PriceRequirement =
  | { readonly bound: 'uninterpretable' }
  | {
      readonly bound: 'interpretable';
      readonly filter: NonNullable<SearchFilters['price']>;
      readonly target: CurrencyCode;
      readonly rates: RateMap;
    };

/**
 * Whether one offer's price falls inside the bound, once converted.
 *
 * FOUR answers, not two, and the extra ones are the reason this is not a
 * boolean. An offer Mercaria cannot price in the bound's currency has NOT been
 * shown to be too expensive, and must not be read as satisfying the bound
 * either — #74's `RankingSignalOutcome` and #78's `PriceHistoryValue` take the
 * same third answer, and `~/AGENTS.md` states the rule: unknown is never a soft
 * yes and never a quiet no.
 *
 * The two unknowns are kept apart because only one of them has anything to
 * report. `unconvertible` NAMES the currency in the branch itself, so recording
 * the exclusion without naming it is unrepresentable, and the caller lists it in
 * {@link SearchFxContext} — #70's "explicit FX behavior". `unpriced` is an offer
 * that publishes no price at all, so there is no currency to name.
 */
type OfferPriceVerdict =
  | { readonly price: 'within' }
  | { readonly price: 'outside' }
  | { readonly price: 'unpriced' }
  | { readonly price: 'unconvertible'; readonly currency: string };

function evaluatePriceBound(offer: Offer, requirement: PriceRequirement): OfferPriceVerdict {
  if (offer.price === undefined) return { price: 'unpriced' };
  const currency = offer.price.currency;
  if (requirement.bound === 'uninterpretable') return { price: 'unconvertible', currency };

  const source = asCurrencyCode(currency);
  if (source === null) return { price: 'unconvertible', currency };

  const { filter, target, rates } = requirement;
  let amount: number;
  if (source === target) {
    // A same-currency comparison needs no rate at all, so it stays answerable
    // on a page where FX is unavailable entirely.
    amount = offer.price.amount;
  } else if (rates === null) {
    return { price: 'unconvertible', currency };
  } else {
    try {
      // `convert` throws when either side has no rate — it never fabricates
      // one. That refusal IS the answer here, so it is caught and reported
      // rather than allowed to fail the page.
      amount = convert({ amount: offer.price.amount, currency: source }, target, rates).amount;
    } catch {
      return { price: 'unconvertible', currency };
    }
  }

  if (filter.minMinor !== undefined && amount < filter.minMinor) return { price: 'outside' };
  if (filter.maxMinor !== undefined && amount > filter.maxMinor) return { price: 'outside' };
  return { price: 'within' };
}

/**
 * Everything the SERVICE tests one offer against, carried TOGETHER.
 *
 * The offer-side filters split at the SQL boundary. Market, kind, availability,
 * condition and merchant are columns on `offers`, so they go into the ranking
 * statement's scope and are same-offer by construction. The two that cannot go
 * there are these — a price bound, which needs a conversion context the
 * statement has none of, and the official-channel test, which needs #55's
 * validity window — and they are carried in ONE object for exactly the reason
 * `buildEntityPredicate` nests its offer `exists` inside the variant one:
 * evaluating them apart answers "a cheap one exists and an official one exists",
 * which is a different question from the one the shopper asked.
 *
 * There is deliberately no product-level function in this module that takes one
 * of these alone.
 */
interface OfferRequirements {
  readonly price?: PriceRequirement;
  /**
   * The merchants holding a live official or authorized-reseller relationship
   * for THIS product's own brand.
   *
   * Present exactly when the shopper asked for the filter, and an EMPTY set is a
   * real answer rather than an absence: a product with no brand, or one whose
   * brand nobody is authorized for, gets an empty set and can match no offer.
   * Using absence for that would delete the requirement instead of failing it,
   * which is the trap — a brandless product would then pass a filter it cannot
   * satisfy.
   */
  readonly officialMerchants?: ReadonlySet<string>;
}

/** Answered for a product with no brand, and for a brand nobody is authorized for. */
const NO_OFFICIAL_MERCHANTS: ReadonlySet<string> = new Set<string>();

/**
 * One offer's answer to the WHOLE requirement set.
 *
 * Only `satisfied` may produce a match. The two unknowns are neither a yes nor
 * a no, and they carry DISTINCT discriminant strings rather than a shared
 * `'unknown'` with an optional field: two members spelling their discriminant
 * the same way do not narrow, and an optional currency would let an
 * unconvertible verdict be recorded without naming the currency it excluded.
 * Spelled this way, `unknown_unconvertible` cannot exist without one.
 */
type OfferVerdict =
  | { readonly verdict: 'satisfied' }
  | { readonly verdict: 'refused' }
  /** The offer publishes no price at all, so there is no currency to name. */
  | { readonly verdict: 'unknown_unpriced' }
  /** Priced, in a currency the bound could not be expressed against. */
  | { readonly verdict: 'unknown_unconvertible'; readonly currency: string };

/**
 * Test ONE offer against ALL the requirements.
 *
 * This is the atom the same-offer invariant rests on: the only thing that can
 * report success takes a single offer and the entire requirement set, so a
 * "satisfied" that came from two different offers cannot be constructed.
 *
 * The price is evaluated FIRST even when the official test would refuse the
 * offer anyway, because an unconvertible currency is worth naming in the FX
 * report whatever else was wrong with the offer — the exclusion being visible is
 * the point, and over-reporting it is the safe direction.
 */
function evaluateOffer(offer: Offer, requirements: OfferRequirements): OfferVerdict {
  if (requirements.price !== undefined) {
    const price = evaluatePriceBound(offer, requirements.price);
    if (price.price === 'unconvertible') {
      return { verdict: 'unknown_unconvertible', currency: price.currency };
    }
    if (price.price === 'unpriced') return { verdict: 'unknown_unpriced' };
    if (price.price === 'outside') return { verdict: 'refused' };
  }

  if (requirements.officialMerchants !== undefined) {
    if (offer.merchantId === undefined) return { verdict: 'refused' };
    if (!requirements.officialMerchants.has(offer.merchantId)) return { verdict: 'refused' };
  }

  return { verdict: 'satisfied' };
}

/** The page-level report the matcher produces beside its verdict. */
interface OfferMatchOutcome {
  readonly match: SearchOfferMatch;
  readonly unconvertibleCurrencies: readonly string[];
}

/**
 * Walk one product's current offers and answer whether ONE of them cleared
 * every requirement.
 *
 * The walk does NOT stop at the first match. Today's predecessor stopped
 * evaluating the price as soon as any offer satisfied it, which made the set of
 * currencies reported unconvertible depend on where in the cheapest-first order
 * the first match happened to sit; running every offer makes that report
 * complete and order-independent. The set is bounded by `SUMMARY_OFFER_LIMIT`
 * per product, so the extra work is a handful of comparisons over rows that are
 * already in memory — no extra statement, no extra round trip.
 */
function matchOfferRequirements(
  offers: readonly Offer[],
  requirements: OfferRequirements,
): OfferMatchOutcome {
  if (requirements.price === undefined && requirements.officialMerchants === undefined) {
    return { match: { outcome: 'not_requested' }, unconvertibleCurrencies: [] };
  }

  let matchedOfferId: string | undefined;
  const unconvertibleCurrencies: string[] = [];
  for (const offer of offers) {
    const outcome = evaluateOffer(offer, requirements);
    if (outcome.verdict === 'unknown_unconvertible') {
      unconvertibleCurrencies.push(outcome.currency);
    }
    if (outcome.verdict === 'satisfied' && matchedOfferId === undefined) {
      matchedOfferId = offer.id;
    }
  }

  return {
    match:
      matchedOfferId === undefined
        ? { outcome: 'unmatched' }
        : { outcome: 'matched', offerId: matchedOfferId },
    unconvertibleCurrencies,
  };
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
  let rates: RateMap = null;

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

  // The price half of the requirement set, built ONCE for the page. A bound
  // whose own currency is not a `CurrencyCode` is `uninterpretable`, so no
  // offer can satisfy it and every product is refused — the behaviour before
  // #438, stated as a shape rather than left to a flag that never flips.
  const priceRequirement: PriceRequirement | undefined =
    priceFilter === undefined
      ? undefined
      : target === null
        ? { bound: 'uninterpretable' }
        : { bound: 'interpretable', filter: priceFilter, target, rates };

  const wantsOfficialChannel = input.filters.officialChannelOnly === true;

  /** One product's requirement set: the page's price bound, this brand's merchants. */
  const requirementsFor = (brandId: string | null): OfferRequirements => ({
    ...(priceRequirement === undefined ? {} : { price: priceRequirement }),
    // Requested-ness is decided by the FILTER, never by whether this product
    // has a brand. A brandless product gets an EMPTY set, which no offer can
    // be a member of, so it fails the requirement — where omitting the key
    // would delete the requirement and let it pass a filter it cannot satisfy.
    ...(wantsOfficialChannel
      ? {
          officialMerchants:
            brandId === null
              ? NO_OFFICIAL_MERCHANTS
              : (officialBrands.get(brandId) ?? NO_OFFICIAL_MERCHANTS),
        }
      : {}),
  });

  const unconvertible = new Set<string>();
  const byProductId = new Map<string, ProductOfferContext>();

  /**
   * A product with no contributing offer, so a caller never branches on
   * `undefined`.
   *
   * Its match comes from running the SAME matcher over an EMPTY offer list
   * rather than from a hardcoded default: with no requirements that is
   * `not_requested` and with requirements it is `unmatched`, and there is no
   * second place for the two to disagree.
   */
  const emptyContext = (brandId: string | null): ProductOfferContext => ({
    conditionGroups: [],
    offerMatch: matchOfferRequirements([], requirementsFor(brandId)).match,
  });

  for (const product of input.products) {
    const projected = projectedByProduct.get(product.canonicalProductId) ?? [];
    const current = projected.filter(contributesToSummary);
    if (current.length === 0) {
      byProductId.set(product.canonicalProductId, emptyContext(product.brandId));
      continue;
    }

    const groups = new Set<ConditionGroup>();
    for (const offer of current) {
      // The projection's OWN segment, never a second derivation from the key.
      // `OfferConditionDTO.group` is absent exactly when the key is `unknown`,
      // and an unknown condition must not be asserted into a segment — a
      // "new/used context" a shopper reads is a claim, and Mercaria does not
      // have one for an offer whose source said nothing.
      if (offer.condition.group !== undefined) groups.add(offer.condition.group);
    }

    // The SAME-OFFER test, in one call over the whole requirement set. There is
    // no per-requirement answer to combine afterwards, which is what makes
    // "offer A was cheap and offer B was official" impossible to express (#438).
    const matched = matchOfferRequirements(current, requirementsFor(product.brandId));
    for (const currency of matched.unconvertibleCurrencies) unconvertible.add(currency);

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
      offerMatch: matched.match,
    });
  }

  // Emitted whenever a price filter was answered AND there was either a
  // conversion or an exclusion to report. Gating it on `rates !== null` made
  // absence mean two different things (#450): a page whose foreign offers are
  // all in currencies Mercaria does not model asks for no rates at all, so the
  // exclusions it just made had nowhere to be reported. A filter whose OWN
  // currency is unmodelled (`target === null`) is the same silence one step
  // earlier — every priced offer is refused and the shopper was told nothing.
  if (priceFilter !== undefined && (rates !== null || unconvertible.size > 0)) {
    const exclusions = projectCurrencyExclusions(unconvertible);
    fx = {
      // The RAW filter currency when it is not one Mercaria models: the field is
      // "what the shopper asked in", and answering with a narrowed value would
      // mean not answering at all.
      currency: target ?? priceFilter.currency,
      // No rate map was needed or obtainable, so no provider published anything.
      // `identity` is this repository's word for a conversion that did not
      // happen, and `catalog-pages` already reports the same fact the same way.
      provider: rates === null ? 'identity' : rates.provider,
      asOf: rates === null ? new Date().toISOString() : rates.asOf,
      ...exclusions,
    };
    if (exclusions.unconvertibleCurrencies.length > 0) {
      log.general.warn(
        {
          currencies: exclusions.unconvertibleCurrencies,
          unmodelled: exclusions.unmodelledCurrencies,
          target: fx.currency,
        },
        '[search] offers in these currencies could not be priced and were excluded from a price filter',
      );
    }
  }

  return { byProductId, ...(fx === undefined ? {} : { fx }) };
}
