import {
  CURRENCY_PRECISION,
  CURRENCY_SYMBOLS,
  type Money,
  type OfferMoney,
} from "@mercaria/shared-types";
import { isolateBidi } from "./bidi";

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
 * ## Every formatter below returns a BIDI-ISOLATED string (#429 item 1)
 *
 * This module is the display-formatting chokepoint the storefront, the
 * dashboard, the POS and `@mercaria/ui`'s own components all render money and
 * measurements through — Mercaria's AGENTS.md names `formatMoney` as the single
 * source of truth and forbids an app keeping a local copy. That makes it the one
 * place bidi isolation can be applied ONCE instead of per screen.
 *
 * Each of these emits a token whose characters have MIXED or purely NEUTRAL
 * bidirectional classes — a currency symbol (`ET`), digits (`EN`), a separating
 * space (`WS`), a Latin currency code or unit (`L`) — and every one is
 * interpolated into localized prose by its callers (`Delivery ${cost}`,
 * `${magnitude} lower than before`, `Lowest in this window: ${…}`). Dropped into
 * an Arabic sentence with no strong character to anchor them, those tokens
 * reorder. `isolateBidi` is applied at the RETURN of each rather than at the
 * call sites, so a screen added later inherits it and cannot forget.
 *
 * The characters are invisible, so the property is asserted by CODE POINT in
 * `scripts/validate-bidi-isolation.mjs` rather than by reading the output. See
 * `./bidi` for why `FSI`/`PDI` and not a visible mark.
 */

/**
 * Format a `Money` value (integer minor units) as a precision-aware display
 * string. The major value is derived from the currency's precision
 * (`CURRENCY_PRECISION`), so FAIR (8dp) and USD (2dp) both render correctly,
 * then shown with 2 fraction digits for readability. E.g.
 * `{ amount: 14_800_000_000, currency: "FAIR" }` → `⊜148.00` and
 * `{ amount: 14800, currency: "USD" }` → `$148.00`, each wrapped in
 * `FSI` ... `PDI` (see the module note above), so the returned string carries
 * two more code points than the text it displays.
 */
export function formatMoney(money: Money): string {
  const symbol = CURRENCY_SYMBOLS[money.currency];
  const major = money.amount / DECIMAL_RADIX ** CURRENCY_PRECISION[money.currency];
  return isolateBidi(`${symbol}${major.toFixed(DISPLAY_FRACTION_DIGITS)}`);
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
  // `148.00 RON` is a number, a space and a Latin code — the single worst shape
  // for reordering, and the `null` refusal above is deliberately NOT isolated:
  // absence has nothing to lay out.
  return isolateBidi(`${major.toFixed(DISPLAY_FRACTION_DIGITS)} ${money.currency}`);
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
  return isolateBidi(
    metres < METRES_PER_KM
      ? `${Math.round(metres)} m`
      : `${(metres / METRES_PER_KM).toFixed(1)} km`,
  );
}

/**
 * Format a review count, abbreviating thousands with a single-decimal "K"
 * (e.g. `349` → `349`, `10300` → `10.3K`, `1000` → `1K`), isolated per the
 * module note above.
 *
 * BOTH branches are isolated, including the bare-digit one that would be safe
 * on its own. A function whose two returns follow different conventions is the
 * half-migration `validate-rtl-logical-classes.mjs` exists to prevent, one
 * layer down: the caller interpolates the result into a sentence without
 * knowing which branch produced it, so `349 reviews` and `10.3K reviews` would
 * lay out by different rules for no reason a reader could see.
 */
export function formatReviewCount(n: number): string {
  if (n < THOUSAND) {
    return isolateBidi(`${n}`);
  }
  const thousands = n / THOUSAND;
  // Drop a trailing ".0" so 1000 → "1K", but keep 10.3K.
  const rounded = Math.round(thousands * 10) / 10;
  const label = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
  return isolateBidi(`${label}K`);
}
