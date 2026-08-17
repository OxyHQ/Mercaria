/**
 * Choosing the unit a measurement is SHOWN in, without touching the one it is
 * stored in (#367 Workstream 4, "localize unit display and choose display units
 * by locale/market/user preference without mutating stored values").
 *
 * ## Why this module exists at all
 *
 * `units.ts` already converts, deterministically and reversibly. What was
 * missing is the other half of the sentence: nothing anywhere decided WHICH unit
 * a shopper is shown. The public attribute surface served
 * `sourceDisplayValue` — the words the feed happened to write — so a catalogue
 * assembled from four suppliers showed one shopper `6.1 in`, `154.94 mm`,
 * `15.5 cm` and `154.94000000000001 mm` on four rows of one comparison table,
 * and a US shopper and a Spanish shopper saw exactly the same four.
 *
 * ## Three things this module refuses to do
 *
 * 1. **Convert anything.** It picks a unit and calls `units.ts`. There is no
 *    second conversion table here and no factor of any kind — a second table is
 *    a second answer, and the one that won would be whichever module a caller
 *    happened to import. `unit-authority.test.ts` fails the build on one.
 * 2. **Write anything.** Every function is pure and takes a magnitude. Nothing
 *    in the signature could reach a row, which is what "without mutating stored
 *    values" means when it is a property of the code rather than a promise.
 * 3. **Guess a measurement system.** {@link measurementSystemForMarket} answers
 *    `null` for a market it has no data for rather than `metric`, and an ABSENT
 *    preference renders nothing — the caller keeps the source's own words. A
 *    default of `metric` would be right most of the time and silently wrong for
 *    exactly the shoppers this exists to serve.
 *
 * ## Where the preference comes from, and where it does not
 *
 * From the CALLER, as an explicit measurement system. Never derived from the
 * reading LANGUAGE: `packages/frontend/lib/catalog/request-context.ts` reads it
 * off the DEVICE's CLDR measurement system precisely because a shopper reading
 * Spanish in Ohio is in a US-customary market, and taking it off the language
 * would be the collapse ADR 0007 D4 exists to prevent.
 * {@link measurementSystemForMarket} is offered as a FALLBACK for a caller that
 * has a market and no stated preference, and it encodes CLDR's own supplemental
 * `measurementData` rather than a rule of thumb.
 */

import type { UnitFamily } from '@mercaria/shared-types';
import { BASE_UNITS, convertUnit, unitFamilyOf } from './units.js';

/**
 * How a shopper prefers measurements shown.
 *
 * The three CLDR measurement systems, and deliberately NOT a fourth member
 * meaning "unstated": absence is expressed by passing no system at all, so a
 * caller cannot hold a value that looks like a preference and is not. The
 * storefront's `CatalogUnitSystem` carries `unspecified` because a React context
 * needs a value in every state; a function parameter does not.
 */
export type MeasurementSystem = 'metric' | 'us' | 'uk';

export const MEASUREMENT_SYSTEMS: readonly MeasurementSystem[] = ['metric', 'us', 'uk'];

/** Whether a token is one of the three systems — the request-parameter guard. */
export function isMeasurementSystem(value: string): value is MeasurementSystem {
  return (MEASUREMENT_SYSTEMS as readonly string[]).includes(value);
}

/**
 * The markets CLDR's supplemental `measurementData` records as NOT metric.
 *
 * Four entries, and the shortness is the point: CLDR's `001` default is
 * `metric`, and the whole of the override list is the United States, Liberia and
 * Myanmar on US customary plus the United Kingdom on imperial. Writing it out
 * makes the claim checkable; deriving it from anything — a currency, a language,
 * a continent — would be inventing a fact about a country.
 */
const NON_METRIC_MARKETS: Readonly<Record<string, MeasurementSystem>> = Object.freeze({
  US: 'us',
  LR: 'us',
  MM: 'us',
  GB: 'uk',
});

/**
 * The measurement system a market implies, or `null` when there is no market.
 *
 * `null` for an absent or malformed region, `metric` for a well-formed one CLDR
 * does not override. The two are different answers: "this shopper told us
 * nothing" is not "this shopper is metric", and a caller that treated them alike
 * would convert for somebody who never asked.
 */
export function measurementSystemForMarket(
  region: string | null | undefined,
): MeasurementSystem | null {
  if (typeof region !== 'string') return null;
  const normalized = region.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return null;
  return NON_METRIC_MARKETS[normalized] ?? 'metric';
}

/**
 * The unit each family is SHOWN in, per system — overrides only.
 *
 * Every base unit in `units.ts` is already the metric answer, so `metric` needs
 * no entry and having one would be a second place the metric answer lived.
 *
 * The three deliberate ABSENCES are the load-bearing part:
 *
 * - **UK volume has no override.** The imperial fluid ounce is 28.4130625 ml and
 *   the `fl_oz` in the unit table is the US one at 29.5735295625 ml. Mapping UK
 *   volume onto `fl_oz` would print a number 4 % wrong on every bottle, which is
 *   worse than printing millilitres — and millilitres is what a British label
 *   says anyway. A real imperial fluid ounce is a new row in `UNIT_DEFINITIONS`,
 *   not an approximation here.
 * - **Every other family is absent from both non-metric systems.** Digital
 *   storage, frequency, pixel count, luminance, electric charge, data rate,
 *   duration, power, energy and the three dimensionless families have no
 *   customary variant at all: a gigabyte is a gigabyte in Ohio.
 * - **Selection never reads the MAGNITUDE.** One unit per (family, system), so a
 *   900 g laptop and a 1.2 kg one are shown in the same unit and a shopper can
 *   compare them by eye. Picking `oz` under a pound and `lb` over it renders a
 *   comparison table nobody can read down, and it makes the display unit a
 *   function of the value — one step from the magnitude-driven unit inference
 *   #94 forbids outright.
 *
 * A PER-ATTRIBUTE override (screen size in inches for every market, because that
 * is what a screen size IS) is the right next refinement and is deliberately not
 * faked here: it belongs on the definition, as a `display_unit` column on
 * `attribute_definitions`, and it arrives with that migration.
 */
const DISPLAY_UNIT_OVERRIDES: Readonly<
  Record<MeasurementSystem, Readonly<Partial<Record<UnitFamily, string>>>>
> = Object.freeze({
  metric: Object.freeze({}),
  us: Object.freeze({ length: 'in', mass: 'lb', volume: 'fl_oz' }),
  uk: Object.freeze({ length: 'in', mass: 'lb' }),
});

/**
 * The unit a family is shown in under one system.
 *
 * Always a unit `units.ts` knows, because every override is looked up in it and
 * the fallback is the family's own base unit.
 */
export function resolveDisplayUnit(family: UnitFamily, system: MeasurementSystem): string {
  return DISPLAY_UNIT_OVERRIDES[system][family] ?? BASE_UNITS[family];
}

/**
 * The significant digits a source's own number carried.
 *
 * Leading zeros are not significant (`0.256` is three digits, not four); trailing
 * zeros in an integer are counted, which is the conventional reading of a
 * catalogue writing `1000 mm` and the only one available — the alternative needs
 * a notation no feed uses.
 */
export function significantDigits(numberText: string): number {
  const digits = numberText.replace(/[^0-9]/g, '').replace(/^0+/, '');
  return digits.length === 0 ? 1 : digits.length;
}

/**
 * The leading numeric token of a source's display string, or `null`.
 *
 * Anchored at the start and deliberately narrow, for the reason
 * `QUANTITY_PATTERN` is: this reads the PRECISION a source claimed, and a
 * pattern that scavenged a number out of the middle of a sentence would read the
 * precision of something that was never a measurement.
 */
export function sourceNumberText(display: string): string | null {
  const match = /^-?\d+(?:\.\d+)?/.exec(display.trim());
  return match?.[0] ?? null;
}

/**
 * The base-10 exponent of a magnitude — the `e` of its exponential form.
 *
 * Read off `toExponential` rather than computed with `Math.log10`, which is
 * inexact at the powers of ten (`Math.log10(0.001)` is not `-3`) and would
 * therefore misjudge precision on exactly the round numbers a catalogue is full
 * of. With it, "print N significant digits" is the single expression
 * `N - 1 - exponent`, correct above and below one.
 */
function exponent10(magnitude: number): number {
  if (!Number.isFinite(magnitude) || magnitude === 0) return 0;
  const exponential = Math.abs(magnitude).toExponential();
  return Number(exponential.slice(exponential.indexOf('e') + 1));
}

/** The most decimal places this module will ever print. */
export const MAX_DISPLAY_DECIMALS = 6;

/**
 * How many decimals a converted magnitude may be printed to.
 *
 * Two rules, in this order, and the order is the whole of "avoid false precision
 * after conversion":
 *
 * 1. **A declared precision wins.** `attribute_definitions.decimal_places` is a
 *    statement by whoever defined the attribute about how precisely it is worth
 *    stating, and it is already what `normalizedFactsAgree` compares at. Display
 *    and comparison disagreeing about precision is how two values that compare
 *    equal render differently.
 * 2. **Otherwise, never exceed the source's SIGNIFICANT digits.** Decimal places
 *    are not preserved by a conversion and significant digits are: a source that
 *    wrote `6.1 in` knows two digits, so the 154.94000000000001 mm the double
 *    carries may be printed as `155`, and printing `154.94` would claim a tenth
 *    of a millimetre nobody measured. This is the rule that makes the difference
 *    between reporting a measurement and inventing one, and it is why the source
 *    string has to reach this function at all.
 */
export function displayDecimals(
  convertedMagnitude: number,
  sourceNumber: string | null,
  declaredDecimals: number | null,
): number {
  if (declaredDecimals !== null) {
    return Math.max(0, Math.min(MAX_DISPLAY_DECIMALS, declaredDecimals));
  }
  if (sourceNumber === null) {
    // Nothing to read a precision off, and no declaration. All that is left is a
    // CEILING on total digits — {@link MAX_DISPLAY_DECIMALS} significant ones —
    // and the trailing zeros of that ceiling are then trimmed by
    // {@link renderMeasurement}, because a zero printed under a precision nobody
    // stated is the false precision this whole function exists to prevent. The
    // ceiling is what stops `154.94000000000001` reaching a page.
    const ceiling = MAX_DISPLAY_DECIMALS - 1 - exponent10(convertedMagnitude);
    return Math.max(0, Math.min(MAX_DISPLAY_DECIMALS, ceiling));
  }
  // "Print exactly the digits the source knew", above and below one alike: a
  // 187 g weight knows three, and in pounds that is `0.412` — three decimals,
  // not three minus the (absent) integer digits. Getting this wrong under one
  // is how a converted small measurement silently loses a digit.
  const available = significantDigits(sourceNumber) - 1 - exponent10(convertedMagnitude);
  return Math.max(0, Math.min(MAX_DISPLAY_DECIMALS, available));
}

/** What a caller knows about one stored measurement. */
export interface MeasurementRendering {
  /** The magnitude as stored, in `baseUnit`. */
  readonly baseMagnitude: number;
  /** The upper bound of a range; the lower one is `baseMagnitude`. */
  readonly baseMagnitudeMax?: number;
  /** The unit it is stored in — a canonical key from `units.ts`. */
  readonly baseUnit: string;
  /** The source's own words, read ONLY for the precision they carried. */
  readonly sourceDisplayValue?: string;
  /** `attribute_definitions.decimal_places`, when the definition declares one. */
  readonly declaredDecimals?: number;
}

/**
 * A rendered measurement, or a stated reason there is none.
 *
 * A STRING discriminant, not a boolean: the backend compiles with
 * `strict: false`, so `if (!result.rendered)` does not narrow a union on a
 * boolean-literal discriminant and the caller is left holding both branches.
 * Measured across this repository more than once.
 */
export type MeasurementDisplay =
  | {
      readonly outcome: 'rendered';
      /** The magnitude in `unit`, rounded to `decimals`. */
      readonly magnitude: number;
      readonly magnitudeMax?: number;
      readonly unit: string;
      readonly decimals: number;
      /** `"155 mm"`, or `"5 – 7 d"` for a range. Units are keys, not copy. */
      readonly text: string;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: 'unknown_unit' | 'not_convertible';
    };

function round(magnitude: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(magnitude * factor) / factor;
}

/**
 * The printed form of a rounded magnitude.
 *
 * `trim` is true ONLY when nothing stated a precision — see the third branch of
 * {@link displayDecimals}. With a DECLARED precision the zeros are the
 * statement (`1199.00`), and with a source's significant digits they carry the
 * claim (`6.10 in` from `155 mm` says three digits were known, where `6.1`
 * would say two).
 */
function formatMagnitude(magnitude: number, decimals: number, trim: boolean): string {
  const fixed = magnitude.toFixed(decimals);
  if (!trim || !fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Render one stored measurement in the shopper's preferred unit.
 *
 * REFUSES rather than falling back to the base unit when the stored unit is not
 * one `units.ts` knows. That is the #94 rule pointed at display: a stored unit
 * nobody recognises is a taxonomy gap, and printing the number beside the base
 * unit would assert a dimension the row never claimed — `14` becoming `14 mm`
 * on one feed and `14 in` on another, with nothing saying so.
 *
 * The returned `text` composes the magnitude with the canonical unit KEY, never
 * a localized unit name: unit names are copy, copy lives in the client's
 * translation bundles under the house i18n rule, and a server that shipped
 * `pulgadas` would be a second place Mercaria's copy lived.
 */
export function renderMeasurement(
  input: MeasurementRendering,
  system: MeasurementSystem,
): MeasurementDisplay {
  const family = unitFamilyOf(input.baseUnit);
  if (family === null) return { outcome: 'refused', reason: 'unknown_unit' };

  const unit = resolveDisplayUnit(family, system);
  const converted = convertUnit(input.baseMagnitude, input.baseUnit, unit);
  if (converted === null) return { outcome: 'refused', reason: 'not_convertible' };

  const sourceNumber =
    input.sourceDisplayValue === undefined ? null : sourceNumberText(input.sourceDisplayValue);
  const declared = input.declaredDecimals ?? null;
  const decimals = displayDecimals(converted, sourceNumber, declared);
  const trim = declared === null && sourceNumber === null;
  const magnitude = round(converted, decimals);

  if (input.baseMagnitudeMax === undefined) {
    return {
      outcome: 'rendered',
      magnitude,
      unit,
      decimals,
      text: `${formatMagnitude(magnitude, decimals, trim)} ${unit}`,
    };
  }

  const convertedMax = convertUnit(input.baseMagnitudeMax, input.baseUnit, unit);
  if (convertedMax === null) return { outcome: 'refused', reason: 'not_convertible' };
  const magnitudeMax = round(convertedMax, decimals);
  return {
    outcome: 'rendered',
    magnitude,
    magnitudeMax,
    unit,
    decimals,
    text:
      `${formatMagnitude(magnitude, decimals, trim)} – ` +
      `${formatMagnitude(magnitudeMax, decimals, trim)} ${unit}`,
  };
}
