/**
 * No unit may be converted or compared across DIMENSIONS (#367 Workstream 18,
 * "test unit conversion, precision and incompatible units").
 *
 * ## Why this file exists beside `units.test.ts`
 *
 * That file's cross-family case is `convertUnit(1, 'kg', 'mm')` — mass against
 * length, two families whose units look nothing alike. It leaves the case #94
 * actually legislates for untested: the THREE DIMENSIONLESS families.
 * `BASE_UNITS` declares them together and says why, verbatim:
 *
 * > an 85 % screen-to-body ratio, a 16:9 aspect ratio and a 4.5-star rating can
 * > never be compared to one another even though all three are bare numbers.
 * > That refusal IS what "percentages, ratios and ratings are distinct types"
 * > means mechanically; a shared `decimal` type would make it a convention.
 *
 * `pct`, `ratio` and `rating_point` are each a family's ONE unit, each with
 * numerator and denominator 1 — so a conversion among them is arithmetically the
 * identity, and an implementation that dropped the family comparison would
 * return the number unchanged and look entirely correct. That is the whole
 * hazard: a screen-to-body percentage would satisfy a review-score constraint
 * with the right answer for the wrong reason, and nothing downstream could tell.
 *
 * ## Exhaustive, not by example
 *
 * The property is over ALL family pairs, so the test enumerates
 * `UNIT_FAMILIES × UNIT_FAMILIES` rather than picking three. That is 15×15 = 225
 * pairs from one loop, and it covers a family added later without anybody
 * remembering this file — the `fitment-resolution.test.ts` permutation precedent,
 * where an exhaustive walk over a small finite domain is stronger than a sample.
 *
 * Every claim here is paired with the same-family case that MUST succeed. A file
 * asserting only refusals passes against `convertUnit` returning `null`
 * unconditionally, which is the failure mode with the widest blast radius: every
 * measurement in the catalogue becomes unconvertible and every conversion test
 * elsewhere fails for a reason naming something else.
 */

import { describe, expect, it } from 'vitest';

import { UNIT_FAMILIES, type UnitFamily } from '@mercaria/shared-types';
import {
  BASE_UNITS,
  UNIT_DEFINITIONS,
  convertUnit,
  toBaseUnit,
  unitFamilyOf,
} from '../units.js';

/**
 * The three families #94 names, and the reason this file exists.
 *
 * Asserted to be genuinely distinct families rather than assumed: if two of them
 * were ever collapsed onto one family, every refusal below would become an
 * ADMISSION and the loop would still be green about the remaining pairs.
 */
const DIMENSIONLESS: readonly UnitFamily[] = ['percentage', 'ratio', 'rating'];

/** Every canonical unit belonging to one family, from the table itself. */
function unitsOf(family: UnitFamily): readonly string[] {
  return Object.entries(UNIT_DEFINITIONS)
    .filter(([, definition]) => definition.family === family)
    .map(([unit]) => unit);
}

describe('the three dimensionless families are three families', () => {
  it('each has its own base unit, and no two share one', () => {
    const bases = DIMENSIONLESS.map((family) => BASE_UNITS[family]);
    expect(bases).toEqual(['pct', 'ratio', 'rating_point']);
    // Distinctness stated as a count, so collapsing two onto one unit fails HERE
    // rather than turning every refusal below into a silent admission.
    expect(new Set(bases).size).toBe(DIMENSIONLESS.length);

    for (const family of DIMENSIONLESS) {
      expect(unitFamilyOf(BASE_UNITS[family])).toBe(family);
    }
  });

  it('is arithmetically the identity, which is why the FAMILY is the only wall', () => {
    // The point of the whole file, made explicit. Each of the three units has
    // numerator === denominator === 1, so `toBaseUnit` is the identity and a
    // conversion among them would return the magnitude UNCHANGED — a wrong
    // answer indistinguishable from a right one. Nothing but the family
    // comparison in `convertUnit` stands between a percentage and a star rating.
    for (const family of DIMENSIONLESS) {
      const unit = BASE_UNITS[family];
      expect(UNIT_DEFINITIONS[unit]?.numerator).toBe(1);
      expect(UNIT_DEFINITIONS[unit]?.denominator).toBe(1);
      expect(toBaseUnit(87.5, unit)).toBe(87.5);
    }
  });

  it('refuses every conversion among them, in both directions', () => {
    const refused: string[] = [];
    const admitted: string[] = [];
    for (const from of DIMENSIONLESS) {
      for (const to of DIMENSIONLESS) {
        if (from === to) continue;
        const result = convertUnit(87.5, BASE_UNITS[from], BASE_UNITS[to]);
        (result === null ? refused : admitted).push(
          `${BASE_UNITS[from]}->${BASE_UNITS[to]}=${String(result)}`,
        );
      }
    }
    // Six ordered pairs from three families, and the count is asserted so a loop
    // that stopped iterating cannot pass by refusing nothing.
    expect(refused).toHaveLength(6);
    expect(admitted, `a dimensionless conversion was answered: ${admitted.join(', ')}`).toEqual([]);
  });
});

describe('cross-family refusal is a property of every family pair', () => {
  it('refuses every unlike pair and answers every like one', () => {
    const wrongfullyAnswered: string[] = [];
    const wrongfullyRefused: string[] = [];
    let sameFamilyChecks = 0;
    let crossFamilyChecks = 0;

    for (const from of UNIT_FAMILIES) {
      for (const to of UNIT_FAMILIES) {
        const fromUnit = BASE_UNITS[from];
        const toUnit = BASE_UNITS[to];
        const result = convertUnit(1, fromUnit, toUnit);
        if (from === to) {
          sameFamilyChecks += 1;
          // The base unit converted to itself is 1. This is the arm that fails
          // if `convertUnit` starts refusing everything.
          if (result !== 1) wrongfullyRefused.push(`${fromUnit}->${toUnit}=${String(result)}`);
          continue;
        }
        crossFamilyChecks += 1;
        if (result !== null) wrongfullyAnswered.push(`${fromUnit}->${toUnit}=${String(result)}`);
      }
    }

    // Both populations floored against the tuple, so a shrunken `UNIT_FAMILIES`
    // cannot make this pass by checking almost nothing.
    expect(sameFamilyChecks).toBe(UNIT_FAMILIES.length);
    expect(crossFamilyChecks).toBe(UNIT_FAMILIES.length * (UNIT_FAMILIES.length - 1));
    expect(crossFamilyChecks).toBeGreaterThan(100);

    expect(wrongfullyAnswered, `answered across dimensions: ${wrongfullyAnswered.join(', ')}`).toEqual([]);
    expect(wrongfullyRefused, `refused within one dimension: ${wrongfullyRefused.join(', ')}`).toEqual([]);
  });

  it('holds for EVERY unit of a family, not just its base', () => {
    // `convertUnit` reads the family off each unit's own definition, so a family
    // whose non-base units were mis-declared would leak only here. Length and
    // digital storage are the two families with several units each.
    const lengths = unitsOf('length');
    const storages = unitsOf('digital_storage');
    expect(lengths.length).toBeGreaterThan(2);
    expect(storages.length).toBeGreaterThan(2);

    for (const length of lengths) {
      for (const storage of storages) {
        expect(convertUnit(1, length, storage)).toBeNull();
        expect(convertUnit(1, storage, length)).toBeNull();
      }
      // …while the same family answers, which is what makes the nulls above a
      // family refusal rather than a broken table.
      expect(convertUnit(1, length, 'mm')).not.toBeNull();
    }
  });

  it('refuses an unknown unit, and does so distinguishably from nothing', () => {
    // An unknown unit and a cross-family unit both answer `null` from
    // `convertUnit`, which is why the DOWNSTREAM layers separate them into
    // `unknown_unit` and `unit_not_in_family` (pinned by
    // `constraint-validation.test.ts`). What this asserts is the input side:
    // `unitFamilyOf` tells them apart even though `convertUnit` does not.
    expect(unitFamilyOf('not_a_unit')).toBeNull();
    expect(unitFamilyOf('pct')).toBe('percentage');
    expect(convertUnit(1, 'pct', 'not_a_unit')).toBeNull();
    expect(convertUnit(1, 'not_a_unit', 'pct')).toBeNull();
  });
});
