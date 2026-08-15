import {
  CURRENCY_PRECISION,
  CURRENCY_SYMBOLS,
  type Money,
  type OfferMoney,
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

/**
 * Format an OFFER's own money — the price in the currency its SOURCE published
 * (#71 offer row 3, "price and source currency").
 *
 * Deliberately separate from {@link formatMoney}, because an `OfferMoney`'s
 * currency is a shape-checked string rather than a `CurrencyCode`: an external
 * platform reports whatever it trades in, which may be outside Mercaria's
 * presentment set (ADR 0002 D18's documented exception).
 *
 * Returns `null` when the precision is unknown, and that refusal is the whole
 * point. The amount is in MINOR units, so rendering `129900 RON` without
 * knowing whether RON has two decimals or none is a figure wrong by a factor of
 * a hundred — the "unknown is never zero" rule applied to a divisor. A caller
 * that gets `null` shows the currency code and no number, which is the honest
 * statement that Mercaria cannot express this price.
 */
export function formatSourceMoney(money: OfferMoney): string | null {
  const precision = CURRENCY_PRECISION[money.currency as Money["currency"]];
  if (precision === undefined) return null;
  const major = money.amount / DECIMAL_RADIX ** precision;
  return `${major.toFixed(DISPLAY_FRACTION_DIGITS)} ${money.currency}`;
}

/** Threshold above which review counts are abbreviated with a "K" suffix. */
const THOUSAND = 1000;

/** Metres in a kilometre — the point the distance unit changes. */
const METRES_PER_KM = 1000;

/**
 * Format a coarse distance in metres (#93 nearby rule 5).
 *
 * Every figure that reaches this function has ALREADY been coarsened by the
 * server — `coarsenMetres` rounds OUTWARD to 100 m below 10 km and to 1 km
 * above, because three exact distances from an unknown position to three
 * published shop fronts solve for that position. So this is a display helper
 * and never a precision decision: it must not round further (that would
 * understate a walk) and it must not add precision the number does not have.
 *
 * Lifted out of `OfferLabelBadge`'s private `basisText`, where it was the only
 * distance code in the package, so #93's location surfaces and #74's
 * `best_nearby_pickup` badge cannot drift into two different renderings of one
 * metre count.
 */
export function formatDistance(metres: number): string {
  return metres < METRES_PER_KM
    ? `${Math.round(metres)} m`
    : `${(metres / METRES_PER_KM).toFixed(1)} km`;
}

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
