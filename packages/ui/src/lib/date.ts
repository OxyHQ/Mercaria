import { isolateBidi } from "./bidi";

/**
 * Dates rendered in the APP's locale (#488).
 *
 * ## Why this is its own module rather than part of `./format`
 *
 * It landed in `format.ts` in #513 and moved out immediately, because #500 is
 * rewriting every formatter in that file to be locale-aware and two agents
 * editing one file is a conflict nobody learns anything from. The split that
 * survives is by SUBJECT — money, distance and counts there, dates here,
 * regions in `./region` — rather than by "needs a locale", which stopped
 * separating anything once #500 made the money formatters locale-aware too.
 *
 * It is still `@mercaria/ui`, so the house rule holds: an app keeps no local
 * copy of anything this package owns, and a date formatter is squarely that.
 *
 * ## The locale is a REQUIRED parameter, and that is the fix
 *
 * Every call site this replaced was `new Date(x).toLocaleDateString()`, which
 * resolves against the RUNTIME's default locale — the DEVICE. A shopper reading
 * Mercaria in Japanese on an English phone got an English date inside a Japanese
 * sentence. So the locale has no default here: omitting it is a type error
 * rather than a silent reversion to the device, which is the only spelling that
 * cannot regress.
 *
 * There is exactly ONE source for that value and this module must not become a
 * second one. In an app screen it is `useTranslation().locale`; inside
 * `packages/ui` it is `useSharedUiLocale()`, which the three app roots feed from
 * the same store. Never `resolveDeviceLocale()`, never `i18n.locale`, never a
 * module-level `let` — a date and a price disagreeing about the locale on one
 * screen is exactly what one source prevents.
 *
 * ## Every value is BIDI-ISOLATED
 *
 * A formatted date is mostly neutral characters — digits (`EN`), separators
 * (`CS`), a space (`WS`) — and every caller interpolates it into localized prose
 * (`Checked %{date}`, `Saved %{when} · step %{step}`). Dropped into an Arabic
 * sentence with no strong character to anchor it, that run reorders. This is the
 * same argument `./format`'s module note makes for money, so the same remedy
 * applies, applied at the RETURN so a caller added later inherits it.
 * `scripts/validate-bidi-isolation.mjs` asserts it by CODE POINT, because
 * `FSI`/`PDI` are zero-width and a wrong implementation looks identical.
 */

/**
 * One `Intl.DateTimeFormat` per (locale, style), built once.
 *
 * Construction is an ICU lookup, and these render inside lists — an order
 * history builds one per row otherwise. Keyed on the locale STRING rather than
 * on a resolved tag, because the fallbacks below can answer for a key that is
 * not a valid tag at all and the cache has to remember that too.
 */
const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat | null>();

/** The two presentations this module offers. See each exported function. */
const STYLE_OPTIONS: Readonly<Record<"date" | "dateTime", Intl.DateTimeFormatOptions>> = {
  date: { dateStyle: "medium" },
  dateTime: { dateStyle: "medium", timeStyle: "short" },
};

/**
 * Build a formatter, degrading rather than throwing — and never degrading to
 * something WORSE than what shipped before this module existed.
 *
 * Two real failure modes, neither hypothetical:
 *
 *   1. **A malformed tag throws `RangeError`.** The locale is the OS's raw
 *      value (`getLocales()[0].languageTag`), and `new Intl.DateTimeFormat(
 *      "en_US")` — an underscore rather than a hyphen — raises. Measured
 *      against the shipped #513 code: `en_US`, `es_ES` and `zh_Hans_CN` all
 *      threw. Uncaught in a render path, that white-screens the screen.
 *   2. **A constrained engine throws on OPTIONS it does not implement.**
 *      `dateStyle` is newer than the rest of `Intl.DateTimeFormat`.
 *
 * So: the requested locale, then the runtime default with the same options,
 * then the runtime default with none. The second and third rungs are the DEVICE
 * locale — i.e. exactly the behaviour this module exists to replace — which is
 * the point: a runtime that cannot honour the app's locale is never rendered
 * worse than it was before, only no better.
 *
 * Deliberately NOT `toLocaleDateString()` on any rung. That is the spelling
 * check H in `validate-i18n-strings.mjs` forbids across all four packages, and a
 * guard that has to exempt its own remedy is a guard with a hole in it.
 */
function formatterFor(locale: string, style: "date" | "dateTime"): Intl.DateTimeFormat | null {
  const key = `${style} ${locale}`;
  const cached = FORMATTER_CACHE.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const options = STYLE_OPTIONS[style];
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat(locale, options);
  } catch {
    try {
      formatter = new Intl.DateTimeFormat(undefined, options);
    } catch {
      try {
        formatter = new Intl.DateTimeFormat();
      } catch {
        // No usable date formatter at all. `null` reaches the caller as an
        // absent date, which every call site already renders as nothing —
        // rather than a half-built string nobody chose.
        formatter = null;
      }
    }
  }
  FORMATTER_CACHE.set(key, formatter);
  return formatter;
}

/**
 * Coerce what an API actually hands a screen into a `Date`, or `null`.
 *
 * The `NaN` check is the whole point: `new Date('not a date')` is an object, is
 * `instanceof Date`, and is truthy — the only thing that distinguishes it is its
 * time value. `Intl.DateTimeFormat.format` throws `RangeError` on an invalid
 * date, so both date formatters funnel through here.
 */
function toValidDate(value: Date | string | number): Date | null {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Shared body: a valid date plus a usable formatter, else `null`. */
function render(
  value: Date | string | number,
  locale: string,
  style: "date" | "dateTime",
): string | null {
  const parsed = toValidDate(value);
  if (parsed === null) {
    return null;
  }
  const formatter = formatterFor(locale, style);
  if (formatter === null) {
    return null;
  }
  return isolateBidi(formatter.format(parsed));
}

/**
 * Format a date in the app's locale.
 *
 * ## `dateStyle: 'medium'`, deliberately, and it is a presentation change
 *
 * The calls this replaced passed NO options, so they rendered the device's idea
 * of a SHORT date — `8/17/2026` for one reader and `17/08/2026` for another.
 * That form is genuinely ambiguous across locales: `03/04/2026` is the 3rd of
 * April to most of the world and the 4th of March in the US, and nothing on the
 * page says which is meant. `medium` names the month instead.
 *
 * Returns `null` for an unparseable value rather than the string `"Invalid
 * Date"`, which is what the replaced expressions rendered — untranslated
 * English, in every one of the twelve locales. A `null` must never be
 * interpolated into a translated sentence: `i18n-js` renders a missing
 * placeholder as the literal `[missing "%{date}" value]`, so a caller composing
 * one drops the line instead.
 */
export function formatDate(value: Date | string | number, locale: string): string | null {
  return render(value, locale, "date");
}

/**
 * Format a date AND time in the app's locale — {@link formatDate}'s rules plus a
 * short clock, for the surfaces that show when something last happened.
 *
 * A separate export rather than an options argument: the two are different
 * presentation decisions with different callers, and an options bag would let a
 * caller pass its own `dateStyle` and quietly reintroduce the per-call-site
 * divergence this pair exists to remove.
 */
export function formatDateTime(value: Date | string | number, locale: string): string | null {
  return render(value, locale, "dateTime");
}
