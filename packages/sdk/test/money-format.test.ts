import { describe, expect, it } from 'vitest';
import { formatMoney } from '../src/index';
import { formatMoney as uiFormatMoney } from '../../ui/src/lib/format';

describe('canonical catalog money formatting', () => {
  it('uses exactly the UI implementation with no UI dependency at runtime', () => {
    expect(formatMoney).toBe(uiFormatMoney);
  });
  it.each([
    [{ amount: 14_800_000_000, currency: 'FAIR' }, 'en', '\u2068⊜148.00\u2069'],
    [{ amount: 14800, currency: 'EUR' }, 'de', '\u2068€148,00\u2069'],
    [{ amount: 148, currency: 'JPY' }, 'en', '\u2068¥148.00\u2069'],
    [{ amount: 0, currency: 'USD' }, 'en_US', '\u2068$0.00\u2069'],
  ] as const)('formats %j for %s', (money, locale, expected) => {
    expect(formatMoney(money, locale)).toBe(expected);
  });
});
