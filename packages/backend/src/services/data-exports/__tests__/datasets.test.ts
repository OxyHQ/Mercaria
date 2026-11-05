/** The CSV cell and amount rendering every export shares. */

import { describe, expect, it } from 'vitest';
import { csvCell, decimalAmount } from '../datasets.js';

describe('csvCell', () => {
  it('quotes text and doubles embedded quotes', () => {
    expect(csvCell('Blue "Deluxe", large')).toBe('"Blue ""Deluxe"", large"');
  });

  it('guards a cell a spreadsheet would read as a formula', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvCell(`${lead}HYPERLINK("x")`).startsWith(`"'${lead}`)).toBe(true);
    }
  });

  it('writes numbers, decimals, booleans and empties bare', () => {
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell({ decimal: '-12.50' })).toBe('-12.50');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(null)).toBe('');
  });
});

describe('decimalAmount', () => {
  it('renders minor units in the currency’s own precision, never through a float', () => {
    expect(decimalAmount({ amount: 1999, currency: 'USD' })).toBe('19.99');
    expect(decimalAmount({ amount: 5, currency: 'EUR' })).toBe('0.05');
    expect(decimalAmount({ amount: -250, currency: 'EUR' })).toBe('-2.50');
    expect(decimalAmount({ amount: 1500, currency: 'JPY' })).toBe('1500');
    expect(decimalAmount({ amount: 9_007_199_254_740_991, currency: 'FAIR' })).toBe(
      '90071992.54740991',
    );
    expect(decimalAmount(undefined)).toBeUndefined();
  });
});
