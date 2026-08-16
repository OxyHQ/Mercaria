/**
 * The price facet and the price filter, across currencies (#367 Workstream 10).
 *
 * ## The bound is converted, not the amounts
 *
 * A price filter has to be a SQL predicate — the whole point of this domain is
 * counting distinct products over a whole category, and pulling every offer into
 * TypeScript to convert it is not that shape. But SQL cannot call `fx.service`,
 * and multiplying a `bigint` minor-unit column by a float rate inside the
 * statement would put money arithmetic in the planner, where none of this
 * repository's money rules reach.
 *
 * So the direction is inverted: the shopper's bound is converted ONCE into every
 * currency present in scope, through `fx.convert` — the one authority — and the
 * predicate compares each offer against the bound in its OWN currency. The
 * comparison is then exact integer arithmetic on the column, and the only
 * approximation is in the bound itself.
 *
 * **That approximation is stated rather than hidden.** Converting a bound and
 * converting an amount both round, so an offer sitting within one minor unit of
 * the boundary may fall on either side of it. Converting the amounts instead
 * would move the rounding, not remove it. What this arrangement buys is that
 * every offer of one currency is judged by ONE converted number, so two
 * identically-priced offers can never disagree.
 *
 * ## A currency with no rate is excluded and NAMED
 *
 * `getRates` never throws and never fabricates a missing pair — it omits it —
 * and `convert` then fails closed. A currency the rate map could not serve
 * produces no bound, so its offers satisfy no price filter and are reported in
 * {@link ConvertedPriceBounds.unconvertible}. An unconvertible price is never
 * shown as "too expensive": the `SearchFxContext` posture, one surface over.
 */

import { ALL_CURRENCY_CODES, assertSafeMoneyAmount } from '@mercaria/shared-types';
import type { CurrencyCode } from '@mercaria/shared-types';
import type { FacetPriceBound, FacetPriceSpanRow } from '../../db/facets/facetRepository.js';
import { convert, getRates } from '../fx.service.js';

/** The bound, per currency, plus what could not be converted. */
export interface ConvertedPriceBounds {
  readonly bounds: readonly FacetPriceBound[];
  readonly unconvertible: readonly CurrencyCode[];
}

/** Narrow a stored currency string to the presentment set, or `null`. */
export function asCurrencyCode(value: string): CurrencyCode | null {
  return (ALL_CURRENCY_CODES as readonly string[]).includes(value)
    ? (value as CurrencyCode)
    : null;
}

/**
 * Convert one bound into every currency present in scope.
 *
 * ONE `getRates` for the whole request. A per-currency call would make the
 * request's FX behaviour depend on how many currencies a category happened to
 * contain, which is `offer-context.ts`'s reasoning at a different grain.
 */
export async function convertPriceBound(
  bound: { readonly currency: CurrencyCode; readonly minMinor?: number; readonly maxMinor?: number },
  presentCurrencies: readonly CurrencyCode[],
): Promise<ConvertedPriceBounds> {
  const targets = [...new Set(presentCurrencies)].filter((code) => code !== bound.currency);
  const bounds: FacetPriceBound[] = [];
  const unconvertible: CurrencyCode[] = [];

  if (presentCurrencies.includes(bound.currency)) {
    bounds.push({
      currency: bound.currency,
      ...(bound.minMinor === undefined ? {} : { minMinor: bound.minMinor }),
      ...(bound.maxMinor === undefined ? {} : { maxMinor: bound.maxMinor }),
    });
  }
  if (targets.length === 0) return { bounds, unconvertible };

  const rates = await getRates(bound.currency, targets);
  for (const target of targets) {
    try {
      const min =
        bound.minMinor === undefined
          ? undefined
          : convert({ amount: bound.minMinor, currency: bound.currency }, target, rates).amount;
      const max =
        bound.maxMinor === undefined
          ? undefined
          : convert({ amount: bound.maxMinor, currency: bound.currency }, target, rates).amount;
      bounds.push({
        currency: target,
        ...(min === undefined ? {} : { minMinor: min }),
        ...(max === undefined ? {} : { maxMinor: max }),
      });
    } catch {
      // `convert` throws when either side has no rate — it never fabricates one.
      // That refusal IS the answer here: the currency is reported and its offers
      // simply do not satisfy the bound.
      unconvertible.push(target);
    }
  }
  return { bounds, unconvertible };
}

/** One price span, expressed in the currency the shopper is shopping in. */
export interface FacetPriceSpan {
  readonly minMinor: number;
  readonly maxMinor: number;
  readonly currency: CurrencyCode;
  readonly unconvertible: readonly CurrencyCode[];
}

/**
 * Collapse the per-currency spans into one span in the display currency.
 *
 * The repository groups by the offer's own currency precisely so nothing here
 * compares raw minor units across currencies. Each group's endpoints are
 * converted and the extremes taken afterwards; a group whose currency has no
 * rate contributes NOTHING and is named, rather than being folded in at face
 * value — which is the cross-currency comparison every money rule in this
 * repository forbids.
 *
 * `null` when nothing convertible was present at all: a slider with no endpoints
 * is not a slider, and reporting `0…0` would claim the catalogue is free.
 */
export async function composePriceSpan(
  spans: readonly FacetPriceSpanRow[],
  display: CurrencyCode,
): Promise<FacetPriceSpan | null> {
  const sources = [
    ...new Set(
      spans.flatMap((span) => {
        const code = asCurrencyCode(span.currency);
        return code === null ? [] : [code];
      }),
    ),
  ];
  if (sources.length === 0) return null;

  const quotes = sources.filter((code) => code !== display);
  const rates = quotes.length === 0 ? null : await getRates(display, quotes);

  let low: number | undefined;
  let high: number | undefined;
  const unconvertible: CurrencyCode[] = [];

  for (const span of spans) {
    const code = asCurrencyCode(span.currency);
    if (code === null) continue;
    let min = span.minMinor;
    let max = span.maxMinor;
    if (code !== display) {
      if (rates === null) {
        unconvertible.push(code);
        continue;
      }
      try {
        min = convert({ amount: span.minMinor, currency: code }, display, rates).amount;
        max = convert({ amount: span.maxMinor, currency: code }, display, rates).amount;
      } catch {
        unconvertible.push(code);
        continue;
      }
    }
    low = low === undefined ? min : Math.min(low, min);
    high = high === undefined ? max : Math.max(high, max);
  }

  if (low === undefined || high === undefined) {
    return null;
  }
  assertSafeMoneyAmount(low, 'facets.priceSpan.min');
  assertSafeMoneyAmount(high, 'facets.priceSpan.max');
  return {
    minMinor: low,
    maxMinor: high,
    currency: display,
    unconvertible: [...new Set(unconvertible)].sort(),
  };
}
