import { describe, expect, it } from 'vitest';
import { parseInventoryQuantity } from '../inventory-quantity';

describe('absolute inventory quantities', () => {
  it.each(['', ' ', '2.5', '-1', '12items', '1e3', 'Infinity', '2147483648', '9007199254740992'])(
    'refuses %j without changing its meaning',
    (value) => {
      expect(parseInventoryQuantity(value)).toBeNull();
    },
  );
  it.each([
    ['0', 0],
    [' 12 ', 12],
    ['002', 2],
    ['2147483647', 2147483647],
  ] as const)('preserves %j exactly', (value, expected) => {
    expect(parseInventoryQuantity(value)).toBe(expected);
  });
});
