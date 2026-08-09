/**
 * The #94 normalization pipeline, driven by the benchmark dataset.
 *
 * The whole benchmark runs as a table, so a fixture added there is exercised
 * here without a code change. The named cases below it are the ones whose
 * ASSERTION is more than "the state matched" — precision, agreement, structured
 * axes, and the refusals whose distinction from one another is the point.
 */

import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_OBSERVATIONS,
  BENCHMARK_DEFINITIONS,
  benchmarkResolved,
  fixtureDefinition,
} from './fixtures/benchmark-catalog.js';
import {
  normalizeAttributeObservation,
  normalizedFactsAgree,
} from '../normalization.service.js';
import { isMarketingClaim, MARKETING_PHRASE_COUNT } from '../marketing-claims.js';

describe('the benchmark dataset', () => {
  it('covers every launch category and every issue property', () => {
    // A vacuity floor: a traversal that silently stopped finding fixtures would
    // otherwise make every table-driven assertion below pass by running zero
    // times (AGENTS.md rule C).
    expect(BENCHMARK_DEFINITIONS.length).toBeGreaterThanOrEqual(18);
    expect(BENCHMARK_OBSERVATIONS.length).toBeGreaterThanOrEqual(30);

    const categories = new Set(
      BENCHMARK_DEFINITIONS.flatMap((entry) => [...entry.categories]),
    );
    expect([...categories].sort()).toEqual([
      'cameras',
      'headphones',
      'laptops',
      'pc-components',
      'phones',
    ]);

    const properties = new Set(BENCHMARK_OBSERVATIONS.map((entry) => entry.property));
    for (const required of [
      'mixed units',
      'enum aliases',
      'ranges',
      'scale errors',
      'no inferred unit',
      'cross-family refusal',
      'unknown unit',
      'marketing claim',
      'typed refusal',
      'dimensionless',
    ]) {
      expect(properties.has(required), `benchmark property '${required}' is missing`).toBe(true);
    }
  });

  it.each(BENCHMARK_OBSERVATIONS.map((entry) => [entry.property, entry.attributeKey, entry.displayValue, entry] as const))(
    '%s: %s = %s',
    (_property, attributeKey, _display, entry) => {
      const definition = benchmarkResolved(attributeKey);
      const facts = normalizeAttributeObservation({
        displayValue: entry.displayValue,
        definition,
        ...(entry.assumedUnit === undefined ? {} : { assumedUnit: entry.assumedUnit }),
      });

      expect(facts.length).toBeGreaterThan(0);
      const first = facts[0];
      if (!first) throw new Error('normalization produced no fact');
      expect(first.normalizationState).toBe(entry.expected);

      if (entry.baseMagnitude !== undefined) {
        expect(first.normalizedNumber).toBeCloseTo(entry.baseMagnitude, 6);
      }
      if (entry.normalizedText !== undefined) {
        expect(first.normalizedText).toBe(entry.normalizedText);
      }
      if (entry.range !== undefined) {
        expect(first.normalizedNumber).toBeCloseTo(entry.range[0], 6);
        expect(first.normalizedNumberMax).toBeCloseTo(entry.range[1], 6);
        expect(first.rangeLowerInclusive).toBe(true);
        expect(first.rangeUpperInclusive).toBe(true);
      }
      // The source's own words survive every outcome, including every refusal.
      expect(first.sourceDisplayValue).toBe(entry.displayValue);
    },
  );
});

describe('two equivalent measurements in different units', () => {
  it('compare equal at the declared precision (#94 acceptance 1)', () => {
    const definition = benchmarkResolved('screen_size');
    const [inches] = normalizeAttributeObservation({ displayValue: '6.1 in', definition });
    const [millimetres] = normalizeAttributeObservation({ displayValue: '154.94 mm', definition });
    const [centimetres] = normalizeAttributeObservation({ displayValue: '15.494 cm', definition });
    if (!inches || !millimetres || !centimetres) throw new Error('normalization produced no fact');

    // Reproducibly the same magnitude, and NOT by luck: the inch factor is the
    // exact rational 254/10, so the two multiplications land on one value.
    expect(inches.normalizedNumber).toBe(millimetres.normalizedNumber);
    expect(normalizedFactsAgree(inches, millimetres, 1)).toBe(true);

    // The centimetre spelling arrives through a different multiplication and
    // differs in the last bit — which is exactly the case that would look like a
    // CONFLICT if agreement were IEEE-754 equality.
    expect(normalizedFactsAgree(inches, centimetres, 1)).toBe(true);
  });

  it('keeps the source unit so the conversion is reversible for display', () => {
    const definition = benchmarkResolved('screen_size');
    const [fact] = normalizeAttributeObservation({ displayValue: '6.1 in', definition });
    expect(fact?.sourceUnit).toBe('in');
    expect(fact?.sourceDecimals).toBe(1);
    expect(fact?.normalizedUnit).toBe('mm');
  });

  it('does not invent precision the source did not have', () => {
    const definition = benchmarkResolved('screen_size');
    const [coarse] = normalizeAttributeObservation({ displayValue: '6 in', definition });
    const [fine] = normalizeAttributeObservation({ displayValue: '6.10 in', definition });
    expect(coarse?.sourceDecimals).toBe(0);
    expect(fine?.sourceDecimals).toBe(2);
    // 6 in is 152.4 mm and 6.10 in is 154.94 mm: genuinely different values, and
    // they must NOT be collapsed by a coarse comparison.
    expect(normalizedFactsAgree(coarse!, fine!, null)).toBe(false);
  });
});

describe('structured values name their axes', () => {
  it('splits a three-axis dimensions reading in the declared order', () => {
    const definition = benchmarkResolved('dimensions');
    const facts = normalizeAttributeObservation({
      displayValue: '155.6 x 71.5 x 8.25 mm',
      definition,
    });
    expect(facts.map((fact) => fact.componentAxis)).toEqual(['height', 'width', 'depth']);
    expect(facts.map((fact) => fact.position)).toEqual([0, 1, 2]);
    expect(facts[0]?.normalizedNumber).toBeCloseTo(155.6, 6);
    expect(facts[1]?.normalizedNumber).toBeCloseTo(71.5, 6);
    expect(facts[2]?.normalizedNumber).toBeCloseTo(8.25, 6);
    // The trailing unit applies to the components that carry none of their own.
    expect(facts.every((fact) => fact.normalizedUnit === 'mm')).toBe(true);
  });

  it('refuses a reading with the wrong number of components rather than guessing', () => {
    const definition = benchmarkResolved('dimensions');
    const facts = normalizeAttributeObservation({ displayValue: '155.6 x 71.5 mm', definition });
    // Three axes are declared and two were written: which one was omitted is not
    // recoverable, and either guess names a different product.
    expect(facts).toHaveLength(3);
    expect(facts.every((fact) => fact.normalizationState === 'unparsed')).toBe(true);
    expect(facts.map((fact) => fact.componentAxis)).toEqual(['height', 'width', 'depth']);
  });
});

describe('set cardinality', () => {
  it('splits a comma list into one fact per member, positioned', () => {
    const definition = benchmarkResolved('ports');
    const facts = normalizeAttributeObservation({
      displayValue: 'USB C, HDMI, 3.5mm',
      definition,
    });
    expect(facts.map((fact) => fact.normalizedText)).toEqual([
      'usb_c',
      'hdmi',
      'headphone_jack',
    ]);
    expect(facts.map((fact) => fact.position)).toEqual([0, 1, 2]);
  });

  it('does not split on whitespace, which is inside real values', () => {
    const definition = benchmarkResolved('ports');
    const facts = normalizeAttributeObservation({ displayValue: 'USB C', definition });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.normalizedText).toBe('usb_c');
  });
});

describe('the five refusals are distinguishable', () => {
  it('tells a taxonomy gap from an unreadable string from a scale error', () => {
    const screen = benchmarkResolved('screen_size');
    const weight = benchmarkResolved('weight');
    const core = benchmarkResolved('core_count');

    const unknownUnit = normalizeAttributeObservation({ displayValue: '12 parsecs', definition: screen });
    const unparsed = normalizeAttributeObservation({ displayValue: 'about six inches', definition: screen });
    const implausible = normalizeAttributeObservation({ displayValue: '0.148 g', definition: weight });
    const outOfRange = normalizeAttributeObservation({ displayValue: '9000', definition: core });

    expect(unknownUnit[0]?.normalizationState).toBe('unknown_unit');
    expect(unparsed[0]?.normalizationState).toBe('unparsed');
    expect(implausible[0]?.normalizationState).toBe('implausible');
    expect(outOfRange[0]?.normalizationState).toBe('out_of_range');

    // Not one of them carries a magnitude — the CHECK's application-side twin.
    for (const facts of [unknownUnit, unparsed, implausible, outOfRange]) {
      expect(facts[0]?.normalizedNumber).toBeUndefined();
      expect(facts[0]?.normalizedUnit).toBeUndefined();
    }
  });

  it('reports a definitional impossibility as out_of_range even when it is also implausible', () => {
    // `core_count` bounds are 1..512 and it declares no plausibility window, so
    // this is unambiguous; the ORDER inside `applyBounds` is what the assertion
    // pins — a value outside the declared bounds is a source sending nonsense,
    // which calls for different work from a scale error.
    const definition = fixtureDefinition({
      key: 'bounded',
      label: 'Bounded',
      valueType: 'decimal',
      minValue: 0,
      maxValue: 100,
      implausibleAbove: 50,
    });
    expect(
      normalizeAttributeObservation({ displayValue: '150', definition })[0]?.normalizationState,
    ).toBe('out_of_range');
    expect(
      normalizeAttributeObservation({ displayValue: '75', definition })[0]?.normalizationState,
    ).toBe('implausible');
  });
});

describe('marketing claims', () => {
  it('has a non-empty lexicon and matches on word boundaries', () => {
    expect(MARKETING_PHRASE_COUNT).toBeGreaterThanOrEqual(20);
    expect(isMarketingClaim('Blazing fast NVMe storage')).toBe(true);
    expect(isMarketingClaim('BLAZING   FAST')).toBe(true);
    expect(isMarketingClaim('top-notch build')).toBe(true);
    expect(isMarketingClaim('top notch build')).toBe(true);
  });

  it('leaves real specification values alone, including model names', () => {
    // The false positives that would make the gate get disabled by whoever hit
    // it next: `Pro`, `Ultra` and `Max` are model names in every launch
    // category, and a heuristic that refused them would be worse than none.
    for (const value of [
      'Aluminium',
      'MacBook Pro',
      'Ultra Wide',
      'Max',
      'Anodised aluminium unibody',
      'Amazingo',
    ]) {
      expect(isMarketingClaim(value), `'${value}' must not read as a marketing claim`).toBe(false);
    }
  });

  it('applies only to an objective attribute', () => {
    const objective = benchmarkResolved('build_material');
    const subjective = benchmarkResolved('editorial_style');
    expect(
      normalizeAttributeObservation({ displayValue: 'Premium quality aluminium', definition: objective })[0]
        ?.normalizationState,
    ).toBe('marketing_claim');
    expect(
      normalizeAttributeObservation({ displayValue: 'Premium quality finish', definition: subjective })[0]
        ?.normalizationState,
    ).toBe('normalized');
  });
});

describe('a value with no definition', () => {
  it('is kept as folded text rather than refused', () => {
    // A source may name an attribute nobody has defined yet; refusing it would
    // lose the observation, and the moment somebody defines the key it is there.
    const facts = normalizeAttributeObservation({ displayValue: '  Space  Grey ' });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.normalizationState).toBe('normalized');
    expect(facts[0]?.normalizedText).toBe('space grey');
  });
});
