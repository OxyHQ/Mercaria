import { CURRENCY_PRECISION, CURRENCY_SYMBOLS, type Money } from './money';
import { isolateBidi } from './bidi';

const DECIMAL_RADIX = 10;
const DISPLAY_FRACTION_DIGITS = 2;
const formatterCache = new Map<string, Intl.NumberFormat>();

function formatNumber(
  value: number,
  locale: string,
  cacheKind: string,
  options: Intl.NumberFormatOptions,
  fallback: () => string,
): string {
  const cacheKey = `${cacheKind}:${locale}`;
  try {
    let formatter = formatterCache.get(cacheKey);
    if (formatter === undefined) {
      formatter = new Intl.NumberFormat(locale, options);
      formatterCache.set(cacheKey, formatter);
    }
    return formatter.format(value);
  } catch {
    return fallback();
  }
}

/** Canonical localized catalog price, shared by Mercaria UI and headless SDK consumers. */
export function formatMoney(money: Money, locale: string): string {
  const symbol = CURRENCY_SYMBOLS[money.currency];
  const major = money.amount / DECIMAL_RADIX ** CURRENCY_PRECISION[money.currency];
  const figure = formatNumber(
    major,
    locale,
    'money',
    {
      minimumFractionDigits: DISPLAY_FRACTION_DIGITS,
      maximumFractionDigits: DISPLAY_FRACTION_DIGITS,
    },
    () => major.toFixed(DISPLAY_FRACTION_DIGITS),
  );
  return isolateBidi(`${symbol}${figure}`);
}
