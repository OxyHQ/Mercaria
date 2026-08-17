/**
 * The price range a family page states (#72 family rule 4).
 *
 * "Current price range derived from eligible offers with a NAMED comparison
 * currency" — and the naming is the load-bearing half. The offers behind a
 * family are in whatever their retailers publish, so a range whose two ends
 * came from different currencies is a pair of numbers with no meaning between
 * them.
 *
 * ## Unconvertible is EXCLUDED and NAMED, never coerced
 *
 * `fx.service.convert` throws rather than fabricating a missing pair, and that
 * refusal IS the answer here: an offer whose currency has no rate is dropped
 * from the range and its currency is listed in
 * `unconvertibleCurrencies`, the #70 `SearchFxContext` posture. Silently keeping
 * it would be a raw cross-currency comparison of minor units, which answers with
 * whichever currency has the smaller unit.
 *
 * ## Naming them survives the case where NOTHING converted (#464)
 *
 * The exclusion list is worth nothing if it is thrown away in the one case it
 * matters most. A family whose offers are ALL priced in a currency Mercaria does
 * not model computed a complete list of what it dropped and then returned
 * `undefined`, which a client renders as "no offers" — telling a shopper the
 * family is unsold and leaving a seller's "why does my offer never appear"
 * unanswerable from any surface, which is the #450 complaint one page over.
 * That case is now its own state, so absence means one thing and the list is
 * always reported.
 *
 * ## The range is over the cheapest offer of each PRODUCT
 *
 * Not over every offer: a family page's range answers "what do these
 * generations cost", and the honest bottom of that is the cheapest way to buy
 * the cheapest generation. Each product contributes its own
 * `summary.lowestPrice`, which #68 already derived from the offers a comparison
 * would show — so the range and the cards cannot disagree.
 *
 * ## A single-product range is still a range
 *
 * Its two ends are equal, which is a fact rather than a degenerate case, and a
 * client renders "150 €" instead of "from 150 € to 150 €" on its own. Refusing
 * to state one would leave a family page with one priced generation showing no
 * price at all.
 */

import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import type {
  CatalogPriceRange,
  CatalogProductCard,
  CurrencyCode,
  OfferMoney,
} from '@mercaria/shared-types';
import { convert, getRates } from '../fx.service.js';
import { asCurrencyCode, projectCurrencyExclusions } from '../fx-exclusions.js';
import { foldConditionScopes } from './condition-scope.js';

/**
 * The range over a page of cards, in one named currency — or why there is none.
 *
 * Three answers, and each means exactly one thing (#464):
 *
 * - `undefined` — **no card publishes a price at all.** ABSENT rather than a
 *   range of zero, the `ProductOfferSummary.lowestPrice` rule: a zero would
 *   render as "from 0 €", a claim about a price rather than about Mercaria's
 *   information.
 * - `{ state: 'unpriceable', … }` — cards WERE priced and every one was
 *   excluded, with the currencies named. Before #464 this returned `undefined`
 *   too, so the two collapsed and the exclusions this function had just
 *   accumulated were reported nowhere.
 * - `{ state: 'ranged', … }` — at least one card converted.
 *
 * ONE `getRates` for the whole page. A call per card would make the page's FX
 * behaviour depend on how many products it happened to return.
 */
export async function deriveFamilyPriceRange(
  cards: readonly CatalogProductCard[],
  target: CurrencyCode,
): Promise<CatalogPriceRange | undefined> {
  const priced = cards.flatMap((card) =>
    card.offers?.summary.lowestPrice === undefined ? [] : [card],
  );
  if (priced.length === 0) return undefined;

  const sources = new Set<string>();
  for (const card of priced) {
    const price = card.offers?.summary.lowestPrice;
    if (price !== undefined) sources.add(price.currency);
  }
  const quotes = [...sources]
    .map(asCurrencyCode)
    .filter((code): code is CurrencyCode => code !== null && code !== target);

  // `getRates` never throws and omits a pair it cannot serve; the omission
  // surfaces below as an unconvertible currency rather than as a failed page.
  const rates = quotes.length === 0 ? null : await getRates(target, quotes);

  const unconvertible = new Set<string>();
  let lowest: number | undefined;
  let highest: number | undefined;
  let contributing = 0;
  const scopes: CatalogProductCard['offers'][] = [];

  for (const card of priced) {
    const offers = card.offers;
    const price = offers?.summary.lowestPrice;
    if (offers === undefined || price === undefined) continue;
    const source = asCurrencyCode(price.currency);
    if (source === null) {
      unconvertible.add(price.currency);
      continue;
    }

    let amount: number;
    if (source === target) {
      amount = price.amount;
    } else if (rates === null) {
      unconvertible.add(price.currency);
      continue;
    } else {
      try {
        amount = convert({ amount: price.amount, currency: source }, target, rates).amount;
      } catch {
        unconvertible.add(price.currency);
        continue;
      }
    }

    // The ceiling is re-imposed at the construction boundary, the house rule for
    // every derived money: a converted amount is a NEW amount and a rate move
    // can carry one past what a `bigint({ mode: 'number' })` column holds.
    assertSafeMoneyAmount(amount, 'catalogPriceRange');
    contributing += 1;
    scopes.push(offers);
    if (lowest === undefined || amount < lowest) lowest = amount;
    if (highest === undefined || amount > highest) highest = amount;
  }

  if (lowest === undefined || highest === undefined || contributing === 0) {
    // Prices existed and not one survived conversion. Reporting `undefined`
    // here — what this did before #464 — threw away the exclusions just
    // computed and made absence mean two things: "nothing is priced" and
    // "everything was dropped, and here is what it was priced in". The second
    // is the case a seller needs to see, and it was reported nowhere.
    //
    // `unconvertible` is non-empty here by construction: `priced` is non-empty
    // (returned above otherwise) and every one of its cards either contributed
    // or was added to this set, so `contributing === 0` implies at least one
    // excluded currency. That is what stops this branch being a new silence.
    return { state: 'unpriceable', ...projectCurrencyExclusions(unconvertible) };
  }

  const money = (amount: number): OfferMoney => ({ amount, currency: target });
  return {
    state: 'ranged',
    currency: target,
    lowest: money(lowest),
    highest: money(highest),
    // The scope is folded from the CONTRIBUTING cards only, never from the whole
    // page: a card excluded for an unconvertible currency told us nothing about
    // the condition of what this range covers.
    conditionScope: foldConditionScopes(
      scopes.flatMap((offers) => (offers === undefined ? [] : [offers.conditionScope])),
    ),
    productCount: contributing,
    // Both lists come from ONE set, so the permanent subset can never name a
    // currency the complete list omits (#450).
    ...projectCurrencyExclusions(unconvertible),
    fxProvider: rates === null ? 'identity' : rates.provider,
    fxAsOf: rates === null ? new Date().toISOString() : rates.asOf,
  };
}
