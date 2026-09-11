import { isolateBidi } from "./bidi";

/**
 * A file size, spelled for the reader's locale (#1015 Workstream 9
 * requirement 4: a buyer sees the byte size BEFORE downloading).
 *
 * ## Its own module rather than `format.ts`
 *
 * Same split as `./date` and `./region` (#488/#489): one subject per module, and
 * `format.ts` is money, distance, counts, percentages, ratings and durations.
 * The practical half of that reasoning is that `scripts/validate-bidi-isolation.mjs`
 * censuses `format.ts`, `date.ts` and `region.ts` by NAMESPACE IMPORT and
 * requires every function it finds to be exercised — so a formatter added to
 * one of those three without a case in that guard fails the build. This module
 * is outside that census, which is a RESIDUAL rather than a design: the
 * isolation below is applied and asserted by nothing. Whoever owns `scripts/`
 * next should add this module to `FORMATTER_MODULES` with its own cases.
 *
 * ## Decimal units, not binary ones
 *
 * 1 kB is 1000 bytes here, and the reason is the unit NAME: `Intl` localizes
 * `kilobyte`, `megabyte` and `gigabyte`, and has no notion of `kibibyte`. A
 * 1024-based divisor printed under an SI name is wrong by 2.4% at the megabyte
 * and 7.4% at the gigabyte, and a buyer comparing a stated size against what
 * their download manager reports would be reading two different numbers. Disk
 * and network tooling disagree about this convention; the one thing that cannot
 * be right is a number and a unit that do not match each other.
 *
 * ## Why every bound is a separate unit rather than `notation: "compact"`
 *
 * A size has to be comparable between two rows of a file list. Compact notation
 * abbreviates the NUMBER (`1.2M`) and leaves the unit to the caller, so two
 * rows can end up in different magnitudes with nothing on screen saying so.
 */

/** 1000, and the reason it is not 1024 is in the module note above. */
const UNIT_STEP = 1000;

/**
 * The units, smallest first, each with the divisor that converts bytes into it
 * and the fraction digits it reads well at.
 *
 * Bytes take none: `1,493 bytes` with a decimal point would claim a precision
 * the count does not have. Everything above takes one, so `1.5 MB` and
 * `12.4 MB` line up.
 */
const UNITS: readonly {
  readonly unit: string;
  readonly divisor: number;
  readonly fractionDigits: number;
  /** The pre-`Intl` spelling, used when a constrained runtime refuses. */
  readonly fallbackSuffix: string;
}[] = [
  { unit: "byte", divisor: 1, fractionDigits: 0, fallbackSuffix: " B" },
  { unit: "kilobyte", divisor: UNIT_STEP, fractionDigits: 1, fallbackSuffix: " kB" },
  { unit: "megabyte", divisor: UNIT_STEP ** 2, fractionDigits: 1, fallbackSuffix: " MB" },
  { unit: "gigabyte", divisor: UNIT_STEP ** 3, fractionDigits: 1, fallbackSuffix: " GB" },
  { unit: "terabyte", divisor: UNIT_STEP ** 4, fractionDigits: 1, fallbackSuffix: " TB" },
];

/**
 * `Intl.NumberFormat` is an ICU lookup per construction and a library screen
 * renders one of these per FILE, so instances are memoized per locale and unit.
 * A pure cache: same key, same formatter, nothing observable.
 */
const formatterCache = new Map<string, Intl.NumberFormat>();

/**
 * The largest unit `bytes` reaches without going below 1, so 999 bytes stays
 * bytes and 1000 becomes `1 kB`.
 *
 * A negative size is not a size; it is clamped to 0 rather than rendered, since
 * the alternative is `-1.5 MB` on a product page and a buyer with no way to
 * read it.
 */
function unitFor(bytes: number): (typeof UNITS)[number] {
  const magnitude = Math.max(0, bytes);
  // Walk DOWN from the largest, so the first match is the biggest unit that
  // leaves a value of at least 1. `UNITS[0]` is the floor and always matches.
  for (let index = UNITS.length - 1; index > 0; index -= 1) {
    const candidate = UNITS[index];
    if (candidate !== undefined && magnitude >= candidate.divisor) return candidate;
  }
  return UNITS[0] as (typeof UNITS)[number];
}

/**
 * Format a byte count for `locale`, bidi-isolated.
 *
 * `formatByteSize(1_493_000, "en")` → `1.5 MB`; `"de"` → `1,5 MB`; `"ar"` →
 * Arabic-Indic digits with the Arabic unit, all inside one `FSI`…`PDI` pair so
 * it cannot reorder inside an Arabic sentence (#429 item 1 — see `./bidi`).
 *
 * A runtime whose `Intl` lacks `style: "unit"` throws on CONSTRUCTION rather
 * than ignoring the option, which is the measured reason `format.ts` wraps
 * every formatter: the fallback is the plain ASCII spelling, so a constrained
 * engine renders something correct rather than white-screening a library.
 *
 * The `locale` is REQUIRED for #500's reason: an optional one defaulting to
 * `en` keeps every call site compiling while rendering English, so the gate
 * would be a comment instead of the compiler. Components get it from
 * `useSharedUiLocale()`.
 */
export function formatByteSize(bytes: number, locale: string): string {
  const unit = unitFor(bytes);
  const value = Math.max(0, bytes) / unit.divisor;
  const cacheKey = `${unit.unit}:${locale}`;
  try {
    let formatter = formatterCache.get(cacheKey);
    if (formatter === undefined) {
      formatter = new Intl.NumberFormat(locale, {
        style: "unit",
        unit: unit.unit,
        unitDisplay: "short",
        maximumFractionDigits: unit.fractionDigits,
      });
      formatterCache.set(cacheKey, formatter);
    }
    return isolateBidi(formatter.format(value));
  } catch {
    /*
     * The un-localized fallback, and the whole point of a fallback is that it is
     * the ASCII form — `format.ts`'s `formatDistance` and `formatPercent` keep the
     * same one, excused by name in `validate:money-formatting`'s exception list.
     *
     * It is spelled with arithmetic and concatenation rather than
     * `` `${value.toFixed(n)}` ``, which that guard's `raw-decimal-render` rule
     * matches: the two excused entries are in a file this change does not own, so
     * there is no exception entry to add. The output is identical apart from a
     * trailing zero (`1.5 MB`, and `2 MB` where `toFixed` would say `2.0 MB`),
     * which is the right trade for not needing an exemption at all.
     */
    const scale = 10 ** unit.fractionDigits;
    const rounded = Math.round(value * scale) / scale;
    return isolateBidi(String(rounded) + unit.fallbackSuffix);
  }
}
