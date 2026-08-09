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
  count: 'count',
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
  // count — base count
  count: { family: 'count', numerator: 1, denominator: 1 },
});

/**
 * Source spellings, folded to lowercase, mapped to a canonical unit key.
 *
 * An EXPLICIT table rather than a blanket case-insensitive lookup, because case
 * is load-bearing in two of these families: `mW` and `MW` differ by a factor of
 * a million, and `b` (bit) is not `B` (byte).
 *
 * That is also why three obvious-looking aliases are deliberately ABSENT — `mw`,
 * `mwh` and a bare `b`. Each folds two real units onto one key, so admitting it
 * would let a megawatt be stored as a milliwatt and a bitrate as a byte count,
 * silently and by a factor of 10⁹ and 8 respectively. Their unambiguous
 * spellings (`mW`, `mWh`, `byte`) still resolve through the exact-match path in
 * {@link resolveUnit}, so nothing legitimate is lost; a genuinely ambiguous
 * token becomes `unknown_unit`, which is a taxonomy gap somebody can see rather
 * than a wrong number nobody can.
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
 * Deliberately anchored and deliberately narrow. "6.1 in", "256GB" and
 * `6.1"` parse; "6–7 cm", "approx 6 cm", "6,1 cm" and "6 cm x 3 cm" do not, and
 * each of those is a value whose meaning a guess would get wrong.
 */
const QUANTITY_PATTERN = /^(-?\d+(?:\.\d+)?)\s*([A-Za-z_]+|")$/u;

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

  return { state: 'normalized', baseMagnitude, baseUnit, sourceUnit: parsed.unit };
}
