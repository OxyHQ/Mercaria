/**
 * The derived availability and price summary for one canonical product
 * (#68 scheduler 10, public behaviour 4 and 7).
 *
 * ## There is no projection to rebuild, and that is the answer
 *
 * #68 asks for "a rebuild of derived product availability and price summaries
 * after eligible-offer changes". #61 measured the alternative at one million
 * offers — every read an indexed single-digit-millisecond query — and adopted
 * NO materialized view or denormalized read model;
 * `docs/performance/canonical-graph-benchmarks.md` carries the numbers and the
 * explicit list of reads that stay normalized.
 *
 * So this summary is computed LIVE from the offers a comparison would show, and
 * "rebuild after an eligible-offer change" is satisfied by construction: a
 * retirement, a revival or a price move changes the next read's answer with
 * nothing in between to fall out of date. That is a stronger guarantee than a
 * rebuilt projection, not a weaker one — a projection's correctness depends on
 * every writer remembering to enqueue it, which is the failure #57 refused when
 * it made checkout eligibility a live derivation.
 *
 * ## Unknown survives, and empty is not out of stock
 *
 * `rollUpOfferAvailability` never answers `in_stock` from silence, and a product
 * whose every offer has expired reports `unknown` with a zero count rather than
 * `out_of_stock` — that is a statement about Mercaria's information, not about
 * the retailer's shelves. `lowestPrice` is ABSENT rather than zero when nothing
 * current is priced. Together those are #68 public behaviour 7: a product page
 * renders from this summary instead of failing when every current offer
 * expires.
 */

import {
  rollUpOfferAvailability,
  type CurrencyCode,
  type FxRates,
  type Offer,
  type OfferAvailability,
  type OfferMoney,
  type ProductOfferSummary,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { asCurrencyCode } from '../fx-exclusions.js';
import { convert, getRates } from '../fx.service.js';
import { DEFAULT_PRESENTMENT_CURRENCY } from '../user-preference.service.js';
import { listOffersForComparison } from '../../db/offers/offerRepository.js';
import { buildOfferProjectionContext } from '../offers/offer.service.js';
import { projectOffer } from '../offers/offer-projection.js';

/**
 * How many offers the summary reads.
 *
 * A bound rather than every offer on the product, because the summary's three
 * questions — is anything in stock, what is the cheapest, how old is the oldest
 * thing being shown — are all answered by the cheapest slice, and #61 measured
 * the product-level comparison read's amplification at 124x. The count is
 * therefore reported as "of the offers examined" and the doc says so; a product
 * with more current offers than this is one whose exact count nobody is
 * deciding anything from.
 *
 * EXPORTED for #70, which summarises a whole page of products in one batched
 * read rather than one product at a time. The depth has to be the same number
 * or a product's summary would say one thing on a search page and another on
 * its own page — two answers to `currentOfferCount` differing by a limit
 * nobody can see.
 */
export const SUMMARY_OFFER_LIMIT = 200;

/**
 * Summarise the offers a comparison surface would currently show for one
 * canonical product.
 *
 * It goes through `listOffersForComparison` plus `projectOffer` — the SAME two
 * calls the public read uses — rather than a bespoke aggregate, so the summary
 * and the list can never disagree about which offers are current. An aggregate
 * would be a second spelling of the freshness rule, and the disagreement would
 * appear as "the page says three offers and shows two".
 */
export async function readProductOfferSummary(
  input: { canonicalProductId: string; country?: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductOfferSummary> {
  const now = input.now ?? new Date();
  const rows = await listOffersForComparison(db, {
    canonicalProductId: input.canonicalProductId,
    ...(input.country === undefined ? {} : { country: input.country }),
    excludeStale: true,
    limit: SUMMARY_OFFER_LIMIT,
    now,
  });

  const context = await buildOfferProjectionContext(rows, now, db);
  const projected = rows.map((row) =>
    projectOffer(row.offer, row.storefrontOperatorMerchantId, context),
  );
  return summariseProjectedOffers(
    input.canonicalProductId,
    projected,
    await summaryComparisonRates([projected.filter(isCurrentForSummary)]),
  );
}

/** The distinct currencies a set of offers is priced in. */
function pricedCurrencies(offers: readonly Offer[]): Set<string> {
  const currencies = new Set<string>();
  for (const offer of offers) if (offer.price !== undefined) currencies.add(offer.price.currency);
  return currencies;
}

/**
 * The rates to compare a set of summaries' prices across currencies, or `null`
 * when no summary needs any — ONE `getRates` for a whole page, and none at all
 * when every product is priced in a single currency (the common case).
 */
export async function summaryComparisonRates(
  offerSets: readonly (readonly Offer[])[],
): Promise<FxRates | null> {
  // Quoted through the deployment's default presentment currency, the FX pivot.
  // The base only ORDERS: no amount a summary states is converted into it.
  const base = DEFAULT_PRESENTMENT_CURRENCY;
  const quotes = new Set<CurrencyCode>();
  for (const offers of offerSets) {
    const currencies = pricedCurrencies(offers);
    if (currencies.size < 2) continue;
    for (const currency of currencies) {
      const code = asCurrencyCode(currency);
      if (code !== null && code !== base) quotes.add(code);
    }
  }
  // `getRates` never throws and omits a pair it cannot serve; an omitted pair
  // makes its currency incomparable below, never a guessed rate.
  return quotes.size === 0 ? null : getRates(base, [...quotes]);
}

/** A price as the comparison base, or `undefined` when it cannot be compared. */
function comparableAmount(price: OfferMoney, rates: FxRates | null): number | undefined {
  const code = asCurrencyCode(price.currency);
  if (code === null || rates === null) return undefined;
  if (code !== rates.base && rates.rates[code] === undefined) return undefined;
  return convert({ amount: price.amount, currency: code }, rates.base, rates).amount;
}

/**
 * The lowest current price, in its OWN currency — or `undefined` when there is
 * none Mercaria can honestly call lowest.
 *
 * Amounts are compared only WITHIN a currency: 1,199 EUR against 4,500 PLN by
 * their minor units would answer with whichever currency has the smaller unit.
 * Across currencies, each currency's cheapest is compared through `rates`; a
 * currency that cannot be quoted (unmodelled, or no rate today) cannot be shown
 * to be lowest and drops out. When no two currencies can be compared at all,
 * nothing is stated — an absent price renders as "no price", a wrong one reads
 * as an offer somebody could take.
 */
export function lowestOfferPrice(
  offers: readonly Offer[],
  rates: FxRates | null,
): OfferMoney | undefined {
  const cheapestByCurrency = new Map<string, OfferMoney>();
  for (const offer of offers) {
    const price = offer.price;
    if (price === undefined) continue;
    const held = cheapestByCurrency.get(price.currency);
    if (held === undefined || price.amount < held.amount) {
      cheapestByCurrency.set(price.currency, price);
    }
  }
  const candidates = [...cheapestByCurrency.values()];
  if (candidates.length <= 1) return candidates[0];

  let lowest: { price: OfferMoney; base: number } | undefined;
  // Currency order breaks an exact tie, so equal inputs give one answer.
  for (const price of candidates.sort((a, b) => (a.currency < b.currency ? -1 : 1))) {
    const base = comparableAmount(price, rates);
    if (base === undefined) continue;
    if (lowest === undefined || base < lowest.base) lowest = { price, base };
  }
  return lowest?.price;
}

/**
 * Whether a projected offer is CURRENT enough to appear in a summary.
 *
 * Exported because #70's batched path filters before it groups by product, and
 * a second spelling of "current" is exactly how a search page and a product
 * page start disagreeing about whether something is on sale.
 */
export function isCurrentForSummary(offer: Offer): boolean {
  return offer.freshness.level === 'current' || offer.freshness.level === 'warning';
}

/**
 * The summary derivation itself — PURE, over offers already projected.
 *
 * Split out of {@link readProductOfferSummary} for #70, which fetches the
 * cheapest offers of a WHOLE PAGE of products in one statement and cannot call
 * the per-product reader without turning a search page into forty round trips
 * (the N+1 #70's performance section forbids by name). The two paths differ in
 * how they FETCH and share this, so the answer cannot depend on which one
 * asked.
 *
 * The lowest price is {@link lowestOfferPrice}'s answer, over the current
 * offers and the cross-currency `rates` the caller fetched once for its page
 * ({@link summaryComparisonRates}). It never relies on the fetch order: both
 * fetchers order by raw minor units, which across currencies is no order at all.
 */
export function summariseProjectedOffers(
  canonicalProductId: string,
  projected: readonly Offer[],
  rates: FxRates | null,
): ProductOfferSummary {
  const current = projected.filter(isCurrentForSummary);

  const availabilities: OfferAvailability[] = current.map((offer) => offer.availability);
  const lowestPrice = lowestOfferPrice(current, rates);
  let oldest: string | undefined;
  let newest: string | undefined;
  let warningOfferCount = 0;

  for (const offer of current) {
    if (offer.freshness.level === 'warning') warningOfferCount += 1;

    const observedAt = offer.freshness.observedAt;
    if (oldest === undefined || observedAt < oldest) oldest = observedAt;
    if (newest === undefined || observedAt > newest) newest = observedAt;
  }

  return {
    canonicalProductId,
    currentOfferCount: current.length,
    availability: rollUpOfferAvailability(availabilities),
    ...(lowestPrice === undefined ? {} : { lowestPrice }),
    ...(oldest === undefined ? {} : { oldestCurrentObservedAt: oldest }),
    ...(newest === undefined ? {} : { newestCurrentObservedAt: newest }),
    warningOfferCount,
  };
}
