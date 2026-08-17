/**
 * The dashboard's major↔minor unit money conversion, executed (#469).
 *
 * ## Why this one, out of everything in `lib/`
 *
 * `toMinorUnits` is what stands between a merchant's keyboard and every price
 * this app sends: the product screen, the variant matrix, the discount form and
 * the authoring wizard all go through it. Its two hard parts — rejecting bad
 * input as `null` rather than as `NaN`, and rounding away binary float error —
 * both fail by producing a NUMBER, which is the one failure mode nothing else
 * here can see. `19.99` in EUR is `1998.9999999999998` before rounding; a
 * `Math.trunc` or a `| 0` where the `Math.round` is writes 1998 minor units, and
 * `tsc`, lint, the money-formatting gate and `expo export` are all satisfied by
 * an integer. The merchant's price is a cent lower than they typed and no error
 * is raised anywhere.
 *
 * ## Precision comes from the currency, never from a constant
 *
 * The cases below run FAIR (8 decimals), EUR (2) and JPY (0) through the same
 * calls. JPY is the one that matters most: it has NO minor unit, so any hidden
 * `* 100` or `/ 100` — the shape a well-meaning simplification takes — turns a
 * ¥500 price into ¥50,000 or ¥5, and only a zero-decimal currency exposes it.
 */

import { describe, expect, it } from 'vitest';
import { toFairMinor, toMajorString, toMinorUnits } from '../money';

/** One FAIR, in minor units — FAIR carries eight decimals. */
const ONE_FAIR = 100_000_000;

describe('toMinorUnits refuses input it cannot convert', () => {
  it('answers null for an empty or whitespace-only field', () => {
    // The field a merchant has not filled in yet. `Number('')` is 0, so
    // returning a number here would price the product at zero.
    expect(toMinorUnits('')).toBeNull();
    expect(toMinorUnits('   ')).toBeNull();
  });

  it('answers null for text, never NaN', () => {
    expect(toMinorUnits('abc')).toBeNull();
    expect(toMinorUnits('12,50')).toBeNull();
  });

  it('answers null for a negative amount', () => {
    expect(toMinorUnits('-1')).toBeNull();
    expect(toMinorUnits('-0.01', 'EUR')).toBeNull();
  });

  it('answers null for a non-finite amount', () => {
    expect(toMinorUnits('Infinity')).toBeNull();
    expect(toMinorUnits('-Infinity')).toBeNull();
  });

  it('accepts a zero price, which is not the same as an empty field', () => {
    expect(toMinorUnits('0', 'EUR')).toBe(0);
    expect(toMinorUnits('0.00', 'EUR')).toBe(0);
  });

  it('accepts surrounding whitespace, which a paste carries in', () => {
    expect(toMinorUnits('  12.34  ', 'EUR')).toBe(1234);
  });
});

describe('toMinorUnits rounds binary float error away', () => {
  // Each of these is short of the integer before rounding — measured, not
  // assumed: 19.99 * 100 is 1998.9999999999998 in IEEE-754 doubles.
  it.each([
    ['19.99', 'EUR' as const, 1999],
    ['8.29', 'EUR' as const, 829],
    ['0.29', 'EUR' as const, 29],
    ['2.675', 'EUR' as const, 268],
  ])('%s %s is %d minor units', (major, currency, expected) => {
    expect(toMinorUnits(major, currency)).toBe(expected);
  });

  it('rounds at eight decimals too, where the error is further out', () => {
    expect(toMinorUnits('19.99', 'FAIR')).toBe(1_999_000_000);
    expect(toMinorUnits('0.1', 'FAIR')).toBe(10_000_000);
  });

  it('always returns an integer number of minor units', () => {
    for (const major of ['19.99', '0.07', '1.005', '33.33']) {
      expect(Number.isInteger(toMinorUnits(major, 'EUR'))).toBe(true);
      expect(Number.isInteger(toMinorUnits(major, 'FAIR'))).toBe(true);
    }
  });
});

describe('the currency decides the scale', () => {
  it('defaults to FAIR at eight decimals', () => {
    expect(toMinorUnits('148')).toBe(148 * ONE_FAIR);
    expect(toMinorUnits('148', 'FAIR')).toBe(toMinorUnits('148'));
  });

  it('uses two decimals for EUR', () => {
    expect(toMinorUnits('148', 'EUR')).toBe(14_800);
  });

  it('uses NO minor unit for JPY', () => {
    // ISO-4217 exponent 0. A hardcoded `* 100` anywhere in the conversion makes
    // this 50000, and every other currency in the set still passes.
    expect(toMinorUnits('500', 'JPY')).toBe(500);
    expect(toMajorString(500, 'JPY')).toBe('500');
  });

  it('toFairMinor is toMinorUnits pinned to FAIR', () => {
    expect(toFairMinor('148')).toBe(toMinorUnits('148', 'FAIR'));
    expect(toFairMinor('')).toBeNull();
  });
});

describe('toMajorString renders an editable field', () => {
  it('trims trailing zeros rather than showing 148.00000000', () => {
    expect(toMajorString(148 * ONE_FAIR, 'FAIR')).toBe('148');
  });

  it('keeps the decimals that carry value', () => {
    expect(toMajorString(1234, 'EUR')).toBe('12.34');
    expect(toMajorString(10_000_000, 'FAIR')).toBe('0.1');
  });

  it('renders zero as a single digit', () => {
    expect(toMajorString(0, 'EUR')).toBe('0');
  });

  it('round-trips a price a merchant typed', () => {
    for (const major of ['19.99', '0.29', '148']) {
      const minor = toMinorUnits(major, 'EUR');
      expect(minor).not.toBeNull();
      // `19.99` back to `19.99`, not `19.990000000000002`.
      expect(toMajorString(minor ?? 0, 'EUR')).toBe(String(Number(major)));
    }
  });
});
