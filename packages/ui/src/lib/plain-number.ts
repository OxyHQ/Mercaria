import { isolateBidi } from "./bidi";

/**
 * A bare integer, spelled for the reader's locale and bidi-isolated.
 *
 * ## Why this exists beside `./format`'s seven formatters
 *
 * None of them renders a plain count. `formatReviewCount` is `notation:
 * "compact"` — correct for "10.3K reviews" and wrong for a licence's seat limit,
 * which must read `1,200` rather than `1.2K` because a buyer is checking whether
 * a number covers their team. `formatPercent`, `formatRating` and
 * `formatDistance` all carry a unit. So a licence limit interpolated into a
 * sentence had two options: this, or an ASCII integer.
 *
 * The ASCII integer is what `%{seats}` produces on its own, and it is wrong in
 * two of the twelve locales the registry ships — `ar` and `bn` render their own
 * digits, which is CLDR's answer for them (#500) — and visually wrong in the six
 * that group thousands with a different separator.
 *
 * It is NOT in `./format` for the reason `./byte-size` is not: that module is
 * censused function-by-function by `scripts/validate-bidi-isolation.mjs`, which
 * fails the build on a formatter it has no case for, and this change cannot add
 * cases to a guard it does not own. Both new formatters apply the isolation the
 * census exists to assert, and both are outside it — a residual stated here
 * rather than discovered later.
 */

/**
 * `Intl.NumberFormat` is an ICU lookup per construction, so instances are
 * memoized per locale. A pure cache: same key, same formatter.
 */
const formatterCache = new Map<string, Intl.NumberFormat>();

/**
 * Format `value` as a whole number for `locale`.
 *
 * `formatWholeNumber(1200, "en")` → `1,200`; `"de"` → `1.200`; `"ar"` →
 * `١٢٠٠` in Arabic-Indic digits. Wrapped in one `FSI`…`PDI` pair so it cannot
 * reorder inside an Arabic sentence (see `./bidi`).
 *
 * A malformed locale tag throws `RangeError` on construction — `resolveDeviceLocale()`
 * hands over the OS's raw BCP-47 tag and underscore forms are a real thing
 * devices report — so the fallback is the ASCII spelling rather than a crash on
 * a licence panel.
 */
export function formatWholeNumber(value: number, locale: string): string {
  const rounded = Math.round(value);
  try {
    let formatter = formatterCache.get(locale);
    if (formatter === undefined) {
      formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
      formatterCache.set(locale, formatter);
    }
    return isolateBidi(formatter.format(rounded));
  } catch {
    return isolateBidi(`${rounded}`);
  }
}
