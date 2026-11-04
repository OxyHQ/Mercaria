/**
 * The lowest current price a summary states — compared within a currency, and
 * across currencies only through rates, never by minor units.
 *
 * Both summary fetchers order offers by RAW minor units (`price_amount`), which
 * across currencies is no order at all: 500 JPY sorts before 19.99 EUR, and a
 * summary that took "the first priced offer" stated the yen offer as the lowest
 * whatever the rates said. These cases pin the replacement rule.
 */

import { describe, expect, it } from 'vitest';
import type { FxRates, Offer } from '@mercaria/shared-types';
import { lowestOfferPrice, summariseProjectedOffers } from '../product-summary.js';

function offer(amount: number, currency: string): Offer {
  return {
    price: { amount, currency },
    availability: 'in_stock',
    freshness: { level: 'current', observedAt: '2026-09-01T10:00:00.000Z' },
  } as unknown as Offer;
}

/** 1 FAIR = 0.5 EUR = 80 JPY, so 1 EUR = 160 JPY. */
const RATES = {
  base: 'FAIR',
  rates: { EUR: 0.5, JPY: 80 },
  provider: 'test',
  asOf: '2026-09-01T00:00:00.000Z',
} as unknown as FxRates;

describe('lowestOfferPrice', () => {
  it('compares amounts within one currency, whatever order the offers arrive in', () => {
    expect(lowestOfferPrice([offer(2_500, 'EUR'), offer(1_999, 'EUR')], null)).toEqual({
      amount: 1_999,
      currency: 'EUR',
    });
  });

  it('compares currencies through rates, never by minor units', () => {
    // 1,500 JPY = 9.375 EUR, cheaper than 9.99 EUR — while by minor units
    // 999 < 1,500, which is the answer the old "first priced offer" rule gave.
    expect(lowestOfferPrice([offer(999, 'EUR'), offer(1_500, 'JPY')], RATES)).toEqual({
      amount: 1_500,
      currency: 'JPY',
    });
    // 5,000 JPY = 31.25 EUR, dearer than 19.99 EUR.
    expect(lowestOfferPrice([offer(5_000, 'JPY'), offer(1_999, 'EUR')], RATES)).toEqual({
      amount: 1_999,
      currency: 'EUR',
    });
  });

  it('states the price in its own currency — the comparison converts nothing it publishes', () => {
    expect(lowestOfferPrice([offer(900, 'JPY'), offer(1_999, 'EUR')], RATES)?.currency).toBe('JPY');
  });

  it('drops a currency it cannot quote, and states nothing when no two can be compared', () => {
    // ZZZ is not modelled: it cannot be shown to be lowest, however few its units.
    expect(lowestOfferPrice([offer(1, 'ZZZ'), offer(1_999, 'EUR')], RATES)).toEqual({
      amount: 1_999,
      currency: 'EUR',
    });
    // Mixed currencies and no rates: an absent price, never a guessed one.
    expect(lowestOfferPrice([offer(1_999, 'EUR'), offer(1_000, 'JPY')], null)).toBeUndefined();
    // A single currency needs no rates, modelled or not.
    expect(lowestOfferPrice([offer(7, 'ZZZ')], null)).toEqual({ amount: 7, currency: 'ZZZ' });
  });

  it('is absent with nothing priced', () => {
    expect(lowestOfferPrice([], RATES)).toBeUndefined();
    expect(
      lowestOfferPrice([{ ...offer(1, 'EUR'), price: undefined } as Offer], RATES),
    ).toBeUndefined();
  });
});

describe('summariseProjectedOffers', () => {
  it('reports the rate-compared lowest price of the current offers', () => {
    const summary = summariseProjectedOffers(
      'cp-1',
      [offer(5_000, 'JPY'), offer(1_999, 'EUR')],
      RATES,
    );
    expect(summary.lowestPrice).toEqual({ amount: 1_999, currency: 'EUR' });
    expect(summary.currentOfferCount).toBe(2);
  });
});
