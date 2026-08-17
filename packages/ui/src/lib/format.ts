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
 * bidirectional classes — a currency symbol (`ET`, or `ON` for FAIR's `U+229C`),
 * digits (`EN`), a separating space (`WS`), a Latin currency code or unit (`L`),
 * a decimal point (`CS`), a sign (`ES`) — and every one is
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

/**
 * A well-formed ISO 3166-1 alpha-2 region subtag — the shape `Address.country`
 * carries, and the ONLY shape {@link formatRegionName} hands to `Intl`.
 *
 * This is a guard against a THROW, not tidiness. `Intl.DisplayNames.of` raises
 * `RangeError: argument is not a region subtag` for anything that is not two
 * letters or three digits — measured on `"U1"`, `"U"`, `"USAA"`, `"12"` and the
 * empty string. Testing the shape first is what makes the `catch` below
 * unreachable for every input this DTO can hold, rather than load-bearing.
 */
const ISO_ALPHA2_REGION = /^[A-Za-z]{2}$/u;

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

/**
 * Coerce what an API actually hands a screen into a `Date`, or `null`.
 *
 * `Intl.DateTimeFormat.format` throws `RangeError` on an invalid date, so the
 * two date formatters below funnel through this rather than each testing it.
 * The `NaN` check is the whole point: `new Date('not a date')` is an object, is
 * `instanceof Date`, and is truthy — the only thing that distinguishes it is
 * its time value.
 */
function toValidDate(value: Date | string | number): Date | null {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Format a date in the APP's locale (#488).
 *
 * ## The locale is a required parameter, and that is the fix
 *
 * Every call site this replaced was `new Date(x).toLocaleDateString()`, which
 * resolves against the RUNTIME's default locale — the DEVICE. A shopper reading
 * Mercaria in Japanese on an English phone got an English date inside a Japanese
 * sentence. The locale therefore has no default here: omitting it is a type
 * error rather than a silent reversion to the device, which is the only spelling
 * that cannot regress. Callers take it from `useTranslation()`, which already
 * returns the active locale beside `t`.
 *
 * ## `dateStyle: 'medium'`, deliberately, and it is a presentation change
 *
 * The replaced calls passed NO options, so they rendered the device's idea of a
 * SHORT date — `8/17/2026` for one reader and `17/08/2026` for another. That
 * form is genuinely ambiguous across locales: `03/04/2026` is the 3rd of April
 * to most of the world and the 4th of March in the US, and nothing on the page
 * says which is meant. `medium` names the month instead, so the date is
 * unambiguous in every locale for the cost of a few characters.
 *
 * Returns `null` for an unparseable value rather than the string `"Invalid
 * Date"`, which is what the replaced expressions rendered — untranslated
 * English, in every one of the twelve locales.
 */
export function formatDate(value: Date | string | number, locale: string): string | null {
  const parsed = toValidDate(value);
  if (parsed === null) {
    return null;
  }
  return isolateBidi(new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed));
}

/**
 * Format a date AND time in the app's locale — {@link formatDate}'s rules, plus
 * a short clock, for the surfaces that show when something last happened.
 *
 * A separate export rather than an options argument: the two are different
 * presentation decisions with different callers, and an options bag would let a
 * caller pass `dateStyle` and quietly reintroduce the per-call-site divergence
 * this pair exists to remove.
 */
export function formatDateTime(value: Date | string | number, locale: string): string | null {
  const parsed = toValidDate(value);
  if (parsed === null) {
    return null;
  }
  return isolateBidi(
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(parsed),
  );
}

/**
 * Name a country in the app's locale, falling back to its own code (#489).
 *
 * A saved address stores `US`; the address book and the checkout confirmation
 * both rendered that code verbatim, in all twelve languages. There is no bundle
 * key for this and there must not be: ~250 region codes across twelve locales is
 * 3,000 sentences of translated data that CLDR already ships and keeps current,
 * and hand-maintaining it would guarantee a partial list rather than a wrong
 * one. So the platform's own data is the shared source, which is what #489 asks
 * for.
 *
 * ## Why this may fall back, and why falling back is safe here
 *
 * `Intl.DisplayNames` is NOT guaranteed by every engine this package ships to —
 * Hermes' `Intl` surface is narrower than V8's, and this repo has already been
 * bitten by a construct `hermesc` accepts and the Hermes RUNTIME rejects. Every
 * branch that cannot produce a name therefore returns the code itself:
 *
 *   - the constructor is absent (an engine without it),
 *   - the code is not a well-formed alpha-2 subtag (see {@link ISO_ALPHA2_REGION}),
 *   - `fallback: "none"` answered `undefined` — a well-formed but UNASSIGNED
 *     code such as `XX`, which without that option echoes the code back as if it
 *     had resolved,
 *   - the call threw anyway.
 *
 * The floor is therefore exactly today's rendering, never a crash and never a
 * blank where a country belongs. That is the reverse of the rule for a CLOSED
 * vocabulary — #489's five search kinds get an exhaustive `Record` that fails
 * `tsc`, precisely because a fallback there would silently ship the identifier
 * again. The distinction is that a region code is an OPEN standard vocabulary
 * whose authority is the platform, and its "fallback" is a legible answer rather
 * than a leaked internal token.
 */
export function formatRegionName(code: string, locale: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const upper = trimmed.toUpperCase();
  const fallback = isolateBidi(upper);
  const displayNames = (Intl as { DisplayNames?: unknown }).DisplayNames;
  if (typeof displayNames !== "function" || !ISO_ALPHA2_REGION.test(upper)) {
    return fallback;
  }
  try {
    const name = new Intl.DisplayNames([locale], { type: "region", fallback: "none" }).of(upper);
    return typeof name === "string" && name.length > 0 ? isolateBidi(name) : fallback;
  } catch {
    // Unreachable for an alpha-2 code on a conforming engine — kept because the
    // cost of being wrong about that is a crashed checkout screen, and the
    // recovery is the same legible code the caller started with.
    return fallback;
  }
}
