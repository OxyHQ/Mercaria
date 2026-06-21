import type { CurrencyCode, Money } from "@mercaria/shared-types";

/**
 * Product cards consume the canonical server-serialized `ProductSummary` DTO
 * directly — single source of truth in `@mercaria/shared-types`, no local
 * view-model duplication. Re-exported here so marketplace components import the
 * card type from a single place alongside their formatting helpers.
 */
export type { ProductSummary } from "@mercaria/shared-types";

/** ISO-4217 currency code → display symbol. */
const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
};

/** Number of minor units in one major unit (cents per dollar/euro/pound). */
const MINOR_UNITS_PER_MAJOR = 100;

/**
 * Format a `Money` value (integer minor units) as a display string, e.g.
 * `{ amount: 14800, currency: "USD" }` → `"$148.00"`.
 */
export function formatMoney(money: Money): string {
  const symbol = CURRENCY_SYMBOLS[money.currency];
  const major = money.amount / MINOR_UNITS_PER_MAJOR;
  return `${symbol}${major.toFixed(2)}`;
}

/** Threshold above which review counts are abbreviated with a "K" suffix. */
const THOUSAND = 1000;

/**
 * Format a review count, abbreviating thousands with a single-decimal "K"
 * (e.g. `349` → `"349"`, `10300` → `"10.3K"`, `1000` → `"1K"`).
 */
export function formatReviewCount(n: number): string {
  if (n < THOUSAND) {
    return `${n}`;
  }
  const thousands = n / THOUSAND;
  // Drop a trailing ".0" so 1000 → "1K", but keep 10.3K.
  const rounded = Math.round(thousands * 10) / 10;
  const label = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
  return `${label}K`;
}
