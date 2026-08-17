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
 * ## Every formatter below takes an explicit `locale` (#500)
 *
 * `toFixed` emits an ASCII `.` whatever the reader's language is, which is wrong
 * in eight of the twelve locales the registry ships: `es`, `ca`, `de`, `fr`,
 * `pt-BR` and `ru` separate decimals with a comma, and `ar` and `bn` use their
 * own digits. The `K` abbreviation is English — `ja`/`zh-Hans` abbreviate with
 * 万 and German does not abbreviate at that magnitude at all.
 *
 * The locale is a REQUIRED parameter rather than an optional one defaulting to
 * `en`. An optional one keeps every existing call site compiling and rendering
 * English, so the change would land, look complete, and fix nothing at 49 call
 * sites — an inert fix that reads as coverage. Required makes `tsc` the gate:
 * the migration is total or the build is red, and no call site added later can
 * silently opt out.
 *
 * Components get it from {@link useFormatters}, which reads the ONE locale the
 * app already publishes through `SharedUiTranslationProvider` — the same call
 * that supplies `t`, so the language of a sentence and the spelling of the
 * number inside it cannot disagree. Non-React callers (`specifications.ts`, the
 * guards) pass a locale they already hold.
 *
 * ## Why the number is localized and the SYMBOL is not
 *
 * `formatMoney` keeps `CURRENCY_SYMBOLS`' symbol in front of a localized number
 * rather than using `style: "currency"`, which would also place the symbol by
 * locale (`148,00 $` in German). `style: "currency"` requires an ISO 4217 code
 * and throws `RangeError` on anything else — FAIR is not one, and it is
 * Mercaria's preferred default currency. Using it for ISO codes and not for
 * FAIR would be two conventions inside one formatter, which is the thing this
 * whole change exists to remove. So symbol placement stays LTR-prefixed for
 * every currency; that is a known limit, not an oversight.
 */

/**
 * `Intl.NumberFormat` instances are expensive to construct (each is an ICU
 * lookup) and these render inside lists, so they are memoized per locale and
 * option set. This is a PURE cache — same key, same formatter, no observable
 * state — and deliberately not the reactive kind the React Compiler rule is
 * about: nothing here changes what a component renders for a given input.
 */
const formatterCache = new Map<string, Intl.NumberFormat>();

/**
 * Format `value` for `locale`, degrading to `fallback` if the runtime refuses.
 *
 * Two refusals are real rather than theoretical, which is why this is a defined
 * path and not a `try` around an impossibility:
 *
 *   * **A malformed tag.** The locale in force is `resolveDeviceLocale()`'s raw
 *     BCP-47 tag straight from the OS, not a `SupportedLocale`. A tag Intl
 *     considers structurally invalid throws `RangeError` (`en_US` does, and
 *     underscore forms are a real thing devices have reported) — and this is a
 *     PRICE formatter, so an uncaught throw white-screens a product page.
 *   * **A constrained Intl build.** `notation: "compact"` and `style: "unit"`
 *     are the two options a cut-down engine is likeliest to lack, and an engine
 *     that lacks one throws on construction rather than ignoring it.
 *
 * The fallback is each formatter's PRE-#500 output, so a runtime that cannot
 * localize renders exactly what shipped before this change rather than
 * something new and worse.
 */
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
 * then shown with 2 fraction digits for readability, spelled for `locale`. E.g.
 * `{ amount: 14_800_000_000, currency: "FAIR" }` → `⊜148.00` and
 * `{ amount: 14800, currency: "USD" }` → `$148.00` in `en`, and `⊜148,00` /
 * `$148,00` in `de`, `es`, `fr`, `ca`, `pt-BR` and `ru`. Each is wrapped in
 * `FSI` ... `PDI` (see the module note above), so the returned string carries
 * two more code points than the text it displays.
 *
 * Note that English output GAINS grouping separators, which `toFixed` never
 * emitted: a price of 1234.56 was `$1234.56` and is now `$1,234.56`. That is a
 * deliberate part of the change rather than a side effect — it is what `en`
 * grouping is — and it is the one way existing English rendering moves.
 */
export function formatMoney(money: Money, locale: string): string {
  const symbol = CURRENCY_SYMBOLS[money.currency];
  const major = money.amount / DECIMAL_RADIX ** CURRENCY_PRECISION[money.currency];
  const figure = formatNumber(
    major,
    locale,
    "money",
    {
      minimumFractionDigits: DISPLAY_FRACTION_DIGITS,
      maximumFractionDigits: DISPLAY_FRACTION_DIGITS,
    },
    () => major.toFixed(DISPLAY_FRACTION_DIGITS),
  );
  return isolateBidi(`${symbol}${figure}`);
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
export function formatSourceMoney(money: OfferMoney, locale: string): string | null {
  const precision = CURRENCY_PRECISION[money.currency as Money["currency"]];
  if (precision === undefined) return null;
  const major = money.amount / DECIMAL_RADIX ** precision;
  const figure = formatNumber(
    major,
    locale,
    "money",
    {
      minimumFractionDigits: DISPLAY_FRACTION_DIGITS,
      maximumFractionDigits: DISPLAY_FRACTION_DIGITS,
    },
    () => major.toFixed(DISPLAY_FRACTION_DIGITS),
  );
  // `148.00 RON` is a number, a space and a Latin code — the single worst shape
  // for reordering, and the `null` refusal above is deliberately NOT isolated:
  // absence has nothing to lay out.
  return isolateBidi(`${figure} ${money.currency}`);
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
export function formatDistance(metres: number, locale: string): string {
  if (metres < METRES_PER_KM) {
    const whole = Math.round(metres);
    return isolateBidi(
      formatNumber(
        whole,
        locale,
        "metres",
        { style: "unit", unit: "meter", unitDisplay: "short", maximumFractionDigits: 0 },
        () => `${whole} m`,
      ),
    );
  }
  const kilometres = metres / METRES_PER_KM;
  return isolateBidi(
    formatNumber(
      kilometres,
      locale,
      "kilometres",
      { style: "unit", unit: "kilometer", unitDisplay: "short", maximumFractionDigits: 1 },
      () => `${kilometres.toFixed(1)} km`,
    ),
  );
}

/**
 * Format a review count, abbreviated the way `locale` abbreviates one.
 *
 * In `en` that is the "K" this function used to hardcode — `349` → `349`,
 * `1000` → `1K`, `10300` → `10.3K`, byte for byte — but the abbreviation is a
 * property of the language and not of the number. `ja` and `zh-Hans` group by
 * ten thousand (`10300` → `1万`), `ru` says `10,3 тыс.`, and German does not
 * abbreviate at this magnitude at all (`10.300`). A hardcoded "K" is not a
 * smaller version of that; it is English shown to everybody.
 *
 * There is now ONE return rather than a bare-digit branch and an abbreviated
 * one. That was worth keeping while the two spellings were hand-written — a
 * caller interpolates the result into a sentence without knowing which branch
 * produced it, so `349 reviews` and `10.3K reviews` laying out by different
 * rules was a real hazard. `notation: "compact"` covers both magnitudes under
 * one convention, so the hazard is gone rather than guarded against.
 */
export function formatReviewCount(n: number, locale: string): string {
  return isolateBidi(
    formatNumber(
      n,
      locale,
      "count",
      { notation: "compact", compactDisplay: "short", maximumFractionDigits: 1 },
      () => {
        if (n < THOUSAND) return `${n}`;
        const thousands = n / THOUSAND;
        // Drop a trailing ".0" so 1000 → "1K", but keep 10.3K.
        const rounded = Math.round(thousands * 10) / 10;
        return `${Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1)}K`;
      },
    ),
  );
}

/** Basis points in one whole unit — 10 000 bp = 100%. */
const BASIS_POINTS_PER_UNIT = 10_000;
/** Basis points in one percent, for the un-localized fallback spelling. */
const BASIS_POINTS_PER_PERCENT = 100;

/**
 * Basis points as a percentage, to one decimal, always positive.
 *
 * MOVED here from `price-signal-labels.ts` (#500). It lived there as a private
 * helper whose own note said it spelled its numeral "the way every other
 * formatter in this package formats one — `toFixed` and an ASCII separator, no
 * `Intl` … Localising numerals is its own change across four formatters plus
 * `validate-bidi-isolation.mjs`". This is that change, so the helper comes with
 * it: these percentages are interpolated into the SAME sentence as a
 * `formatMoney` amount, and one of the two localising its separator while the
 * other does not is worse than neither doing it.
 *
 * Being here rather than there is also what puts it under the guard's census,
 * which enumerates this module's exports — a formatter the guard cannot see is
 * a formatter whose isolation nobody is checking.
 *
 * The DIRECTION is carried by WHICH SENTENCE was selected rather than by a
 * minus sign, because a screen reader announcing "minus eight percent" beside
 * the word "below" reads as two different claims.
 *
 * `style: "percent"` rather than a literal `%`, because the separator is not
 * the only thing that moves: `fr` puts a no-break space before the sign
 * (`8,2 %`) and `ar` uses its own (`٨٫٢٪؜`).
 */
export function formatPercent(deltaBps: number, locale: string): string {
  const magnitude = Math.abs(deltaBps);
  return isolateBidi(
    formatNumber(
      magnitude / BASIS_POINTS_PER_UNIT,
      locale,
      "percent",
      {
        style: "percent",
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      },
      () => `${(magnitude / BASIS_POINTS_PER_PERCENT).toFixed(1)}%`,
    ),
  );
}

/**
 * A star rating (0–5) to one decimal — `4.5` in `en`, `4,5` in `de`.
 *
 * Its own formatter rather than a `toFixed(1)` at the call site, because of
 * where the call sites are: `ReviewSummaryCard` renders one inside the SAME
 * template literal as a `formatReviewCount`, so a raw `.toFixed(1)` there
 * produced `10,3 mil unverified · 4.5` — one number localised and its immediate
 * neighbour not. That is precisely the mixed sentence #500 exists to prevent,
 * and it was live.
 *
 * Isolated like every other formatter here: a bare `4.5` is digits and a
 * neutral separator, which reorders in an Arabic sentence exactly as a price
 * does.
 */
export function formatRating(rating: number, locale: string): string {
  return isolateBidi(
    formatNumber(
      rating,
      locale,
      "rating",
      { minimumFractionDigits: 1, maximumFractionDigits: 1 },
      () => rating.toFixed(1),
    ),
  );
}
