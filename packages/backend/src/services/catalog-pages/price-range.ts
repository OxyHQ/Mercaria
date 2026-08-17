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
 * The range over a page of cards, in one named currency.
 *
 * `undefined` when nothing convertible is priced — ABSENT rather than a range
 * of zero, the `ProductOfferSummary.lowestPrice` rule: a zero would render as
 * "from 0 €", which is a claim about a price rather than about Mercaria's
 * information.
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

  if (lowest === undefined || highest === undefined || contributing === 0) return undefined;

  const money = (amount: number): OfferMoney => ({ amount, currency: target });
  return {
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
