import type {
  CurrencyCode,
  StorePricePositionBand,
  StorePriceUnmeasuredReason,
} from '@mercaria/shared-types';
import { formatMoney } from '@mercaria/ui';

/**
 * The price-analytics tool's closed vocabularies, as translation KEYS (#398:
 * module scope is evaluated before the locale store rehydrates, so it holds keys
 * and the screen resolves them).
 *
 * `Record`s over the shared-types tuples, so a band or a reason added on the
 * server fails the dashboard's typecheck until it has copy.
 */
export const BAND_LABEL_KEYS: Record<StorePricePositionBand, string> = {
  lowest: 'priceAnalytics.band.lowest',
  near_lowest: 'priceAnalytics.band.nearLowest',
  at_or_below_median: 'priceAnalytics.band.atOrBelowMedian',
  above_median: 'priceAnalytics.band.aboveMedian',
};

export const REASON_LABEL_KEYS: Record<StorePriceUnmeasuredReason, string> = {
  no_active_policy: 'priceAnalytics.reason.noActivePolicy',
  price_missing: 'priceAnalytics.reason.priceMissing',
  currency_not_comparable: 'priceAnalytics.reason.currencyNotComparable',
  condition_unknown: 'priceAnalytics.reason.conditionUnknown',
  insufficient_observations: 'priceAnalytics.reason.tooFewOffers',
  insufficient_distinct_sellers: 'priceAnalytics.reason.tooFewSellers',
  insufficient_distinct_offers: 'priceAnalytics.reason.tooFewOffers',
};

/**
 * A neutral tint per band. Deliberately not red/green: a price above the median
 * is a fact about the market, not a fault, and the tool recommends nothing.
 */
export function bandToneClass(band: StorePricePositionBand): string {
  switch (band) {
    case 'lowest':
      return 'bg-primary/15';
    case 'near_lowest':
      return 'bg-primary/10';
    case 'at_or_below_median':
      return 'bg-muted';
    case 'above_median':
      return 'bg-surface border border-border';
  }
}

/** An amount of the row's own currency, formatted — never converted on the client. */
export function rowMoney(
  amount: number | null | undefined,
  currency: string | null,
  locale: string,
): string | null {
  if (amount === null || amount === undefined || currency === null) return null;
  return formatMoney({ amount, currency: currency as CurrencyCode }, locale);
}
