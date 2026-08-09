/**
 * Typed value normalization against a definition version
 * (#94 unit-and-value normalization, rules 1–10).
 *
 * One source string in, one or more typed FACTS out — several when the
 * definition's cardinality says so: a `set` of ports is one fact per port, a
 * `structured` dimensions reading is one fact per axis. Each fact carries the
 * source's own words, the unit the source used, and either a normalized value or
 * a stated reason there is none.
 *
 * ## The invariant every branch below obeys
 *
 * A refusal is a first-class outcome. There is no path in this module that
 * returns a magnitude the source did not express — no midpoint of a range, no
 * unit inferred from a bare number, no coercion of "about 3" to 3, no rounding
 * of an integer attribute's `8.5` down to 8. When the module cannot read a
 * value, it says which of five ways it failed and keeps the source's words. That
 * is what makes "unsupported or malformed values remain source facts and do not
 * become canonical constraints" (rule 10) a property of the code rather than a
 * habit.
 *
 * ## Where a unit is allowed to come from, and where it is not
 *
 * Exactly two places: the source's own token ("256 GB"), or a recorded
 * per-source mapping's `assumed_unit`, which is a human statement about the FEED
 * ("this supplier's `weight` column is in grams"). Never from the attribute's
 * base unit, never from what a sibling value used, never from the magnitude's
 * size. A bare number with no mapping is `unparsed` — visible, and fixable by
 * recording the mapping (rule 2).
 */

import {
  CURRENCY_PRECISION,
  MAX_MONEY_MINOR_UNITS,
  NORMALIZATION_RULE_VERSION,
  type AttributeComponentAxis,
  type AttributeNormalizationState,
  type CurrencyCode,
} from '@mercaria/shared-types';
import {
  BASE_UNITS,
  normalizeQuantity,
  normalizeRange,
  resolveUnit,
  toBaseUnit,
  unitFamilyOf,
} from '../canonical/units.js';
import { normalizeOptionValue } from '../canonical/variant-signature.js';
import { isMarketingClaim } from './marketing-claims.js';
import type { ResolvedAttributeDefinition } from './definition-registry.service.js';

/** One normalized fact, in the shape `canonical_attribute_values` stores. */
export interface NormalizedAttributeFact {
  readonly normalizationState: AttributeNormalizationState;
  /** The source's own words for THIS fact — one component of a structured value. */
  readonly sourceDisplayValue: string;
  readonly sourceUnit?: string;
  readonly normalizedText?: string;
  readonly normalizedNumber?: number;
  readonly normalizedNumberMax?: number;
  readonly rangeLowerInclusive?: boolean;
  readonly rangeUpperInclusive?: boolean;
  readonly normalizedUnit?: string;
  readonly normalizedBoolean?: boolean;
  readonly normalizedDate?: Date;
  readonly normalizedAmountMinor?: number;
  readonly normalizedCurrency?: CurrencyCode;
  readonly componentAxis?: AttributeComponentAxis;
  readonly position: number;
  /** Decimal places the source's own number carried — the precision floor. */
  readonly sourceDecimals?: number;
}

export interface NormalizeAttributeInput {
  readonly displayValue: string;
  readonly definition?: ResolvedAttributeDefinition;
  /**
   * The unit a per-source mapping declares for this field. The ONLY legitimate
   * origin of a unit the source did not write. See the module header.
   */
  readonly assumedUnit?: string;
  /** The axis a per-source mapping declares this field always carries. */
  readonly assumedAxis?: AttributeComponentAxis;
}

/** The ruleset version every fact this module produces was written under. */
export const RULE_VERSION = NORMALIZATION_RULE_VERSION;

/**
 * Normalize one source observation into one or more typed facts.
 *
 * With NO definition the value is folded text at position 0 — the honest
 * reading, since nothing has declared what the attribute measures. A source may
 * legitimately name an attribute nobody has defined yet, and refusing it would
 * lose the observation entirely; recording it as text keeps it available for the
 * moment somebody defines the key.
 */
export function normalizeAttributeObservation(
  input: NormalizeAttributeInput,
): NormalizedAttributeFact[] {
  const trimmed = input.displayValue.trim();
  if (trimmed.length === 0) {
    return [{ normalizationState: 'unparsed', sourceDisplayValue: input.displayValue, position: 0 }];
  }
  if (!input.definition) {
    return [
      {
        normalizationState: 'normalized',
        sourceDisplayValue: trimmed,
        normalizedText: normalizeOptionValue(trimmed),
        position: 0,
      },
    ];
  }

  const { row } = input.definition;
  // A `structured` value is split by its declared AXES, whatever its
  // cardinality says. The two are describing different things: the axes are
  // what the components MEAN, and the cardinality only records that they are
  // ordered. Letting cardinality win here would send "155.6 x 71.5 x 8.25 mm"
  // through the comma splitter, which finds one value and loses every axis.
  if (row.valueType === 'structured') return normalizeStructured(trimmed, input);

  switch (row.cardinality) {
    case 'range':
      return [normalizeRangeValue(trimmed, input)];
    case 'set':
    case 'ordered_list':
      return splitMultiValue(trimmed).map((part, index) =>
        withPosition(normalizeScalar(part, input), index),
      );
    case 'single':
      return [normalizeScalar(trimmed, input)];
  }
}

/**
 * Split a multi-valued source string.
 *
 * Commas, semicolons and pipes only — deliberately NOT whitespace, because
 * "USB-C 3.2" is one value and " / " appears inside real values ("A/B"). An
 * unsplittable string is one value, which is the honest reading of a source that
 * wrote one.
 */
function splitMultiValue(display: string): string[] {
  const parts = display
    .split(/[,;|]/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 0 ? [display] : parts;
}

function withPosition(
  fact: NormalizedAttributeFact,
  position: number,
): NormalizedAttributeFact {
  return { ...fact, position };
}

/**
 * A `structured` value — several magnitudes, each named by an axis.
 *
 * The axis comes from the DEFINITION's declared order, matched positionally
 * against the components the source wrote, and only when the counts agree
 * exactly. A source that wrote two numbers for a three-axis attribute produces
 * three `unparsed` facts rather than a guess about which axis it omitted: "155.6
 * x 71.5" could be width×height or width×depth, and the two are different
 * products.
 */
function normalizeStructured(
  display: string,
  input: NormalizeAttributeInput,
): NormalizedAttributeFact[] {
  const definition = input.definition;
  if (!definition) return [{ normalizationState: 'unparsed', sourceDisplayValue: display, position: 0 }];
  const axes = definition.row.componentAxes;

  const parts = display
    .split(/\s*[x×*]\s*/iu)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length !== axes.length) {
    return axes.map((axis, index) => ({
      normalizationState: 'unparsed' as const,
      sourceDisplayValue: display,
      componentAxis: axis as AttributeComponentAxis,
      position: index,
    }));
  }

  // "155.6 x 71.5 x 8.25 mm" writes the unit once, on the last component. A
  // trailing unit therefore applies to every component that has none of its own
  // — which is a reading of the SOURCE's convention, not an inference from the
  // numbers: it is only taken when the last component actually carries a unit.
  const trailingUnit = unitOf(parts[parts.length - 1] ?? '');

  return parts.map((part, index) => {
    const axis = axes[index] as AttributeComponentAxis;
    const withUnit = unitOf(part) === undefined && trailingUnit !== undefined
      ? `${part} ${trailingUnit}`
      : part;
    const fact = normalizeScalar(withUnit, { ...input, displayValue: withUnit });
    return { ...fact, sourceDisplayValue: part, componentAxis: axis, position: index };
  });
}

/** The unit token at the end of a component, when it has one. */
function unitOf(part: string): string | undefined {
  const match = /^-?\d+(?:\.\d+)?\s*([A-Za-z_%][A-Za-z0-9_%/²]*|")$/u.exec(part.trim());
  const token = match?.[1];
  if (token === undefined) return undefined;
  return resolveUnit(token) === null ? undefined : token;
}

/** A `range`-cardinality value: two bounds and their strictness. */
function normalizeRangeValue(
  display: string,
  input: NormalizeAttributeInput,
): NormalizedAttributeFact {
  const definition = input.definition;
  const base: NormalizedAttributeFact = {
    normalizationState: 'unparsed',
    sourceDisplayValue: display,
    position: 0,
  };
  if (!definition) return base;

  const parsed = normalizeRange(display);
  if (parsed.state !== 'normalized') return { ...base, normalizationState: parsed.state };
  if (parsed.baseLower === undefined || parsed.baseUpper === undefined) return base;

  // A measurement range must land in the declared family; a range on a
  // non-measurement attribute is dimensionless and stores bare numbers.
  if (definition.row.valueType === 'measurement') {
    const expected = definition.row.baseUnit;
    if (expected === null) return base;
    const actual = parsed.baseUnit ?? applyAssumedUnitFamily(input.assumedUnit);
    if (actual !== expected) return { ...base, normalizationState: 'unknown_unit' };
  }

  const range = applyBounds(definition, parsed.baseLower, display, 0);
  if (range.normalizationState !== 'normalized') return range;

  return {
    normalizationState: 'normalized',
    sourceDisplayValue: display,
    normalizedNumber: parsed.baseLower,
    normalizedNumberMax: parsed.baseUpper,
    // Prose ranges are inclusive at both ends. See `RANGE_PATTERN`'s doc for why
    // an exclusive bound can only arrive through the structured API.
    rangeLowerInclusive: true,
    rangeUpperInclusive: true,
    ...(parsed.baseUnit === undefined ? {} : { normalizedUnit: parsed.baseUnit }),
    ...(parsed.sourceUnit === undefined ? {} : { sourceUnit: parsed.sourceUnit }),
    ...(parsed.sourceDecimals === undefined ? {} : { sourceDecimals: parsed.sourceDecimals }),
    position: 0,
  };
}

/** One scalar value of the definition's declared type. */
function normalizeScalar(
  display: string,
  input: NormalizeAttributeInput,
): NormalizedAttributeFact {
  const definition = input.definition;
  const unread: NormalizedAttributeFact = {
    normalizationState: 'unparsed',
    sourceDisplayValue: display,
    position: 0,
  };
  if (!definition) {
    return {
      normalizationState: 'normalized',
      sourceDisplayValue: display,
      normalizedText: normalizeOptionValue(display),
      position: 0,
    };
  }

  switch (definition.row.valueType) {
    case 'boolean':
      return normalizeBoolean(display);
    case 'integer':
      return normalizeInteger(display, definition);
    case 'decimal':
      return normalizeDecimal(display, definition);
    case 'string':
      return normalizeString(display, definition);
    case 'enum':
      return normalizeEnum(display, definition);
    case 'date':
      return normalizeDate(display);
    case 'money':
      return normalizeMoney(display, definition);
    case 'measurement':
      return normalizeMeasurement(display, definition, input.assumedUnit);
    case 'structured':
      // A structured value reaching the scalar path is a component of one; it is
      // normalized as a measurement against the same declared family.
      return normalizeMeasurement(display, definition, input.assumedUnit);
    default:
      return unread;
  }
}

/**
 * A boolean, from the spellings sources actually write.
 *
 * The comparison is on the FOLDED string against a closed set, which is what
 * makes it strict: `"1"` is true and `1.0`, `"y "`, `"si"` and `"available"` are
 * all `unparsed`. A looser reading (anything truthy in JavaScript) would make
 * the string `"false"` a true value, which is exactly the shape that survives
 * every fixture written with real booleans.
 */
function normalizeBoolean(display: string): NormalizedAttributeFact {
  const folded = display.trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'on'].includes(folded)) {
    return {
      normalizationState: 'normalized',
      sourceDisplayValue: display,
      normalizedBoolean: true,
      position: 0,
    };
  }
  if (['false', 'no', 'n', '0', 'off'].includes(folded)) {
    return {
      normalizationState: 'normalized',
      sourceDisplayValue: display,
      normalizedBoolean: false,
      position: 0,
    };
  }
  return { normalizationState: 'unparsed', sourceDisplayValue: display, position: 0 };
}

function normalizeInteger(
  display: string,
  definition: ResolvedAttributeDefinition,
): NormalizedAttributeFact {
  const trimmed = display.trim();
  // Deliberately refusing `8.0`: an integer attribute that accepts a decimal
  // spelling has to decide what to do with `8.5`, and every answer to that is a
  // silent alteration of what the source said.
  if (!/^-?\d+$/u.test(trimmed)) {
    return { normalizationState: 'unparsed', sourceDisplayValue: display, position: 0 };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    return { normalizationState: 'out_of_range', sourceDisplayValue: display, position: 0 };
  }
  const bounded = applyBounds(definition, value, display, 0);
  if (bounded.normalizationState !== 'normalized') return bounded;
  return {
    normalizationState: 'normalized',
    sourceDisplayValue: display,
    normalizedNumber: value,
    position: 0,
    sourceDecimals: 0,
  };
}

function normalizeDecimal(
  display: string,
  definition: ResolvedAttributeDefinition,
): NormalizedAttributeFact {
  const trimmed = display.trim();
  if (!/^-?\d+(?:\.\d+)?$/u.test(trimmed)) {
    return { normalizationState: 'unparsed', sourceDisplayValue: display, position: 0 };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { normalizationState: 'unparsed', sourceDisplayValue: display, position: 0 };
  }
  const bounded = applyBounds(definition, value, display, 0);
  if (bounded.normalizationState !== 'normalized') return bounded;
  const dot = trimmed.indexOf('.');
  return {
    normalizationState: 'normalized',
    sourceDisplayValue: display,
    normalizedNumber: value,
    position: 0,
    sourceDecimals: dot === -1 ? 0 : trimmed.length - dot - 1,
  };
}

/**
 * A free-text value — and the marketing-claim refusal.
 *
 * Applied only to an `objective` definition, for the reason
 * `marketing-claims.ts` states at length: a `subjective` definition is allowed
 * to contain adjectives, because that is what it is for.
 */
function normalizeString(
  display: string,
  definition: ResolvedAttributeDefinition,
): NormalizedAttributeFact {
  const trimmed = display.trim();
  const maxLength = definition.row.maxLength;
  if (maxLength !== null && trimmed.length > maxLength) {
    return { normalizationState: 'out_of_range', sourceDisplayValue: display, position: 0 };
  }
  if (definition.row.objectivity === 'objective' && isMarketingClaim(trimmed)) {
    return { normalizationState: 'marketing_claim', sourceDisplayValue: display, position: 0 };
  }
  return {
    normalizationState: 'normalized',
    sourceDisplayValue: display,
    normalizedText: normalizeOptionValue(trimmed),
    position: 0,
  };
}

/**
 * An enum value, through the alias table.
 *
 * The source's own text is preserved in `sourceDisplayValue` whatever happens,
 * which is the whole of "normalize common enum aliases while retaining source
 * text" (rule 4). A spelling with no alias row is `unparsed` rather than stored
 * as text: an enum's value set is the definition's promise about what the values
 * ARE, and an unmapped spelling is a gap somebody can close by adding the alias.
 */
function normalizeEnum(
  display: string,
  definition: ResolvedAttributeDefinition,
): NormalizedAttributeFact {
  const folded = normalizeOptionValue(display);
  const canonical = definition.aliases.get(folded);
  if (canonical === undefined) {
    return { normalizationState: 'unparsed', sourceDisplayValue: display, position: 0 };
  }
  return {
    normalizationState: 'normalized',
    sourceDisplayValue: display,
    normalizedText: canonical,
    position: 0,
  };
}

/**
 * An ISO-8601 date.
 *
 * Only the ISO spellings, deliberately: `03/04/2026` is the fourth of March in
 * one country and the third of April in another, and `Date.parse` will happily
 * pick one. A locale-ambiguous date is `unparsed`.
 */
function normalizeDate(display: string): NormalizedAttributeFact {
  const trimmed = display.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u.test(trimmed)) {
    return { normalizationState: 'unparsed', sourceDisplayValue: display, position: 0 };
  }
  const parsed = new Date(trimmed.length === 10 ? `${trimmed}T00:00:00.000Z` : trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return { normalizationState: 'unparsed', sourceDisplayValue: display, position: 0 };
  }
  return {
    normalizationState: 'normalized',
    sourceDisplayValue: display,
    normalizedDate: parsed,
    position: 0,
  };
}

/**
 * A money value, in the definition's ONE currency.
 *
 * The amount is converted to minor units through `CURRENCY_PRECISION` — the same
 * table every price in Mercaria uses — so an attribute's amount is comparable
 * with a `Money` and is never a bare decimal (rule 9). A source naming a
 * DIFFERENT currency is `unparsed`, never converted: an FX conversion at
 * normalization time would freeze a rate into a specification, and a
 * specification does not have a rate.
 */
function normalizeMoney(
  display: string,
  definition: ResolvedAttributeDefinition,
): NormalizedAttributeFact {
  const currency = definition.row.currency;
  if (currency === null) {
    return { normalizationState: 'unparsed', sourceDisplayValue: display, position: 0 };
  }
  const match = /^(-?\d+(?:\.\d+)?)\s*([A-Za-z]{3,4})?$/u.exec(display.trim());
  const rawAmount = match?.[1];
  if (rawAmount === undefined) {
    return { normalizationState: 'unparsed', sourceDisplayValue: display, position: 0 };
  }
  const declared = match?.[2];
  if (declared !== undefined && declared.toUpperCase() !== currency) {
    return { normalizationState: 'unparsed', sourceDisplayValue: display, position: 0 };
  }

  const precision = CURRENCY_PRECISION[currency];
  const minor = Math.round(Number(rawAmount) * 10 ** precision);
  if (!Number.isFinite(minor) || Math.abs(minor) > MAX_MONEY_MINOR_UNITS) {
    return { normalizationState: 'out_of_range', sourceDisplayValue: display, position: 0 };
  }
  return {
    normalizationState: 'normalized',
    sourceDisplayValue: display,
    normalizedAmountMinor: minor,
    normalizedCurrency: currency,
    position: 0,
  };
}

/**
 * A measurement, converted into the definition's declared base unit.
 *
 * Four distinguishable failures, and the distinction is what makes the catalogue
 * fixable:
 *
 * - `unparsed` — not a magnitude at all, OR a bare number with no unit and no
 *   recorded per-source mapping. The latter is rule 2 made mechanical.
 * - `unknown_unit` — a unit token the table does not know, or one from the WRONG
 *   FAMILY. 6 kg is not a screen size, and storing it would compare against
 *   millimetres.
 * - `out_of_range` — outside the definition's declared bounds.
 * - `implausible` — inside them, but past the scale-error threshold.
 */
function normalizeMeasurement(
  display: string,
  definition: ResolvedAttributeDefinition,
  assumedUnit?: string,
): NormalizedAttributeFact {
  const expectedBase = definition.row.baseUnit;
  if (expectedBase === null) {
    return { normalizationState: 'unparsed', sourceDisplayValue: display, position: 0 };
  }

  const quantity = normalizeQuantity(display);
  if (quantity.state === 'normalized') {
    if (quantity.baseMagnitude === undefined || quantity.baseUnit !== expectedBase) {
      return { normalizationState: 'unknown_unit', sourceDisplayValue: display, position: 0 };
    }
    const bounded = applyBounds(definition, quantity.baseMagnitude, display, 0);
    if (bounded.normalizationState !== 'normalized') return bounded;
    return {
      normalizationState: 'normalized',
      sourceDisplayValue: display,
      normalizedNumber: quantity.baseMagnitude,
      normalizedUnit: expectedBase,
      ...(quantity.sourceUnit === undefined ? {} : { sourceUnit: quantity.sourceUnit }),
      ...(quantity.sourceDecimals === undefined ? {} : { sourceDecimals: quantity.sourceDecimals }),
      position: 0,
    };
  }
  if (quantity.state === 'unknown_unit') {
    return { normalizationState: 'unknown_unit', sourceDisplayValue: display, position: 0 };
  }

  // A bare number reaches here. It becomes a magnitude ONLY through a recorded
  // per-source mapping's unit — never through the attribute's own base unit,
  // which would be an inference dressed as a default.
  const bare = /^-?\d+(?:\.\d+)?$/u.exec(display.trim());
  if (!bare || assumedUnit === undefined) {
    return { normalizationState: 'unparsed', sourceDisplayValue: display, position: 0 };
  }
  const unit = resolveUnit(assumedUnit);
  if (unit === null) {
    return { normalizationState: 'unknown_unit', sourceDisplayValue: display, position: 0 };
  }
  const family = unitFamilyOf(unit);
  if (family === null || BASE_UNITS[family] !== expectedBase) {
    return { normalizationState: 'unknown_unit', sourceDisplayValue: display, position: 0 };
  }
  const magnitude = toBaseUnit(Number(display.trim()), unit);
  if (magnitude === null) {
    return { normalizationState: 'unknown_unit', sourceDisplayValue: display, position: 0 };
  }
  const bounded = applyBounds(definition, magnitude, display, 0);
  if (bounded.normalizationState !== 'normalized') return bounded;

  const text = display.trim();
  const dot = text.indexOf('.');
  return {
    normalizationState: 'normalized',
    sourceDisplayValue: display,
    normalizedNumber: magnitude,
    normalizedUnit: expectedBase,
    sourceUnit: unit,
    sourceDecimals: dot === -1 ? 0 : text.length - dot - 1,
    position: 0,
  };
}

/** The base unit an assumed unit implies, when it names one. */
function applyAssumedUnitFamily(assumedUnit?: string): string | undefined {
  if (assumedUnit === undefined) return undefined;
  const unit = resolveUnit(assumedUnit);
  if (unit === null) return undefined;
  const family = unitFamilyOf(unit);
  return family === null ? undefined : BASE_UNITS[family];
}

/**
 * The definition's validation and plausibility bounds, applied to a magnitude.
 *
 * `out_of_range` and `implausible` are different answers to different questions
 * and the order matters: a definitional impossibility is reported as one even if
 * it is also implausible, because the two call for different work — one is a
 * source sending nonsense, the other is a source sending the right number in the
 * wrong scale, which a recorded per-source mapping can fix.
 */
function applyBounds(
  definition: ResolvedAttributeDefinition,
  value: number,
  display: string,
  position: number,
): NormalizedAttributeFact {
  const { minValue, maxValue, implausibleAbove, implausibleBelow } = definition.row;
  if ((minValue !== null && value < minValue) || (maxValue !== null && value > maxValue)) {
    return { normalizationState: 'out_of_range', sourceDisplayValue: display, position };
  }
  if (
    (implausibleAbove !== null && value > implausibleAbove) ||
    (implausibleBelow !== null && value < implausibleBelow)
  ) {
    return { normalizationState: 'implausible', sourceDisplayValue: display, position };
  }
  return { normalizationState: 'normalized', sourceDisplayValue: display, position };
}

/**
 * Whether two normalized facts say the same thing.
 *
 * Comparison at the DECLARED precision, not at IEEE-754 equality. Two sources
 * meaning the same thing routinely land on different doubles: `1.1 in` converts
 * through 254/10 to 27.940000000000004832 while `2.794 cm` converts through
 * 10/1 to 27.940000000000001279 — measured, not assumed. Comparing those raw
 * makes two sources that agree look like a conflict, and an operator would be
 * asked to resolve a disagreement that does not exist. The same rounding also
 * makes a source that wrote `27.9 mm` agree with one that wrote `1.1 in` when
 * the definition declares one decimal place, which is what it means for a
 * declared precision to be the comparison unit.
 *
 * The precision used is the definition's `decimalPlaces` when it declares one,
 * else the coarser of the two sources' own decimal counts — never finer than
 * what either source actually measured, which is the "no false precision" rule
 * applied to comparison.
 */
export function normalizedFactsAgree(
  left: NormalizedAttributeFact,
  right: NormalizedAttributeFact,
  declaredDecimals: number | null,
): boolean {
  if (left.normalizationState !== right.normalizationState) return false;
  if (left.normalizationState !== 'normalized') return true;
  if (left.componentAxis !== right.componentAxis) return false;
  if ((left.normalizedText ?? null) !== (right.normalizedText ?? null)) return false;
  if ((left.normalizedBoolean ?? null) !== (right.normalizedBoolean ?? null)) return false;
  if ((left.normalizedUnit ?? null) !== (right.normalizedUnit ?? null)) return false;
  if ((left.normalizedCurrency ?? null) !== (right.normalizedCurrency ?? null)) return false;
  if ((left.normalizedAmountMinor ?? null) !== (right.normalizedAmountMinor ?? null)) return false;
  if (
    (left.normalizedDate?.getTime() ?? null) !== (right.normalizedDate?.getTime() ?? null)
  ) {
    return false;
  }
  if (
    (left.rangeLowerInclusive ?? null) !== (right.rangeLowerInclusive ?? null) ||
    (left.rangeUpperInclusive ?? null) !== (right.rangeUpperInclusive ?? null)
  ) {
    return false;
  }

  const decimals =
    declaredDecimals ?? Math.min(left.sourceDecimals ?? 6, right.sourceDecimals ?? 6);
  return (
    numbersAgree(left.normalizedNumber, right.normalizedNumber, decimals) &&
    numbersAgree(left.normalizedNumberMax, right.normalizedNumberMax, decimals)
  );
}

function numbersAgree(left: number | undefined, right: number | undefined, decimals: number): boolean {
  if (left === undefined || right === undefined) return left === right;
  const tolerance = 0.5 * 10 ** -Math.max(0, Math.min(12, decimals));
  return Math.abs(left - right) <= tolerance;
}
