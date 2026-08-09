/**
 * Deterministic, reversible unit normalization (#56 attribute rules 2–4).
 *
 * The round trip is the point. A conversion table written with decimal factors
 * passes a "converts inches to millimetres" test and still loses the original
 * value on the way back, so the reversibility check runs over EVERY unit in the
 * table at several magnitudes rather than over the two the author happened to
 * think of.
 */

import { describe, expect, it } from 'vitest';
import { UNIT_FAMILIES } from '@mercaria/shared-types';
import {
  BASE_UNITS,
  UNIT_DEFINITIONS,
  convertUnit,
  fromBaseUnit,
  normalizeQuantity,
  parseQuantity,
  resolveUnit,
  toBaseUnit,
  unitFamilyOf,
} from '../units.js';

describe('the unit table', () => {
  it('names a base unit for every family, and that base unit is in the table at factor 1', () => {
    for (const family of UNIT_FAMILIES) {
      const base = BASE_UNITS[family];
      const definition = UNIT_DEFINITIONS[base];
      expect(definition, `${family} base unit '${base}' is not in the table`).toBeDefined();
      expect(definition?.family).toBe(family);
      expect(definition?.numerator).toBe(1);
      expect(definition?.denominator).toBe(1);
    }
  });

  it('has a vacuity floor of units, so a broken table cannot pass the round trip trivially', () => {
    expect(Object.keys(UNIT_DEFINITIONS).length).toBeGreaterThanOrEqual(30);
  });
});

describe('reversibility', () => {
  const magnitudes = [1, 6.1, 256, 0.256, 1000, 12345.678];

  for (const unit of Object.keys(UNIT_DEFINITIONS)) {
    it(`round-trips every magnitude through '${unit}'`, () => {
      for (const magnitude of magnitudes) {
        const base = toBaseUnit(magnitude, unit);
        expect(base).not.toBeNull();
        if (base === null) return;
        const back = fromBaseUnit(base, unit);
        expect(back).not.toBeNull();
        if (back === null) return;
        // A relative tolerance rather than exact equality: the factors are exact
        // rationals, but a double still has 53 bits, and demanding bit equality
        // would be asserting something about IEEE rounding rather than about
        // this table.
        expect(Math.abs(back - magnitude)).toBeLessThanOrEqual(Math.abs(magnitude) * 1e-12);
      }
    });
  }

  it('is EXACT for the decimal-prefixed storage units a capacity axis uses', () => {
    // The variant signature is computed over this number, so any drift here
    // would make "256 GB" and "0.256 TB" hash differently and mint two variants.
    expect(toBaseUnit(256, 'GB')).toBe(256_000_000_000);
    expect(toBaseUnit(0.256, 'TB')).toBe(256_000_000_000);
    expect(fromBaseUnit(256_000_000_000, 'GB')).toBe(256);
  });

  it('converts inches to millimetres and exactly back', () => {
    expect(convertUnit(1, 'in', 'mm')).toBe(25.4);
    expect(convertUnit(25.4, 'mm', 'in')).toBe(1);
    expect(convertUnit(6.1, 'in', 'mm')).toBeCloseTo(154.94, 10);
  });

  it('refuses a cross-family conversion rather than answering', () => {
    // Not a rounding question: a mass is not a length, and returning a number
    // would be the guess this module exists not to make.
    expect(convertUnit(1, 'kg', 'mm')).toBeNull();
    expect(convertUnit(1, 'kg', 'not_a_unit')).toBeNull();
  });
});

describe('resolveUnit', () => {
  it('accepts the canonical spelling and the source spellings that mean it', () => {
    expect(resolveUnit('GB')).toBe('GB');
    expect(resolveUnit('gb')).toBe('GB');
    expect(resolveUnit('gigabytes')).toBe('GB');
    expect(resolveUnit('"')).toBe('in');
    expect(resolveUnit('inches')).toBe('in');
  });

  it('keeps case-sensitive units apart, which a blanket fold would merge', () => {
    // `mW` and `MW` differ by a factor of a million; `B` (byte) is not `b` (bit).
    // The EXACT spelling resolves; the ambiguous folded forms deliberately do
    // not, so a megawatt can never be stored as a milliwatt. This assertion
    // caught the alias table doing exactly that.
    expect(unitFamilyOf('mW')).toBe('power');
    expect(resolveUnit('mW')).toBe('mW');
    expect(toBaseUnit(1, 'mW')).toBe(0.001);
    expect(toBaseUnit(1, 'kW')).toBe(1000);
    expect(resolveUnit('MW')).toBeNull();
    expect(resolveUnit('mw')).toBeNull();
    expect(resolveUnit('mwh')).toBeNull();
    expect(resolveUnit('b')).toBeNull();
    // …and the unambiguous spellings of the same units still work, so the
    // refusal above is a narrowing and not a hole.
    expect(resolveUnit('mWh')).toBe('mWh');
    expect(resolveUnit('byte')).toBe('B');
    expect(resolveUnit('kW')).toBe('kW');
  });

  it('answers null for a unit it does not know', () => {
    expect(resolveUnit('parsecs')).toBeNull();
    expect(resolveUnit('   ')).toBeNull();
    expect(unitFamilyOf('parsecs')).toBeNull();
  });
});

describe('parseQuantity and normalizeQuantity', () => {
  it('reads a magnitude with a unit, spaced or not', () => {
    expect(parseQuantity('256GB')).toEqual({ magnitude: 256, unit: 'GB', family: 'digital_storage' });
    expect(parseQuantity(' 6.1 in ')).toEqual({ magnitude: 6.1, unit: 'in', family: 'length' });
    expect(parseQuantity('187 g')).toEqual({ magnitude: 187, unit: 'g', family: 'mass' });
  });

  it('normalizes different spellings of one capacity to ONE base magnitude', () => {
    const spellings = ['256 GB', '256GB', '0.256 TB', '256 gigabytes'];
    const normalized = spellings.map((spelling) => normalizeQuantity(spelling));
    for (const result of normalized) {
      expect(result.state).toBe('normalized');
      expect(result.baseUnit).toBe('B');
      expect(result.baseMagnitude).toBe(256_000_000_000);
    }
  });

  it('distinguishes an unknown UNIT from an unparsable STRING', () => {
    // Two different facts about a catalogue: the first is a taxonomy gap #94 can
    // close, the second is a value that is not a quantity at all. Collapsing them
    // would hide which one the data actually has.
    expect(normalizeQuantity('12 parsecs').state).toBe('unknown_unit');
    expect(normalizeQuantity('about 12 cm').state).toBe('unparsed');
    expect(normalizeQuantity('6–7 cm').state).toBe('unparsed');
    expect(normalizeQuantity('6,1 cm').state).toBe('unparsed');
    expect(normalizeQuantity('Black Titanium').state).toBe('unparsed');
  });

  it('never returns a magnitude alongside a non-normalized state', () => {
    // The database CHECK says the same thing; this is the earlier failure. A
    // state that carried a magnitude would be a guess with a label on it.
    for (const input of ['12 parsecs', 'about 12 cm', 'Black Titanium', '']) {
      const result = normalizeQuantity(input);
      if (result.state === 'normalized') continue;
      expect(result.baseMagnitude).toBeUndefined();
      expect(result.baseUnit).toBeUndefined();
    }
  });
});
