/**
 * The pure core of the store price-analytics tool: the floors, the aggregate and
 * the position band, at their edges.
 */

import { describe, expect, it } from 'vitest';
import { STORE_PRICE_NEAR_LOWEST_BPS, STORE_PRICE_POSITION_BANDS } from '@mercaria/shared-types';
import type { PriceSampleEntry } from '../../price-signals/statistics.js';
import { positionBandFor, positionFor, summarizeMarket, type StorePriceFloors } from '../market.js';

const POLICY: StorePriceFloors = {
  version: 'test-v1',
  minObservations: 3,
  minDistinctSellers: 3,
  minDistinctOffers: 3,
  minCoverageDays: 7,
  outlierModifiedZThreshold: 3.5,
  outlierMinDeviationBps: 7_500,
};

const NOW = new Date('2026-11-01T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1_000;
/** An offer first seen twenty days ago — an ESTABLISHED market participant. */
const ESTABLISHED = new Date(NOW.getTime() - 20 * DAY);

function entry(
  id: string,
  amount: number,
  sellerKey: string,
  observedFrom: Date = ESTABLISHED,
): PriceSampleEntry {
  return { id, offerId: `offer-${id}`, sellerKey, amount, observedAt: NOW, observedFrom };
}

describe('the floors are all four of #82', () => {
  it('names the first floor a market misses, in #82 order', () => {
    const three = [
      entry('a', 1_000, 'merchant:a'),
      entry('b', 1_100, 'merchant:b'),
      entry('c', 1_200, 'merchant:c'),
    ];
    expect(summarizeMarket(three, POLICY).outcome).toBe('measured');
    expect(summarizeMarket(three.slice(0, 2), POLICY)).toEqual({
      outcome: 'unmeasured',
      reason: 'insufficient_observations',
    });
    // Three entries, two sellers — the syndicated pair folds to one.
    expect(
      summarizeMarket(
        [...three.slice(0, 2), entry('a2', 1_050, 'merchant:a'), entry('b2', 1_150, 'merchant:b')],
        { ...POLICY, minObservations: 2 },
      ),
    ).toEqual({ outcome: 'unmeasured', reason: 'insufficient_distinct_sellers' });
  });

  it("judges time coverage on the offers' own observation record", () => {
    // A market minted an hour ago: three sellers, first seen just now. Its span
    // is zero days, and it is NOT a market yet — the floor the old "now" stamp
    // made unanswerable, and that the tool used to skip.
    const minted = new Date(NOW.getTime() - 60 * 60 * 1_000);
    const fresh = [
      entry('a', 1_000, 'merchant:a', minted),
      entry('b', 1_100, 'merchant:b', minted),
      entry('c', 1_200, 'merchant:c', minted),
    ];
    expect(summarizeMarket(fresh, POLICY)).toEqual({
      outcome: 'unmeasured',
      reason: 'insufficient_time_coverage',
    });
    // Six days and 23 hours is six days: the floor rounds DOWN.
    const almost = new Date(NOW.getTime() - 7 * DAY + 60 * 60 * 1_000);
    expect(
      summarizeMarket(
        fresh.map((item) => ({ ...item, observedFrom: almost })),
        POLICY,
      ),
    ).toEqual({ outcome: 'unmeasured', reason: 'insufficient_time_coverage' });
    // One established seller is enough to give the market its span — the
    // sample's evidence runs from the earliest record to the latest read, the
    // same definition a history sample uses.
    expect(
      summarizeMarket([entry('a', 1_000, 'merchant:a'), ...fresh.slice(1)], POLICY).outcome,
    ).toBe('measured');
  });
});

describe('the aggregate', () => {
  it('is one price per seller — the cheapest — before anything is counted', () => {
    const market = summarizeMarket(
      [
        entry('a1', 1_000, 'merchant:a'),
        entry('a2', 900, 'merchant:a'),
        entry('b', 1_100, 'merchant:b'),
        entry('c', 1_200, 'merchant:c'),
      ],
      POLICY,
    );
    if (market.outcome !== 'measured') throw new Error('expected a measured market');
    expect(market.market.otherSellers).toBe(3);
    expect(market.market.lowestAmount).toBe(900);
    // Lower median of [900, 1100, 1200] is the middle one.
    expect(market.market.medianAmount).toBe(1_100);
  });

  it('refuses a market of two sellers, however many offers they publish', () => {
    const market = summarizeMarket(
      [
        entry('a1', 1_000, 'merchant:a'),
        entry('a2', 1_050, 'merchant:a'),
        entry('a3', 1_060, 'merchant:a'),
        entry('b', 1_100, 'merchant:b'),
      ],
      POLICY,
    );
    expect(market).toEqual({ outcome: 'unmeasured', reason: 'insufficient_observations' });
  });

  it('uses the LOWER median on an even sample', () => {
    const market = summarizeMarket(
      [
        entry('a', 1_000, 'merchant:a'),
        entry('b', 1_100, 'merchant:b'),
        entry('c', 1_200, 'merchant:c'),
        entry('d', 1_300, 'merchant:d'),
      ],
      POLICY,
    );
    if (market.outcome !== 'measured') throw new Error('expected a measured market');
    expect(market.market.medianAmount).toBe(1_100);
  });

  it('sets a wild outlier aside and counts it', () => {
    const market = summarizeMarket(
      [
        entry('a', 1_000, 'merchant:a'),
        entry('b', 1_010, 'merchant:b'),
        entry('c', 1_020, 'merchant:c'),
        entry('d', 1_030, 'merchant:d'),
        entry('e', 1_000_000, 'merchant:e'),
      ],
      POLICY,
    );
    if (market.outcome !== 'measured') throw new Error('expected a measured market');
    expect(market.market.outliersExcluded).toBe(1);
    expect(market.market.otherSellers).toBe(4);
  });
});

describe('the position band', () => {
  const market = { lowestAmount: 10_000, medianAmount: 12_000 };

  it('covers every band, inclusive toward the better one at each edge', () => {
    expect(positionBandFor(9_000, market)).toBe('lowest');
    expect(positionBandFor(10_000, market)).toBe('lowest');
    // Exactly 5% above the lowest is still "within 5%".
    expect(positionBandFor(10_000 + (10_000 * STORE_PRICE_NEAR_LOWEST_BPS) / 10_000, market)).toBe(
      'near_lowest',
    );
    expect(positionBandFor(10_501, market)).toBe('at_or_below_median');
    expect(positionBandFor(12_000, market)).toBe('at_or_below_median');
    expect(positionBandFor(12_001, market)).toBe('above_median');

    const seen = new Set(
      [9_000, 10_200, 11_000, 13_000].map((amount) => positionBandFor(amount, market)),
    );
    expect([...seen].sort()).toEqual([...STORE_PRICE_POSITION_BANDS].sort());
  });

  it('carries both deltas in basis points', () => {
    const position = positionFor(11_000, {
      otherSellers: 3,
      otherOffers: 3,
      lowestAmount: 10_000,
      medianAmount: 12_000,
      outliersExcluded: 0,
    });
    expect(position).toEqual({
      band: 'at_or_below_median',
      deltaToLowestBps: 1_000,
      deltaToMedianBps: -833,
    });
  });
});
