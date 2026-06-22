import {
  CURRENCY_PRECISION,
  CURRENCY_SYMBOLS,
  type Money,
} from "@mercaria/shared-types";

/**
 * Product cards consume the canonical server-serialized `ProductSummary` DTO
 * directly — single source of truth in `@mercaria/shared-types`, no local
 * view-model duplication. Re-exported here so marketplace components import the
 * card type from a single place alongside their formatting helpers.
 */
export type { ProductSummary } from "@mercaria/shared-types";

/** Radix used to derive minor units from a currency's decimal precision. */
const DECIMAL_RADIX = 10;
/** Fraction digits shown by default — 8dp FAIR is unwieldy, so 2dp reads cleanly. */
const DISPLAY_FRACTION_DIGITS = 2;

/**
 * Format a `Money` value (integer minor units) as a precision-aware display
 * string. The major value is derived from the currency's precision
 * (`CURRENCY_PRECISION`), so FAIR (8dp) and USD (2dp) both render correctly,
 * then shown with 2 fraction digits for readability. E.g.
 * `{ amount: 14_800_000_000, currency: "FAIR" }` → `"⊜148.00"` and
 * `{ amount: 14800, currency: "USD" }` → `"$148.00"`.
 */
export function formatMoney(money: Money): string {
  const symbol = CURRENCY_SYMBOLS[money.currency];
  const major = money.amount / DECIMAL_RADIX ** CURRENCY_PRECISION[money.currency];
  return `${symbol}${major.toFixed(DISPLAY_FRACTION_DIGITS)}`;
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
