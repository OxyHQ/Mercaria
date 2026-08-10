/**
 * How a comparison renders a value — ONCE, and never per surface (#96).
 *
 * Every rendered string in this domain comes from here, and the reason is the
 * explanation validator: "the draft introduced a number" is decided by
 * membership in the package's grounded token set, so a second spelling of one
 * amount is a false rejection, and a LOOSER spelling is a false acceptance. One
 * renderer makes the set exact.
 *
 * ## Deliberately locale-independent
 *
 * `Intl.NumberFormat` would render `1.234,50 €` in one deployment and
 * `€1,234.50` in another, which would make a grounded token set a property of
 * the server's locale. The machine form here is stable — `1234.50 EUR` — and
 * LOCALIZED display is the client's, from the machine `Money` beside it,
 * through `@mercaria/ui`'s `PriceDisplay`. A comparison that shipped its own
 * localized currency string would be the second money formatter this monorepo
 * has a rule against.
 */

import {
  assertSafeMoneyAmount,
  CURRENCY_PRECISION,
  type ComparisonMoneyFact,
  type ComparisonMoneyUnknownReason,
  type CurrencyCode,
  type FxRateSnapshot,
  type Money,
  type OfferComparisonPrice,
  type OfferComparisonTotal,
  type RankingUnknownReason,
} from '@mercaria/shared-types';

/**
 * A money amount as a comparison quotes it: `1234.50 EUR`.
 *
 * Minor units divided by the currency's OWN precision, read from
 * `CURRENCY_PRECISION` — so an eight-decimal currency and a zero-decimal one
 * both render correctly and this module names neither. `toFixed` rather than a
 * division and a regex, because the point is a stable decimal string and not a
 * pretty one.
 */
export function renderMoney(money: Money): string {
  const precision = CURRENCY_PRECISION[money.currency] ?? 2;
  return `${(money.amount / 10 ** precision).toFixed(precision)} ${money.currency}`;
}

/**
 * A plain magnitude as a comparison quotes it, with its unit when it has one.
 *
 * The number is rendered exactly as stored rather than padded to a fixed number
 * of decimals: a stored 16 is `16 GB`, and rendering it `16.00 GB` would put a
 * token in the grounded set that no recorded fact carries — which is a token a
 * generated sentence could then quote without any record behind it.
 */
export function renderMagnitude(value: number, unit?: string): string {
  return unit === undefined || unit === '' ? String(value) : `${String(value)} ${unit}`;
}

/** A day count, with no locale in it. */
export function renderDays(days: number): string {
  return days === 1 ? '1 day' : `${String(days)} days`;
}

/**
 * #74's unknown reasons, narrowed to the three this domain distinguishes.
 *
 * The ranking domain's vocabulary is richer because it explains a SIGNAL; a
 * comparison explains a NUMBER, and "below the review confidence floor" is not
 * something that happens to a price. Everything that is neither a publication
 * failure nor a conversion failure lands on `not_published`, which is the safe
 * direction: it says Mercaria has no figure, which is true of every one of them.
 */
function narrowUnknownReason(reason: RankingUnknownReason): ComparisonMoneyUnknownReason {
  return reason === 'not_convertible' ? 'not_convertible' : 'not_published';
}

/**
 * #74's converted price, in this domain's own money-fact shape.
 *
 * A translation and not a re-derivation: the amount, the currency and the
 * captured {@link FxRateSnapshot} all come from the ranking domain, which
 * already performed the conversion under the comparison's one named currency.
 * What is added here is the rendered form and a STRING discriminant, because
 * the backend compiles without `strictNullChecks` and #74's `known: boolean`
 * does not narrow there.
 */
export function toMoneyFact(price: OfferComparisonPrice): ComparisonMoneyFact {
  if (price.known !== true) {
    return { state: 'unknown', reason: narrowUnknownReason(price.reason) };
  }
  return {
    state: 'known',
    amount: price.amount,
    rendered: renderMoney(price.amount),
    fx: price.fx,
  };
}

/** #74's comparison total, in this domain's shape. */
export function toTotalFact(total: OfferComparisonTotal): ComparisonMoneyFact {
  if (total.known !== true) return { state: 'unknown', reason: 'component_missing' };
  return { state: 'known', amount: total.amount, rendered: renderMoney(total.amount) };
}

/**
 * A known money fact from raw minor units, with the ceiling ENFORCED.
 *
 * `assertSafeMoneyAmount` is called at every construction boundary in this
 * repository and a basket total is one: forty lines times a quantity is exactly
 * the arithmetic that reaches `Number.MAX_SAFE_INTEGER` from individually
 * reasonable prices.
 */
export function knownMoney(amountMinor: number, currency: CurrencyCode): ComparisonMoneyFact {
  assertSafeMoneyAmount(amountMinor, `comparison.knownMoney(${currency})`);
  const amount: Money = { amount: amountMinor, currency };
  return { state: 'known', amount, rendered: renderMoney(amount) };
}

/**
 * Add two money facts in ONE currency, or say which half was missing.
 *
 * Refuses a mixed-currency addition by ANSWERING `unknown` rather than by
 * throwing, because a comparison whose subjects price in two currencies is a
 * legitimate state that must still produce a page — and a throw here would be a
 * 500 on a shopper's screen for an ordinary catalogue fact.
 */
export function addMoneyFacts(
  left: ComparisonMoneyFact,
  right: ComparisonMoneyFact,
): ComparisonMoneyFact {
  if (left.state !== 'known' || right.state !== 'known') {
    return { state: 'unknown', reason: 'component_missing' };
  }
  if (left.amount.currency !== right.amount.currency) {
    return { state: 'unknown', reason: 'not_convertible' };
  }
  return knownMoney(left.amount.amount + right.amount.amount, left.amount.currency);
}

/**
 * Multiply a money fact by a quantity, with the ceiling enforced.
 *
 * A separate function from repeated addition because the assertion has to see
 * the PRODUCT: adding a safe amount to itself forty times passes forty
 * individually safe assertions and can still overflow.
 */
export function scaleMoneyFact(fact: ComparisonMoneyFact, quantity: number): ComparisonMoneyFact {
  if (fact.state !== 'known') return fact;
  return knownMoney(fact.amount.amount * quantity, fact.amount.currency);
}

/**
 * Deduplicate the rate snapshots a comparison applied, one per pair.
 *
 * The #74 device, spelled out here rather than imported because the input is
 * this domain's money fact and not the ranking domain's price — and converting
 * between the two shapes purely to reuse six lines would be the indirection
 * this codebase has a rule against.
 */
export function collectComparisonRates(
  facts: readonly ComparisonMoneyFact[],
): readonly FxRateSnapshot[] {
  const seen = new Map<string, FxRateSnapshot>();
  for (const fact of facts) {
    if (fact.state !== 'known') continue;
    if (fact.fx === undefined) continue;
    seen.set(`${fact.fx.from}->${fact.fx.to}`, fact.fx);
  }
  return [...seen.values()];
}
