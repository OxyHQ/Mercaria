import { describe, expect, it } from 'vitest';
import { sameVariantCombination } from '../variant-combination';

describe('variant combination identity', () => {
  const combination = [
    { name: 'Color', value: 'Red' },
    { name: 'Size', value: 'M' },
  ];
  it('compares exact named values regardless of display order', () => {
    expect(sameVariantCombination(combination, [...combination].reverse())).toBe(true);
  });
  it('does not merge case, missing options or different assignments', () => {
    expect(
      sameVariantCombination(combination, [{ name: 'Color', value: 'red' }, combination[1]]),
    ).toBe(false);
    expect(sameVariantCombination(combination, [combination[0]])).toBe(false);
    expect(
      sameVariantCombination(combination, [
        { name: 'Color', value: 'M' },
        { name: 'Size', value: 'Red' },
      ]),
    ).toBe(false);
    expect(sameVariantCombination([], [])).toBe(true);
  });
});
