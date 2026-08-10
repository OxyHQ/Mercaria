/**
 * The pure rules (#82 acceptance 7: "tests cover outliers, duplicates, stale
 * data, currency conversion and weak samples").
 *
 * Every fixture below is chosen to exercise the DISTINCTION the rule exists to
 * make, which is the only kind of fixture that can tell a correct implementation
 * from a plausible one:
 *
 * - A syndicated duplicate at a DIFFERENT price, because two copies at the same
 *   price agree under either deduplication.
 * - A MAD of exactly zero, because that is the one input on which the textbook
 *   modified z-score excludes every value but the mode.
 * - A legitimate half-price sale BESIDE a units error, because a rule that
 *   catches both catches nothing.
 * - An EVEN-sized sample, because the lower-median convention and an interpolated
 *   one agree on every odd one.
 * - A sample one short of each floor, because a sample that clears every floor
 *   cannot tell a floor that is applied from one that is not.
 */

import { describe, expect, it } from 'vitest';
import {
  PRICE_SIGNAL_FORBIDDEN_INPUTS,
  PRICE_SIGNAL_FORBIDDEN_RECOMMENDATIONS,
  PRICE_SIGNAL_INPUTS,
  PRICE_SIGNAL_KINDS,
  PRICE_SIGNAL_RECOMMENDATION_KINDS,
  priceDeltaBps,
  priceMarketPositionFor,
  priceQualityConfidenceFor,
  priceQualityLabelFor,
  priceSampleShortfall,
  type PriceHistoryValue,
  type PriceSignalPolicy,
  type PriceSignalSample,
} from '@mercaria/shared-types';
import { buildSample } from '../sample.js';
import { derivePriceSignals, type PriceSignalDerivationInput } from '../signals.js';
import { resolveProductDemand } from '../seams.js';
import {
  coverageDays,
  deduplicateBySeller,
  lowerMedianIndex,
  nearestRankIndex,
  partitionOutliers,
  sellerDedupKey,
  type PriceSampleEntry,
} from '../statistics.js';

const DAY = 24 * 60 * 60 * 1_000;
const BASE = new Date('2026-01-01T00:00:00.000Z');

const POLICY: PriceSignalPolicy = {
  policyKey: 'offer-price-signals',
  version: 'test-v1',
  minObservations: 4,
  minDistinctSellers: 3,
  minDistinctOffers: 3,
  minCoverageDays: 2,
  recentWindowDays: 30,
  outlierModifiedZThreshold: 3.5,
  outlierMinDeviationBps: 7_500,
  materialDropBps: 500,
  typicalBandBps: 300,
  goodPriceBelowMedianBps: 800,
  strongSampleMultiplier: 2,
  objectiveMetricKeys: [],
  guardrailMetricKeys: ['zero_result_rate'],
};

function entry(
  id: string,
  amount: number,
  sellerKey: string,
  dayOffset = 0,
  offerId = `offer-${id}`,
): PriceSampleEntry {
  return { id, offerId, sellerKey, amount, observedAt: new Date(BASE.getTime() + dayOffset * DAY) };
}

function nativeValue(amount: number): PriceHistoryValue {
  return {
    basis: 'source_native',
    money: { amount, currency: 'EUR' },
    native: { amount, currency: 'EUR' },
  };
}

/* ────────────────────────────────────────────────────────────────────────── */

describe('the vocabularies are disjoint, and neither is empty', () => {
  it('an allowed input can never also be a forbidden one', () => {
    // The floors are the vacuity defence: an empty prohibition satisfies every
    // disjointness check while forbidding nothing.
    expect(PRICE_SIGNAL_INPUTS.length).toBeGreaterThanOrEqual(8);
    expect(PRICE_SIGNAL_FORBIDDEN_INPUTS.length).toBeGreaterThanOrEqual(8);
    for (const forbidden of PRICE_SIGNAL_FORBIDDEN_INPUTS) {
      expect(PRICE_SIGNAL_INPUTS as readonly string[]).not.toContain(forbidden);
    }
  });

  it('a recommendation can never be an automatic reprice or a sales promise', () => {
    expect(PRICE_SIGNAL_RECOMMENDATION_KINDS.length).toBeGreaterThanOrEqual(4);
    expect(PRICE_SIGNAL_FORBIDDEN_RECOMMENDATIONS.length).toBeGreaterThanOrEqual(4);
    for (const forbidden of PRICE_SIGNAL_FORBIDDEN_RECOMMENDATIONS) {
      expect(PRICE_SIGNAL_RECOMMENDATION_KINDS as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe('source-aware deduplication (statistical policy 3)', () => {
  it('folds one merchant reached through two syndicators into ONE seller', () => {
    // The two copies carry DIFFERENT prices on purpose: two copies at the same
    // price agree under either implementation, so an equal-price fixture cannot
    // tell a fold from an absence of one.
    const folded = deduplicateBySeller([
      entry('a', 1_000, 'merchant:m1', 0, 'offer-syndicator-1'),
      entry('b', 1_100, 'merchant:m1', 0, 'offer-syndicator-2'),
      entry('c', 1_200, 'merchant:m2'),
    ]);

    expect(folded.distinctSellers).toBe(2);
    // The OFFERS are counted before the fold, so the two floors stay independent.
    expect(folded.distinctOffers).toBe(3);
    expect(folded.deduplicated).toBe(1);
    // The CHEAPEST copy survives: the question is what a buyer could pay.
    expect(folded.entries.map((item) => item.amount)).toEqual([1_000, 1_200]);
  });

  it('the seller key is the merchant, then the native listing, then nothing', () => {
    expect(sellerDedupKey({ merchantId: 'm1' })).toBe('merchant:m1');
    expect(sellerDedupKey({ listingId: 'l1' })).toBe('listing:l1');
    // Neither known ⇒ UNDEFINED rather than a per-offer key, so the caller must
    // exclude it. A per-offer fallback inflates the seller count in the one
    // direction that makes a weak sample look strong.
    expect(sellerDedupKey({})).toBeUndefined();
  });
});

describe('the robust outlier method (statistical policy 5)', () => {
  it('sets aside a units error and KEEPS a legitimate half-price sale', () => {
    // Both fixtures in one sample, which is the point: a rule that catches both
    // catches nothing, and a rule that catches neither is not a rule.
    const sample = [
      entry('sale', 500, 'merchant:sale'), // half price — a real promotion
      entry('a', 1_000, 'merchant:a'),
      entry('b', 1_010, 'merchant:b'),
      entry('c', 990, 'merchant:c'),
      entry('d', 1_005, 'merchant:d'),
      entry('e', 995, 'merchant:e'),
      entry('typo', 100_000, 'merchant:typo'), // majors published as minors
    ].sort((left, right) => left.amount - right.amount);

    const partition = partitionOutliers(
      sample,
      POLICY.outlierModifiedZThreshold,
      POLICY.outlierMinDeviationBps,
    );
    const excluded = partition.excluded.map((item) => item.id);
    expect(excluded).toEqual(['typo']);
    // The SALE survives, and it is the half the z-score alone gets wrong: on this
    // tight cluster the MAD is ten minor units, so a half-price sale scores a
    // modified z of 33 and only the relative floor keeps it.
    expect(partition.kept.map((item) => item.id)).toContain('sale');
  });

  it('excludes NOTHING when the deviation is zero — the whole edge case', () => {
    // MAD is 0 whenever more than half the sample carries one value. The
    // textbook z-score is then infinite for every other value, and the naive
    // implementation deletes the variation the signal exists to measure.
    const sample = [
      entry('a', 1_000, 'merchant:a'),
      entry('b', 1_000, 'merchant:b'),
      entry('c', 1_000, 'merchant:c'),
      entry('d', 900, 'merchant:d'),
      entry('e', 1_100, 'merchant:e'),
    ].sort((left, right) => left.amount - right.amount);

    const partition = partitionOutliers(
      sample,
      POLICY.outlierModifiedZThreshold,
      POLICY.outlierMinDeviationBps,
    );
    expect(partition.excluded).toHaveLength(0);
    expect(partition.kept).toHaveLength(5);
  });

  it('returns a sample of fewer than three whole', () => {
    const sample = [entry('a', 1_000, 'merchant:a'), entry('b', 9_000, 'merchant:b')];
    expect(
      partitionOutliers(sample, POLICY.outlierModifiedZThreshold, POLICY.outlierMinDeviationBps)
        .excluded,
    ).toHaveLength(0);
  });

  it('deduplicates BEFORE detecting outliers', () => {
    // Five syndicated copies of one wrong price form their own cluster. Folded
    // first they are one seller and the outlier; detected first they pull the
    // median to themselves and the CORRECT prices become the outliers.
    const entries = [
      entry('w1', 9_000, 'merchant:wrong', 0, 'o1'),
      entry('w2', 9_000, 'merchant:wrong', 0, 'o2'),
      entry('w3', 9_000, 'merchant:wrong', 0, 'o3'),
      entry('w4', 9_000, 'merchant:wrong', 0, 'o4'),
      entry('w5', 9_000, 'merchant:wrong', 0, 'o5'),
      entry('a', 1_000, 'merchant:a'),
      entry('b', 1_010, 'merchant:b'),
      entry('c', 1_020, 'merchant:c'),
    ];
    const built = buildSample(entries, {
      deduplicate: true,
      outlierModifiedZThreshold: POLICY.outlierModifiedZThreshold,
      outlierMinDeviationBps: POLICY.outlierMinDeviationBps,
    });
    expect(built.sample.distinctSellers).toBe(3);
    expect(built.kept.map((item) => item.amount)).toEqual([1_000, 1_010, 1_020]);
    expect(built.excluded.map((item) => item.sellerKey)).toEqual(['merchant:wrong']);
  });
});

describe('quantiles name an observation and never interpolate', () => {
  it('the median of an EVEN sample is the lower middle value', () => {
    // An odd sample cannot tell the lower-median convention from an interpolated
    // one; an even one can, and every figure this domain publishes has to be a
    // price somebody actually charged.
    const sorted = [
      entry('a', 100, 'merchant:a'),
      entry('b', 200, 'merchant:b'),
      entry('c', 300, 'merchant:c'),
      entry('d', 400, 'merchant:d'),
    ];
    const index = lowerMedianIndex(sorted);
    expect(index).toBe(1);
    expect(sorted[index ?? 0]?.amount).toBe(200);
  });

  it('nearest-rank quartiles land on real positions', () => {
    expect(nearestRankIndex(4, 0.25)).toBe(0);
    expect(nearestRankIndex(4, 0.75)).toBe(2);
    expect(nearestRankIndex(0, 0.5)).toBeUndefined();
  });

  it('coverage is FLOORED, so 6 days and 23 hours is 6', () => {
    const sorted = [
      { ...entry('a', 1, 'merchant:a'), observedAt: BASE },
      { ...entry('b', 1, 'merchant:b'), observedAt: new Date(BASE.getTime() + 6 * DAY + 23 * 3_600_000) },
    ];
    expect(coverageDays(sorted)).toBe(6);
  });
});

describe('basis points, bands and labels', () => {
  it('a delta is signed, integral and symmetric under rounding', () => {
    expect(priceDeltaBps(1_080, 1_000)).toBe(800);
    expect(priceDeltaBps(920, 1_000)).toBe(-800);
    // Half-away-from-zero, so a rise and an equal fall round the SAME distance
    // rather than one of them collapsing to zero. Half a basis point either way
    // is the case that tells the two conventions apart.
    expect(priceDeltaBps(100_005, 100_000)).toBe(1);
    expect(priceDeltaBps(99_995, 100_000)).toBe(-1);
    // A zero reference cannot produce a ratio; it answers 0 rather than Infinity.
    expect(priceDeltaBps(100, 0)).toBe(0);
  });

  it('the band is inclusive at BOTH edges', () => {
    expect(priceMarketPositionFor(-300, 300)).toBe('near');
    expect(priceMarketPositionFor(300, 300)).toBe('near');
    expect(priceMarketPositionFor(-301, 300)).toBe('below');
    expect(priceMarketPositionFor(301, 300)).toBe('above');
  });

  it('`good_price` and `typical_price` cannot both apply to one price', () => {
    // The CHECK forces `goodPriceBelowMedianBps >= typicalBandBps`, so the two
    // verdicts never overlap and the answer does not depend on comparison order.
    expect(priceQualityLabelFor(-800, POLICY)).toBe('good_price');
    expect(priceQualityLabelFor(-799, POLICY)).toBe('typical_price');
    expect(priceQualityLabelFor(300, POLICY)).toBe('typical_price');
    expect(priceQualityLabelFor(301, POLICY)).toBe('above_typical');
  });
});

describe('sample floors and confidence (statistical policy 4, acceptance 3)', () => {
  const clears: PriceSignalSample = {
    observations: 4,
    distinctSellers: 3,
    distinctOffers: 3,
    coverageDays: 2,
    outliersExcluded: 0,
    deduplicated: 0,
  };

  it('reports the FIRST unmet floor, one short of each in turn', () => {
    // One short of each floor in turn, because a sample that clears every floor
    // cannot tell a floor that is applied from one that is not.
    expect(priceSampleShortfall(clears, POLICY)).toBeUndefined();
    expect(priceSampleShortfall({ ...clears, observations: 3 }, POLICY)).toBe(
      'insufficient_observations',
    );
    expect(priceSampleShortfall({ ...clears, distinctSellers: 2 }, POLICY)).toBe(
      'insufficient_distinct_sellers',
    );
    expect(priceSampleShortfall({ ...clears, distinctOffers: 2 }, POLICY)).toBe(
      'insufficient_distinct_offers',
    );
    expect(priceSampleShortfall({ ...clears, coverageDays: 1 }, POLICY)).toBe(
      'insufficient_time_coverage',
    );
  });

  it('confidence is `strong` only when EVERY floor is cleared by the multiple', () => {
    expect(priceQualityConfidenceFor(clears, POLICY)).toBe('sufficient');
    // A hundred observations from one seller is a long record of one shop, not a
    // strong market sample.
    expect(
      priceQualityConfidenceFor({ ...clears, observations: 100 }, POLICY),
    ).toBe('sufficient');
    expect(
      priceQualityConfidenceFor(
        { ...clears, observations: 8, distinctSellers: 6, distinctOffers: 6, coverageDays: 4 },
        POLICY,
      ),
    ).toBe('strong');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

/** A derivation input with nothing in it, for a test to fill in one field of. */
function emptyInput(overrides: Partial<PriceSignalDerivationInput> = {}): PriceSignalDerivationInput {
  return {
    scope: {
      scopeKind: 'canonical_product',
      canonicalProductId: 'product-1',
      segment: 'new',
      currency: 'EUR',
      from: BASE.toISOString(),
      to: new Date(BASE.getTime() + 30 * DAY).toISOString(),
      focus: 'market_best',
    },
    policy: POLICY,
    currentItemPrice: [],
    currentKnownTotal: [],
    historyItemPrice: [],
    historyKnownTotal: [],
    officialSellerKeys: new Set(),
    values: new Map(),
    ...overrides,
  };
}

/** A market sample that clears every floor, plus its values. */
function marketSample(): {
  entries: PriceSampleEntry[];
  values: Map<string, PriceHistoryValue>;
} {
  const entries = [
    entry('m1', 1_000, 'merchant:a', 0),
    entry('m2', 1_100, 'merchant:b', 1),
    entry('m3', 1_200, 'merchant:c', 2),
    entry('m4', 1_300, 'merchant:d', 3),
    entry('m5', 1_400, 'merchant:e', 4),
  ];
  const values = new Map(entries.map((item) => [item.id, nativeValue(item.amount)] as const));
  return { entries, values };
}

describe('the three states, and what each one may carry', () => {
  it('with NO active policy every signal is unmeasured and carries no value', () => {
    const signals = derivePriceSignals(emptyInput({ policy: undefined }));
    expect(signals).toHaveLength(PRICE_SIGNAL_KINDS.length);
    for (const signal of signals) {
      expect(signal.state).toBe('unmeasured');
      if (signal.state !== 'unmeasured') throw new Error('unreachable');
      expect(signal.reason).toBe('no_active_policy');
      expect(signal.policyVersion).toBeUndefined();
      expect('value' in signal).toBe(false);
      expect('evidence' in signal).toBe(false);
    }
  });

  it('a weak sample is unmeasured, NOT a low-confidence label (acceptance 3)', () => {
    const entries = [entry('a', 1_000, 'merchant:a'), entry('b', 1_100, 'merchant:b')];
    const values = new Map(entries.map((item) => [item.id, nativeValue(item.amount)] as const));
    const signals = derivePriceSignals(
      emptyInput({
        currentItemPrice: entries,
        focusItemPrice: entries[0],
        values,
      }),
    );
    const label = signals.find((signal) => signal.kind === 'price_quality_label');
    expect(label?.state).toBe('unmeasured');
    if (label?.state !== 'unmeasured') throw new Error('unreachable');
    expect(label.reason).toBe('insufficient_observations');
  });

  it('a measured label carries its confidence, its delta and its evidence', () => {
    const { entries, values } = marketSample();
    const signals = derivePriceSignals(
      emptyInput({ currentItemPrice: entries, focusItemPrice: entries[0], values }),
    );
    const label = signals.find((signal) => signal.kind === 'price_quality_label');
    expect(label?.state).toBe('measured');
    if (label?.state !== 'measured' || label.value.measure !== 'label') {
      throw new Error('unreachable');
    }
    // The focus is 1_000 against a lower median of 1_200 — 16.7% below.
    expect(label.value.deltaBps).toBe(-1_667);
    expect(label.value.label).toBe('good_price');
    expect(label.value.confidence).toBe('sufficient');
    expect(label.evidence.observationIds).toContain('m1');
    expect(label.policyVersion).toBe('test-v1');
  });

  it('a real fall past the threshold is MEASURED and carries both figures', () => {
    // The history holds a steady 1_400; the current price is 1_000, a 28.6% fall
    // against the most recent differing prior observation.
    const history = [
      entry('h1', 1_400, 'merchant:a', 0),
      entry('h2', 1_400, 'merchant:b', 1),
      entry('h3', 1_400, 'merchant:c', 2),
      entry('h4', 1_400, 'merchant:d', 3),
    ];
    const focus = entry('now', 1_000, 'merchant:a', 4);
    const values = new Map(
      [...history, focus].map((item) => [item.id, nativeValue(item.amount)] as const),
    );
    const signals = derivePriceSignals(
      emptyInput({ historyItemPrice: history, focusItemPrice: focus, values }),
    );
    const drop = signals.find((signal) => signal.kind === 'material_price_drop');
    expect(drop?.state).toBe('measured');
    if (drop?.state !== 'measured' || drop.value.measure !== 'drop') throw new Error('unreachable');
    expect(drop.value.deltaBps).toBe(-2_857);
    expect(drop.value.current.money.amount).toBe(1_000);
    expect(drop.value.previous.money.amount).toBe(1_400);
  });

  it('a fall SMALLER than the policy threshold is `not_present`, never a drop', () => {
    const history = [
      entry('h1', 1_000, 'merchant:a', 0),
      entry('h2', 1_000, 'merchant:b', 1),
      entry('h3', 1_000, 'merchant:c', 2),
      entry('h4', 1_000, 'merchant:d', 3),
    ];
    // 4.9% down — under the 5% the policy calls material.
    const focus = entry('now', 951, 'merchant:a', 4);
    const values = new Map(
      [...history, focus].map((item) => [item.id, nativeValue(item.amount)] as const),
    );
    const signals = derivePriceSignals(
      emptyInput({ historyItemPrice: history, focusItemPrice: focus, values }),
    );
    expect(signals.find((signal) => signal.kind === 'material_price_drop')?.state).toBe(
      'not_present',
    );
  });

  it('a RISE is `not_present` and never a drop of a negative amount', () => {
    const entries = [
      entry('h1', 1_000, 'merchant:a', 0),
      entry('h2', 1_000, 'merchant:b', 1),
      entry('h3', 1_000, 'merchant:c', 2),
      entry('h4', 1_000, 'merchant:d', 3),
    ];
    const focus = entry('now', 1_500, 'merchant:a', 4);
    const values = new Map(
      [...entries, focus].map((item) => [item.id, nativeValue(item.amount)] as const),
    );
    const signals = derivePriceSignals(
      emptyInput({ historyItemPrice: entries, focusItemPrice: focus, values }),
    );
    const drop = signals.find((signal) => signal.kind === 'material_price_drop');
    expect(drop?.state).toBe('not_present');
    expect('value' in (drop ?? {})).toBe(false);
  });

  it('an official-store position on a USED segment is refused by SEGMENT', () => {
    const { entries, values } = marketSample();
    const signals = derivePriceSignals(
      emptyInput({
        scope: { ...emptyInput().scope, segment: 'used' },
        currentItemPrice: entries,
        focusItemPrice: entries[0],
        officialSellerKeys: new Set(['merchant:a']),
        values,
      }),
    );
    const official = signals.find((signal) => signal.kind === 'official_store_position');
    expect(official?.state).toBe('unmeasured');
    if (official?.state !== 'unmeasured') throw new Error('unreachable');
    expect(official.reason).toBe('segment_not_applicable');
  });

  it('an official store is compared against OTHER offers, not against itself', () => {
    const { entries, values } = marketSample();
    const signals = derivePriceSignals(
      emptyInput({
        currentItemPrice: entries,
        focusItemPrice: entries[0],
        officialSellerKeys: new Set(['merchant:a']),
        values,
      }),
    );
    const official = signals.find((signal) => signal.kind === 'official_store_position');
    expect(official?.state).toBe('measured');
    if (official?.state !== 'measured' || official.value.measure !== 'relative') {
      throw new Error('unreachable');
    }
    // Four OTHER sellers remain (1_100…1_400); their lower median is 1_200, and
    // the official price of 1_000 is 16.7% below it. Including the official
    // seller would have made the median 1_200 as well by luck — so the sample
    // count is what pins the exclusion.
    expect(official.sample.distinctSellers).toBe(4);
    expect(official.value.deltaBps).toBe(-1_667);
  });

  it('no verified official channel is `not_present`, not an absence of data', () => {
    const { entries, values } = marketSample();
    const signals = derivePriceSignals(
      emptyInput({ currentItemPrice: entries, focusItemPrice: entries[0], values }),
    );
    expect(signals.find((signal) => signal.kind === 'official_store_position')?.state).toBe(
      'not_present',
    );
  });

  it('the lowest observed low is taken AFTER outlier exclusion (acceptance 2)', () => {
    const entries = [
      entry('typo', 1, 'merchant:typo', 0),
      entry('a', 1_000, 'merchant:a', 1),
      entry('b', 1_010, 'merchant:b', 2),
      entry('c', 1_020, 'merchant:c', 3),
      entry('d', 1_030, 'merchant:d', 4),
      entry('e', 1_040, 'merchant:e', 5),
    ];
    const values = new Map(entries.map((item) => [item.id, nativeValue(item.amount)] as const));
    const signals = derivePriceSignals(emptyInput({ historyItemPrice: entries, values }));
    const low = signals.find((signal) => signal.kind === 'lowest_observed_item_price');
    expect(low?.state).toBe('measured');
    if (low?.state !== 'measured' || low.value.measure !== 'money') throw new Error('unreachable');
    // NOT 1 — a source anomaly cannot generate a public historic low.
    expect(low.value.value.money.amount).toBe(1_000);
    // …and it is NAMED rather than deleted.
    expect(low.evidence.excludedOutlierObservationIds).toContain('typo');
  });

  it('a converted figure keeps its FX basis all the way to the signal', () => {
    const entries = [
      entry('a', 1_000, 'merchant:a', 0),
      entry('b', 1_010, 'merchant:b', 1),
      entry('c', 1_020, 'merchant:c', 2),
      entry('d', 1_030, 'merchant:d', 3),
    ];
    const values = new Map<string, PriceHistoryValue>(
      entries.map((item) => [
        item.id,
        {
          basis: 'historical_quote',
          money: { amount: item.amount, currency: 'EUR' },
          native: { amount: item.amount * 2, currency: 'USD' },
          quote: { from: 'USD', to: 'EUR', rate: 0.5, provider: 'static', asOf: BASE.toISOString() },
        } satisfies PriceHistoryValue,
      ]),
    );
    const signals = derivePriceSignals(emptyInput({ historyItemPrice: entries, values }));
    const low = signals.find((signal) => signal.kind === 'lowest_observed_item_price');
    if (low?.state !== 'measured' || low.value.measure !== 'money') throw new Error('unreachable');
    expect(low.value.value.basis).toBe('historical_quote');
    if (low.value.value.basis !== 'historical_quote') throw new Error('unreachable');
    expect(low.value.value.quote.rate).toBe(0.5);
    expect(low.value.value.native.currency).toBe('USD');
  });

  it('a typical range names BOTH of its endpoints', () => {
    const entries = [
      entry('a', 1_000, 'merchant:a', 0),
      entry('b', 1_100, 'merchant:b', 1),
      entry('c', 1_200, 'merchant:c', 2),
      entry('d', 1_300, 'merchant:d', 3),
    ];
    const values = new Map(entries.map((item) => [item.id, nativeValue(item.amount)] as const));
    const signals = derivePriceSignals(emptyInput({ historyItemPrice: entries, values }));
    const range = signals.find((signal) => signal.kind === 'typical_recent_range');
    if (range?.state !== 'measured' || range.value.measure !== 'money_range') {
      throw new Error('unreachable');
    }
    expect(range.value.low.money.amount).toBe(1_000);
    expect(range.value.high.money.amount).toBe(1_200);
    expect(range.evidence.observationIds).toHaveLength(2);
  });

  it('every signal names its variant, segment, market, currency, range and delivery', () => {
    // Acceptance 1: "different variants, conditions and currencies never share
    // one unlabeled signal". Every field is REQUIRED on the type; this walks a
    // real emitted set to prove none is silently empty.
    const { entries, values } = marketSample();
    const signals = derivePriceSignals(
      emptyInput({
        scope: { ...emptyInput().scope, market: 'ES' },
        currentItemPrice: entries,
        historyItemPrice: entries,
        focusItemPrice: entries[0],
        values,
      }),
    );
    for (const signal of signals) {
      expect(signal.subject.segment).toBe('new');
      expect(signal.subject.currency).toBe('EUR');
      expect(signal.subject.market).toBe('ES');
      expect(signal.subject.from).toBeTruthy();
      expect(signal.subject.to).toBeTruthy();
      expect(typeof signal.subject.deliveryIncluded).toBe('boolean');
      expect(signal.subject.taxInclusion).toBe('unknown');
      expect(signal.subject.canonicalProductId).toBe('product-1');
    }
    // The known-total measure is the ONLY one that says delivery is included.
    const withDelivery = signals.filter((signal) => signal.subject.deliveryIncluded);
    expect(withDelivery.map((signal) => signal.kind)).toEqual(['lowest_observed_known_total']);
  });

  it('an unknown delivery cost never becomes a known total', () => {
    // The known-total history is empty because no source published postage; the
    // item-price history is full. The two must not be conflated.
    const { entries, values } = marketSample();
    const signals = derivePriceSignals(
      emptyInput({ historyItemPrice: entries, historyKnownTotal: [], values }),
    );
    const total = signals.find((signal) => signal.kind === 'lowest_observed_known_total');
    expect(total?.state).toBe('unmeasured');
    if (total?.state !== 'unmeasured') throw new Error('unreachable');
    expect(total.reason).toBe('no_comparable_history');
    expect(signals.find((signal) => signal.kind === 'lowest_observed_item_price')?.state).toBe(
      'measured',
    );
  });
});

describe('the demand seam fails closed', () => {
  it('answers no data and names the missing metric definition', () => {
    const demand = resolveProductDemand();
    expect(demand.outcome).toBe('unavailable');
    if (demand.outcome !== 'unavailable') throw new Error('unreachable');
    expect(demand.reason).toBe('no_product_demand_metric_defined');
  });
});
