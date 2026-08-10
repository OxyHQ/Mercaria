/**
 * The basket arithmetic (#81 item rules 4–6, basket rules 1–2, acceptances 1
 * and 2).
 *
 * Pure, so every case here is exact rather than probabilistic. The two that
 * matter most:
 *
 *  - a set where ONE line's delivery is unknown falls back to the `item_price`
 *    basis for ALL of them, rather than mixing a delivered total with a bare
 *    price (which is the number a buyer would most easily mistake for what they
 *    will pay);
 *  - a line denominated in another currency is REFUSED rather than skipped.
 *    Skipping is the quiet exclusion this whole issue exists to prevent, wearing
 *    a defensive check's clothing.
 */

import { describe, expect, it } from 'vitest';
import type { FxRateSnapshot, Money } from '@mercaria/shared-types';
import {
  composeWatchlistTotal,
  multiplyMoneyByQuantity,
  resolveWatchlistBasis,
  resolveWatchlistTarget,
  type WatchlistTotalLine,
} from '../totals.js';

const EUR_QUOTE: FxRateSnapshot = {
  from: 'USD',
  to: 'EUR',
  rate: 0.9,
  provider: 'static',
  asOf: '2026-08-10T00:00:00.000Z',
};

function eur(amount: number): Money {
  return { amount, currency: 'EUR' };
}

function knownLine(item: number, delivery: number): WatchlistTotalLine {
  return {
    lineItemPrice: eur(item),
    delivery: { known: true, unit: eur(delivery), line: eur(delivery), fx: EUR_QUOTE },
  };
}

function unknownDeliveryLine(item: number): WatchlistTotalLine {
  return { lineItemPrice: eur(item), delivery: { known: false, reason: 'not_published' } };
}

describe('multiplyMoneyByQuantity', () => {
  it('multiplies in minor units and keeps the currency', () => {
    expect(multiplyMoneyByQuantity(eur(1999), 3, 'test')).toEqual(eur(5997));
  });

  it('refuses a quantity that is not a positive integer', () => {
    expect(() => multiplyMoneyByQuantity(eur(100), 0, 'test')).toThrow(/positive integer/);
    expect(() => multiplyMoneyByQuantity(eur(100), 1.5, 'test')).toThrow(/positive integer/);
  });

  it('refuses a product that would exceed the representable range', () => {
    // The ceiling is what makes the check real: `Number.isInteger` alone accepts
    // a product far past `MAX_MONEY_MINOR_UNITS`, and the loss is silent.
    expect(() => multiplyMoneyByQuantity(eur(Number.MAX_SAFE_INTEGER), 2, 'test')).toThrow(
      /exceeds the maximum representable/,
    );
  });
});

describe('resolveWatchlistBasis', () => {
  it('is `delivered_total` only when EVERY line knows its delivery', () => {
    expect(resolveWatchlistBasis([knownLine(1000, 500), knownLine(2000, 300)])).toBe(
      'delivered_total',
    );
    expect(resolveWatchlistBasis([knownLine(1000, 500), unknownDeliveryLine(2000)])).toBe(
      'item_price',
    );
  });

  it('answers `item_price` for an empty set rather than a vacuous stronger claim', () => {
    expect(resolveWatchlistBasis([])).toBe('item_price');
  });
});

describe('composeWatchlistTotal', () => {
  it('sums a complete delivered total and says so', () => {
    const total = composeWatchlistTotal({
      displayCurrency: 'EUR',
      pricedLines: [knownLine(1000, 500), knownLine(2000, 300)],
      totalItems: 2,
    });
    expect(total).toEqual({
      known: true,
      completeness: 'complete',
      basis: 'delivered_total',
      amount: eur(3800),
      includedItems: 2,
      excludedItems: 0,
    });
  });

  it('#81 acceptance 2: ONE unknown shipping cost drops the WHOLE total to item price', () => {
    // Not "delivered where known, item price where not" — that mixture is a
    // number in no basis at all, and it is the one a buyer would read as what
    // they will actually pay.
    const total = composeWatchlistTotal({
      displayCurrency: 'EUR',
      pricedLines: [knownLine(1000, 500), unknownDeliveryLine(2000)],
      totalItems: 2,
    });
    expect(total).toEqual({
      known: true,
      completeness: 'complete',
      basis: 'item_price',
      amount: eur(3000),
      includedItems: 2,
      excludedItems: 0,
    });
  });

  it('reports `partial` when an item could not be priced, and counts both sides', () => {
    const total = composeWatchlistTotal({
      displayCurrency: 'EUR',
      pricedLines: [knownLine(1000, 500)],
      totalItems: 3,
    });
    expect(total).toEqual({
      known: true,
      completeness: 'partial',
      basis: 'delivered_total',
      amount: eur(1500),
      includedItems: 1,
      excludedItems: 2,
    });
  });

  it('reports `unknown` — and NO amount — when nothing could be priced', () => {
    expect(
      composeWatchlistTotal({ displayCurrency: 'EUR', pricedLines: [], totalItems: 4 }),
    ).toEqual({ known: false, completeness: 'unknown' });
  });

  it('REFUSES a line in another currency rather than skipping it', () => {
    expect(() =>
      composeWatchlistTotal({
        displayCurrency: 'EUR',
        pricedLines: [
          knownLine(1000, 500),
          {
            lineItemPrice: { amount: 2000, currency: 'USD' },
            delivery: { known: false, reason: 'not_published' },
          },
        ],
        totalItems: 2,
      }),
    ).toThrow(/Refusing to sum a watchlist line denominated in USD/);
  });

  it('REFUSES a delivery cost in another currency too', () => {
    expect(() =>
      composeWatchlistTotal({
        displayCurrency: 'EUR',
        pricedLines: [
          {
            lineItemPrice: eur(1000),
            delivery: {
              known: true,
              unit: { amount: 500, currency: 'USD' },
              line: { amount: 500, currency: 'USD' },
              fx: EUR_QUOTE,
            },
          },
        ],
        totalItems: 1,
      }),
    ).toThrow(/delivery cost denominated in USD/);
  });
});

describe('resolveWatchlistTarget', () => {
  it('answers `no_target` when there is none', () => {
    expect(resolveWatchlistTarget(undefined, eur(1000))).toEqual({ state: 'no_target' });
  });

  it('compares against the UNIT price, not the line total', () => {
    expect(resolveWatchlistTarget({ amount: 1000, currency: 'EUR' }, eur(1000))).toEqual({
      state: 'reached',
      target: eur(1000),
      currentUnitPrice: eur(1000),
    });
    expect(resolveWatchlistTarget({ amount: 999, currency: 'EUR' }, eur(1000))).toEqual({
      state: 'not_reached',
      target: eur(999),
      currentUnitPrice: eur(1000),
    });
  });

  it('never converts a target: a different currency is NOT COMPARABLE', () => {
    // Converting would make "you reached your target" depend on a rate movement
    // rather than on a price.
    expect(resolveWatchlistTarget({ amount: 1000, currency: 'USD' }, eur(500))).toEqual({
      state: 'not_comparable',
      reason: 'target_currency_mismatch',
    });
  });

  it('distinguishes an unpriced item from a currency mismatch', () => {
    // The two have opposite remedies, so one reason for both would send a buyer
    // to restate a target that was never the problem.
    expect(resolveWatchlistTarget({ amount: 1000, currency: 'EUR' }, undefined)).toEqual({
      state: 'not_comparable',
      reason: 'item_not_priced',
    });
  });
});
