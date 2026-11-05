/**
 * The pure core of the store price-analytics tool: the floors, the aggregate and
 * the position band, at their edges.
 */

import { describe, expect, it } from 'vitest';
import { STORE_PRICE_NEAR_LOWEST_BPS, STORE_PRICE_POSITION_BANDS } from '@mercaria/shared-types';
import type { PriceSampleEntry } from '../../price-signals/statistics.js';
import {
  crossSectionShortfall,
  positionBandFor,
  positionFor,
  summarizeMarket,
  type StorePriceFloors,
} from '../market.js';

const POLICY: StorePriceFloors = {
  version: 'test-v1',
  minObservations: 3,
  minDistinctSellers: 3,
  minDistinctOffers: 3,
  outlierModifiedZThreshold: 3.5,
  outlierMinDeviationBps: 7_500,
};

const NOW = new Date('2026-11-01T12:00:00.000Z');

function entry(id: string, amount: number, sellerKey: string): PriceSampleEntry {
  return { id, offerId: `offer-${id}`, sellerKey, amount, observedAt: NOW };
}

describe('the floors', () => {
  it('names the first floor a sample misses, in #82 order', () => {
    const base = {
      observations: 3,
      distinctSellers: 3,
      distinctOffers: 3,
      coverageDays: 0,
      outliersExcluded: 0,
      deduplicated: 0,
    };
    expect(crossSectionShortfall(base, POLICY)).toBeUndefined();
    expect(crossSectionShortfall({ ...base, observations: 2 }, POLICY)).toBe(
      'insufficient_observations',
    );
    expect(crossSectionShortfall({ ...base, distinctSellers: 2 }, POLICY)).toBe(
      'insufficient_distinct_sellers',
    );
    expect(crossSectionShortfall({ ...base, distinctOffers: 2 }, POLICY)).toBe(
      'insufficient_distinct_offers',
    );
  });

  it('does NOT apply time coverage to an instant — coverage 0 still measures', () => {
    // Every current offer is observed "now", so a cross-section spans zero days.
    // Applying `minCoverageDays` (CHECKed ≥ 1) would refuse every comparison.
    const market = summarizeMarket(
      [
        entry('a', 1_000, 'merchant:a'),
        entry('b', 1_100, 'merchant:b'),
        entry('c', 1_200, 'merchant:c'),
      ],
      POLICY,
    );
    expect(market.outcome).toBe('measured');
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
