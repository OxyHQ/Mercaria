/**
 * Deterministic, reversible unit normalization for canonical attributes
 * (#56 attribute rules 2–4).
 *
 * ## Why the factors are RATIONALS and not decimals
 *
 * "Reversible for display" is a real requirement, not a nicety: a product page
 * shows 6.1 in and a comparison shows 155 mm, and a buyer who converts back must
 * land on the number they started from. Writing the inch factor as the decimal
 * `25.4` makes the round trip `value * 25.4 / 25.4`, which is exact only by
 * luck; writing it as the exact rational 254/10 makes {@link toBaseUnit} and
 * {@link fromBaseUnit} multiply and divide by the SAME two integers in opposite
 * order, which is the property the round-trip test pins across every unit in the
 * table.
 *
 * ## What this module deliberately does not do
 *
 * It never guesses. {@link parseQuantity} returns `null` for anything it cannot
 * read — a comma decimal, a range ("6–7 cm"), a bare number with no unit — and
 * the caller stores the source's own words with a non-`normalized` state rather
 * than inventing a magnitude (#56 attribute rule 4). Unit SPELLINGS are matched
 * against an explicit alias table, so an unrecognised token is `unknown_unit`
 * and not a silently wrong dimension.
 *
 * #94 owns the full attribute/unit TAXONOMY (ADR 0002 D15). This is the
 * mechanism it will extend, and widening it is one edit here plus one to
 * `UNIT_FAMILIES` in shared-types.
 */

import type { UnitFamily } from '@mercaria/shared-types';

/**
 * One unit, as an exact rational multiple of its family's base unit:
 * `magnitude_in_base = magnitude * numerator / denominator`.
 */
export interface UnitDefinition {
  readonly family: UnitFamily;
  readonly numerator: number;
  readonly denominator: number;
}

/** The unit each family's normalized magnitudes are stored in. */
export const BASE_UNITS: Readonly<Record<UnitFamily, string>> = Object.freeze({
  length: 'mm',
  mass: 'g',
  volume: 'ml',
  digital_storage: 'B',
  duration: 's',
  power: 'W',
  energy: 'Wh',
  frequency: 'Hz',
  data_rate: 'bit_s',
  pixel_count: 'px',
  luminance: 'cd_m2',
  electric_charge: 'mAh',
  count: 'count',
  // The three DIMENSIONLESS families (#94 normalization rule 8). Each has
  // exactly one unit, and `convertUnit` refuses conversion across families — so
  // an 85 % screen-to-body ratio, a 16:9 aspect ratio and a 4.5-star rating can
  // never be compared to one another even though all three are bare numbers.
  // That refusal IS what "percentages, ratios and ratings are distinct types"
  // means mechanically; a shared `decimal` type would make it a convention.
  percentage: 'pct',
  ratio: 'ratio',
  rating: 'rating_point',
});

/**
 * The canonical unit table.
 *
 * Keys are the CANONICAL spelling; {@link resolveUnit} matches a source token
 * against {@link UNIT_ALIASES} first. Decimal-prefixed digital storage (kB, MB,
 * GB, TB) is powers of 1000 and the binary prefixes (KiB, MiB, GiB, TiB) are
 * powers of 1024 — stated explicitly because consumer marketing uses the first
 * and operating systems report the second, and silently conflating them makes a
 * 256 GB phone and a 256 GiB phone the same variant when they are not.
 */
export const UNIT_DEFINITIONS: Readonly<Record<string, UnitDefinition>> = Object.freeze({
  // length — base mm
  mm: { family: 'length', numerator: 1, denominator: 1 },
  cm: { family: 'length', numerator: 10, denominator: 1 },
  m: { family: 'length', numerator: 1000, denominator: 1 },
  km: { family: 'length', numerator: 1_000_000, denominator: 1 },
  in: { family: 'length', numerator: 254, denominator: 10 },
  ft: { family: 'length', numerator: 3048, denominator: 10 },
  // mass — base g
  mg: { family: 'mass', numerator: 1, denominator: 1000 },
  g: { family: 'mass', numerator: 1, denominator: 1 },
  kg: { family: 'mass', numerator: 1000, denominator: 1 },
  lb: { family: 'mass', numerator: 45_359_237, denominator: 100_000 },
  oz: { family: 'mass', numerator: 45_359_237, denominator: 1_600_000 },
  // volume — base ml
  ml: { family: 'volume', numerator: 1, denominator: 1 },
  cl: { family: 'volume', numerator: 10, denominator: 1 },
  dl: { family: 'volume', numerator: 100, denominator: 1 },
  l: { family: 'volume', numerator: 1000, denominator: 1 },
  fl_oz: { family: 'volume', numerator: 295_735_295_625, denominator: 10_000_000_000 },
  gal: { family: 'volume', numerator: 3_785_411_784, denominator: 1_000_000 },
  // digital storage — base B
  B: { family: 'digital_storage', numerator: 1, denominator: 1 },
  kB: { family: 'digital_storage', numerator: 1000, denominator: 1 },
  MB: { family: 'digital_storage', numerator: 1_000_000, denominator: 1 },
  GB: { family: 'digital_storage', numerator: 1_000_000_000, denominator: 1 },
  TB: { family: 'digital_storage', numerator: 1_000_000_000_000, denominator: 1 },
  KiB: { family: 'digital_storage', numerator: 1024, denominator: 1 },
  MiB: { family: 'digital_storage', numerator: 1_048_576, denominator: 1 },
  GiB: { family: 'digital_storage', numerator: 1_073_741_824, denominator: 1 },
  TiB: { family: 'digital_storage', numerator: 1_099_511_627_776, denominator: 1 },
  // duration — base s
  ms: { family: 'duration', numerator: 1, denominator: 1000 },
  s: { family: 'duration', numerator: 1, denominator: 1 },
  min: { family: 'duration', numerator: 60, denominator: 1 },
  h: { family: 'duration', numerator: 3600, denominator: 1 },
  d: { family: 'duration', numerator: 86_400, denominator: 1 },
  // power — base W
  mW: { family: 'power', numerator: 1, denominator: 1000 },
  W: { family: 'power', numerator: 1, denominator: 1 },
  kW: { family: 'power', numerator: 1000, denominator: 1 },
  // energy — base Wh
  mWh: { family: 'energy', numerator: 1, denominator: 1000 },
  Wh: { family: 'energy', numerator: 1, denominator: 1 },
  kWh: { family: 'energy', numerator: 1000, denominator: 1 },
  // frequency — base Hz (clock speeds, refresh rates)
  Hz: { family: 'frequency', numerator: 1, denominator: 1 },
  kHz: { family: 'frequency', numerator: 1000, denominator: 1 },
  MHz: { family: 'frequency', numerator: 1_000_000, denominator: 1 },
  GHz: { family: 'frequency', numerator: 1_000_000_000, denominator: 1 },
  // data rate — base bit/s. BITS, not bytes: `Mbps` conventionally means
  // megabits and `MBps` megabytes, and the two differ by 8. Byte-per-second
  // spellings are deliberately absent rather than folded in, so a feed writing
  // them lands on `unknown_unit` instead of an eightfold error.
  bit_s: { family: 'data_rate', numerator: 1, denominator: 1 },
  kbit_s: { family: 'data_rate', numerator: 1000, denominator: 1 },
  Mbit_s: { family: 'data_rate', numerator: 1_000_000, denominator: 1 },
  Gbit_s: { family: 'data_rate', numerator: 1_000_000_000, denominator: 1 },
  // pixel count — base px (sensor resolution)
  px: { family: 'pixel_count', numerator: 1, denominator: 1 },
  MP: { family: 'pixel_count', numerator: 1_000_000, denominator: 1 },
  // luminance — base cd/m² (screen brightness)
  cd_m2: { family: 'luminance', numerator: 1, denominator: 1 },
  // electric charge — base mAh (battery capacity, as consumers see it)
  mAh: { family: 'electric_charge', numerator: 1, denominator: 1 },
  Ah: { family: 'electric_charge', numerator: 1000, denominator: 1 },
  // count — base count
  count: { family: 'count', numerator: 1, denominator: 1 },
  // The dimensionless families. One unit each, on purpose: a second unit would
  // be a second scale, and a scale is what makes a bare number mean something.
  pct: { family: 'percentage', numerator: 1, denominator: 1 },
  ratio: { family: 'ratio', numerator: 1, denominator: 1 },
  rating_point: { family: 'rating', numerator: 1, denominator: 1 },
});

/**
 * CASE-SENSITIVE source spellings.
 *
 * A second table, consulted before the case-folding one, for the spellings whose
 * case IS their meaning. `Mbps` is megabits per second and `MBps` is megabytes
 * per second; folding either to a common key would make one of them an eightfold
 * lie. Every entry here is matched verbatim, so a lower-cased variant of it
 * still falls through to {@link UNIT_ALIASES} and, finding nothing, becomes
 * `unknown_unit`.
 */
const UNIT_ALIASES_EXACT: Readonly<Record<string, string>> = Object.freeze({
  Mbps: 'Mbit_s',
  Gbps: 'Gbit_s',
  Kbps: 'kbit_s',
  kbps: 'kbit_s',
  Mbit: 'Mbit_s',
  Gbit: 'Gbit_s',
  MPx: 'MP',
  Megapixel: 'MP',
  Megapixels: 'MP',
});

/**
 * Source spellings, folded to lowercase, mapped to a canonical unit key.
 *
 * An EXPLICIT table rather than a blanket case-insensitive lookup, because case
 * is load-bearing in two of these families: `mW` and `MW` differ by a factor of
 * a million, and `b` (bit) is not `B` (byte).
 *
 * That is also why several obvious-looking aliases are deliberately ABSENT —
 * `mw`, `mwh`, a bare `b`, `mhz`, and every byte-per-second spelling. Each folds
 * two real units onto one key, so admitting it would let a megawatt be stored as
 * a milliwatt, a megahertz as a millihertz and a bitrate as a byte count,
 * silently and by factors of 10⁹, 10⁹ and 8 respectively. Their unambiguous
 * spellings (`mW`, `mWh`, `byte`, `MHz`, `megahertz`, `Mbps`) still resolve —
 * through the exact-match path in {@link resolveUnit} or through
 * {@link UNIT_ALIASES_EXACT} — so nothing legitimate is lost; a genuinely
 * ambiguous token becomes `unknown_unit`, which is a taxonomy gap somebody can
 * see rather than a wrong number nobody can.
 *
 * Every other entry here is a spelling somebody actually writes; anything absent
 * is `unknown_unit`, never a guess.
 */
const UNIT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  mm: 'mm',
  millimeter: 'mm',
  millimetre: 'mm',
  millimeters: 'mm',
  millimetres: 'mm',
  cm: 'cm',
  centimeter: 'cm',
  centimetre: 'cm',
  centimeters: 'cm',
  centimetres: 'cm',
  m: 'm',
  meter: 'm',
  metre: 'm',
  meters: 'm',
  metres: 'm',
  km: 'km',
  kilometer: 'km',
  kilometre: 'km',
  in: 'in',
  inch: 'in',
  inches: 'in',
  '"': 'in',
  ft: 'ft',
  foot: 'ft',
  feet: 'ft',
  mg: 'mg',
  milligram: 'mg',
  g: 'g',
  gram: 'g',
  grams: 'g',
  gramme: 'g',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  ml: 'ml',
  milliliter: 'ml',
  millilitre: 'ml',
  cl: 'cl',
  dl: 'dl',
  l: 'l',
  liter: 'l',
  litre: 'l',
  liters: 'l',
  litres: 'l',
  floz: 'fl_oz',
  fl_oz: 'fl_oz',
  'fl oz': 'fl_oz',
  gal: 'gal',
  gallon: 'gal',
  gallons: 'gal',
  byte: 'B',
  bytes: 'B',
  kb: 'kB',
  kilobyte: 'kB',
  mb: 'MB',
  megabyte: 'MB',
  gb: 'GB',
  gigabyte: 'GB',
  gigabytes: 'GB',
  tb: 'TB',
  terabyte: 'TB',
  kib: 'KiB',
  mib: 'MiB',
  gib: 'GiB',
  tib: 'TiB',
  ms: 'ms',
  millisecond: 'ms',
  s: 's',
  sec: 's',
  second: 's',
  seconds: 's',
  min: 'min',
  minute: 'min',
  minutes: 'min',
  h: 'h',
  hr: 'h',
  hour: 'h',
  hours: 'h',
  d: 'd',
  day: 'd',
  days: 'd',
  w: 'W',
  watt: 'W',
  watts: 'W',
  kw: 'kW',
  kilowatt: 'kW',
  wh: 'Wh',
  kwh: 'kWh',
  count: 'count',
  pcs: 'count',
  piece: 'count',
  pieces: 'count',
  units: 'count',
  hz: 'Hz',
  hertz: 'Hz',
  khz: 'kHz',
  kilohertz: 'kHz',
  megahertz: 'MHz',
  gigahertz: 'GHz',
  ghz: 'GHz',
  megapixel: 'MP',
  megapixels: 'MP',
  nit: 'cd_m2',
  nits: 'cd_m2',
  'cd/m2': 'cd_m2',
  'cd/m²': 'cd_m2',
  mah: 'mAh',
  milliamp_hour: 'mAh',
  ah: 'Ah',
  '%': 'pct',
  pct: 'pct',
  percent: 'pct',
  percentage: 'pct',
  ratio: 'ratio',
  star: 'rating_point',
  stars: 'rating_point',
  rating_point: 'rating_point',
});

/**
 * Resolve a source unit token to its canonical key.
 *
 * @returns The canonical unit key, or `null` when the token is not one this
 *   table knows — which the caller records as `unknown_unit`, keeping the
 *   source's words rather than picking a plausible dimension.
 */
export function resolveUnit(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  if (Object.prototype.hasOwnProperty.call(UNIT_DEFINITIONS, trimmed)) return trimmed;
  // Case-SENSITIVE aliases first: the spellings whose case is their meaning must
  // be resolved before anything folds them.
  const exact = UNIT_ALIASES_EXACT[trimmed];
  if (exact !== undefined) return exact;
  const alias = UNIT_ALIASES[trimmed.toLowerCase()];
  return alias ?? null;
}

/** The family a canonical unit measures, or `null` for an unknown unit. */
export function unitFamilyOf(unit: string): UnitFamily | null {
  return UNIT_DEFINITIONS[unit]?.family ?? null;
}

/**
 * Convert a magnitude into its family's base unit.
 *
 * @returns The base-unit magnitude, or `null` when the unit is unknown.
 */
export function toBaseUnit(magnitude: number, unit: string): number | null {
  const definition = UNIT_DEFINITIONS[unit];
  if (!definition) return null;
  return (magnitude * definition.numerator) / definition.denominator;
}

/**
 * Convert a base-unit magnitude back into `unit` — the display direction.
 *
 * The inverse of {@link toBaseUnit} by construction: the same two integers, in
 * the opposite order.
 *
 * @returns The magnitude in `unit`, or `null` when the unit is unknown.
 */
export function fromBaseUnit(baseMagnitude: number, unit: string): number | null {
  const definition = UNIT_DEFINITIONS[unit];
  if (!definition) return null;
  return (baseMagnitude * definition.denominator) / definition.numerator;
}

/**
 * Convert between two units of the SAME family.
 *
 * @returns The converted magnitude, or `null` when either unit is unknown or
 *   the two measure different dimensions — a cross-family conversion is not a
 *   rounding question, it is a category error, and answering it would be the
 *   guess this module refuses to make.
 */
export function convertUnit(magnitude: number, from: string, to: string): number | null {
  const source = UNIT_DEFINITIONS[from];
  const target = UNIT_DEFINITIONS[to];
  if (!source || !target || source.family !== target.family) return null;
  const base = toBaseUnit(magnitude, from);
  if (base === null) return null;
  return fromBaseUnit(base, to);
}

/** A magnitude and the unit a source expressed it in. */
export interface ParsedQuantity {
  readonly magnitude: number;
  /** The canonical unit key, resolved from the source's spelling. */
  readonly unit: string;
  readonly family: UnitFamily;
}

/**
 * `^` a number, `$` a unit token — nothing in between but optional whitespace.
 *
 * Deliberately anchored and deliberately narrow. "6.1 in", "256GB", "85 %",
 * "2.4 GHz", "1200 cd/m2" and `6.1"` parse; "6–7 cm", "approx 6 cm", "6,1 cm"
 * and "6 cm x 3 cm" do not, and each of those is a value whose meaning a guess
 * would get wrong. (A RANGE is not unreadable, it is a different shape — see
 * {@link RANGE_PATTERN}, which reads it as one value with two bounds rather than
 * inventing a single magnitude from it.)
 *
 * The unit token admits digits, `%`, `/` and `²` after its first character so
 * `cd/m2`, `cd/m²`, `bit_s` and `%` are expressible; it still may not START with
 * one, which is what keeps "6 x 3" from parsing as a magnitude and a unit.
 */
const QUANTITY_PATTERN = /^(-?\d+(?:\.\d+)?)\s*([A-Za-z_%][A-Za-z0-9_%/²]*|")$/u;

/**
 * A closed interval and its two bounds — "5-7 days", "0 – 35 °C", "5 to 7 days".
 *
 * Separate from {@link QUANTITY_PATTERN} because a range is a first-class value
 * with inclusive/exclusive semantics (#94 normalization rule 6), not a quantity
 * that failed to parse. Only the INCLUSIVE spellings are recognised: a hyphen
 * between two numbers means "from … to …" in every catalogue that writes one,
 * and there is no widely-written spelling for an exclusive bound. An exclusive
 * bound therefore arrives only through the structured API, never from prose,
 * which is the honest reading — inferring strictness from punctuation would be
 * exactly the guess this module refuses.
 */
const RANGE_PATTERN =
  /^(-?\d+(?:\.\d+)?)\s*(?:-|–|—|to|\.\.\.|\.\.)\s*(-?\d+(?:\.\d+)?)\s*([A-Za-z_%][A-Za-z0-9_%/²]*|")?$/u;

/**
 * How many decimal places a source's own number carried.
 *
 * The input to "preserve measurement precision and avoid false precision after
 * conversion" (#94 normalization rule 3): a source that wrote `6.1 in` knows one
 * decimal place, and rendering the converted 154.94 mm as `154.9` rather than
 * `154.94000000000001` is the difference between reporting what is known and
 * inventing two digits nobody measured. The magnitude STORED is always the full
 * converted value — this governs comparison and display, never storage, because
 * truncating on write would make the round trip lossy in the other direction.
 */
export function sourceDecimalPlaces(numberText: string): number {
  const dot = numberText.indexOf('.');
  return dot === -1 ? 0 : numberText.length - dot - 1;
}

/**
 * Round to `places` decimals, half away from zero.
 *
 * Deliberately NOT the pricing engine's half-even: this is a display and
 * comparison rounding over physical magnitudes, where the bias half-even exists
 * to remove (accumulating a sum of many rounded parts) does not arise — nothing
 * sums attribute magnitudes. Using the money rule here would suggest these
 * numbers reconcile against a total, and they do not.
 */
export function roundToDecimals(value: number, places: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** Math.max(0, Math.min(12, Math.trunc(places)));
  return Math.sign(value) * Math.round(Math.abs(value) * factor) / factor;
}

/**
 * Read a source display string as a quantity.
 *
 * @returns The parsed quantity, or `null` when the string is not a single
 *   magnitude with a unit this module knows. A `null` is a source fact the
 *   caller stores unparsed, never an error and never a default.
 */
export function parseQuantity(display: string): ParsedQuantity | null {
  const match = QUANTITY_PATTERN.exec(display.trim());
  if (!match) return null;
  const [, rawNumber, rawUnit] = match;
  if (rawNumber === undefined || rawUnit === undefined) return null;

  const magnitude = Number(rawNumber);
  if (!Number.isFinite(magnitude)) return null;

  const unit = resolveUnit(rawUnit);
  if (unit === null) return null;
  const family = unitFamilyOf(unit);
  if (family === null) return null;

  return { magnitude, unit, family };
}

/**
 * The normalization of one source display string, in the shape
 * `canonical_variant_attributes` and `canonical_attribute_values` store.
 *
 * `state` is what the CHECK constraints on both tables read: only `normalized`
 * may carry a magnitude at all, so an unreadable value keeps the source's words
 * and nothing else.
 */
export interface NormalizedQuantity {
  readonly state: 'normalized' | 'unknown_unit' | 'unparsed';
  readonly baseMagnitude?: number;
  readonly baseUnit?: string;
  readonly sourceUnit?: string;
  /** The magnitude the source wrote, before conversion. */
  readonly sourceMagnitude?: number;
  /** Decimal places the source's own number carried. See {@link sourceDecimalPlaces}. */
  readonly sourceDecimals?: number;
}

/**
 * Normalize a display string into its family's base unit.
 *
 * The three outcomes are distinguishable on purpose: `unknown_unit` says a
 * number and a unit token were found and the token is not in the table (a
 * taxonomy gap #94 can close), while `unparsed` says the string is not a
 * quantity at all (a value that belongs in `normalized_text`, or nowhere).
 * Collapsing them would hide which of the two a catalogue actually has.
 */
export function normalizeQuantity(display: string): NormalizedQuantity {
  const trimmed = display.trim();
  const shaped = QUANTITY_PATTERN.exec(trimmed);
  if (!shaped) return { state: 'unparsed' };

  const parsed = parseQuantity(trimmed);
  if (!parsed) return { state: 'unknown_unit' };

  const baseUnit = BASE_UNITS[parsed.family];
  const baseMagnitude = toBaseUnit(parsed.magnitude, parsed.unit);
  if (baseMagnitude === null) return { state: 'unknown_unit' };

  const rawNumber = shaped[1] ?? '';
  return {
    state: 'normalized',
    baseMagnitude,
    baseUnit,
    sourceUnit: parsed.unit,
    sourceMagnitude: parsed.magnitude,
    sourceDecimals: sourceDecimalPlaces(rawNumber),
  };
}

/** A range and the unit both of its bounds are expressed in. */
export interface ParsedRange {
  readonly lower: number;
  readonly upper: number;
  /** Absent when the source wrote a bare interval ("5-7") with no unit token. */
  readonly unit?: string;
  readonly family?: UnitFamily;
  readonly sourceDecimals: number;
}

/**
 * Read a source display string as a RANGE (#94 normalization rule 6).
 *
 * Deliberately a separate entry point from {@link normalizeQuantity}, which
 * still refuses "6–7 cm" as `unparsed`. That refusal is correct for a
 * `single`-cardinality attribute — a range is not one magnitude, and picking
 * either end or their midpoint is the invention this module exists to prevent.
 * A `range`-cardinality attribute calls THIS, and gets both bounds.
 *
 * A range whose bounds are inverted ("7-5 days") is refused rather than
 * reordered: the two readings — a typo, or a descending convention — are not
 * distinguishable from the string, and silently swapping them would make a
 * "5 days or less" constraint match a product that takes seven.
 *
 * @returns The parsed range, or `null` when the string is not one.
 */
export function parseRange(display: string): ParsedRange | null {
  const match = RANGE_PATTERN.exec(display.trim());
  if (!match) return null;
  const [, rawLower, rawUpper, rawUnit] = match;
  if (rawLower === undefined || rawUpper === undefined) return null;

  const lower = Number(rawLower);
  const upper = Number(rawUpper);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) return null;

  const sourceDecimals = Math.max(sourceDecimalPlaces(rawLower), sourceDecimalPlaces(rawUpper));
  if (rawUnit === undefined) return { lower, upper, sourceDecimals };

  const unit = resolveUnit(rawUnit);
  if (unit === null) return null;
  const family = unitFamilyOf(unit);
  if (family === null) return null;
  return { lower, upper, unit, family, sourceDecimals };
}

/** The base-unit normalization of a range, in the shape the value columns store. */
export interface NormalizedRange {
  readonly state: 'normalized' | 'unknown_unit' | 'unparsed';
  readonly baseLower?: number;
  readonly baseUpper?: number;
  readonly baseUnit?: string;
  readonly sourceUnit?: string;
  readonly sourceDecimals?: number;
}

/** Normalize a range into its family's base unit. See {@link parseRange}. */
export function normalizeRange(display: string): NormalizedRange {
  const shaped = RANGE_PATTERN.exec(display.trim());
  if (!shaped) return { state: 'unparsed' };

  const parsed = parseRange(display);
  // A shaped string that will not parse is either an inverted interval or an
  // unreadable unit; both keep the source's words and neither invents a bound.
  if (!parsed) return { state: 'unknown_unit' };
  if (parsed.unit === undefined || parsed.family === undefined) {
    // A bare interval with no unit. Dimensionless by construction, so it
    // normalizes as a plain count of whatever the definition declares.
    return { state: 'normalized', baseLower: parsed.lower, baseUpper: parsed.upper, sourceDecimals: parsed.sourceDecimals };
  }

  const baseUnit = BASE_UNITS[parsed.family];
  const baseLower = toBaseUnit(parsed.lower, parsed.unit);
  const baseUpper = toBaseUnit(parsed.upper, parsed.unit);
  if (baseLower === null || baseUpper === null) return { state: 'unknown_unit' };

  return {
    state: 'normalized',
    baseLower,
    baseUpper,
    baseUnit,
    sourceUnit: parsed.unit,
    sourceDecimals: parsed.sourceDecimals,
  };
}
