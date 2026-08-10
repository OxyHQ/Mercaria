/**
 * The pure rules of the price-history domain (#78).
 *
 * Every fixture here exercises the DISTINCTION the check exists to make rather
 * than a comfortable case: a zero-decimal currency beside an eight-decimal one,
 * an interval exactly ON the anchor boundary, a legitimate half-price sale
 * beside a minor/major units error, and two observations in the same
 * millisecond whose winner must not depend on which one the generator happened
 * to id first.
 */

import { describe, expect, it } from 'vitest';
import {
  CURRENCY_PRECISION,
  PRICE_SCALE_SHIFT_FACTOR,
  PRICE_SERIES_MEASURES,
  priceHistoryBucketEnd,
  priceHistoryBucketStart,
  priceHistoryBuckets,
  type FxRates,
} from '@mercaria/shared-types';
import {
  changeReasonsFor,
  decideObservationWrite,
  detectObservationAnomalies,
  observationHash,
  type ObservedTerms,
} from '../observation.js';
import { derivePriceSeries } from '../derive.js';
import type { PriceObservationRow } from '../../../db/priceHistory/priceSnapshotRepository.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

function terms(overrides: Partial<ObservedTerms> = {}): ObservedTerms {
  return {
    itemPriceAmount: 10_000,
    itemPriceCurrency: 'EUR',
    compareAtPriceAmount: null,
    compareAtPriceCurrency: null,
    shippingCostAmount: null,
    shippingCostCurrency: null,
    taxInclusion: 'unknown',
    conditionKey: 'new',
    availability: 'in_stock',
    ...overrides,
  };
}

/**
 * A rate map with a NON-FAIR base, deliberately.
 *
 * #78 currency rule 9 forbids adding a FairCoin-specific fixture, and the point
 * is not decorative: `fx.service` derives any base from the provider's own
 * pivot, so a suite that only ever exercised one base would pass against a
 * derivation that had quietly hard-coded it.
 */
function rates(overrides: Partial<FxRates> = {}): FxRates {
  return {
    base: 'USD',
    rates: { USD: 1, EUR: 0.9, JPY: 150, GBP: 0.8 },
    provider: 'static',
    asOf: '2026-01-01T00:00:00.000Z',
    stale: false,
    ttlSeconds: 300,
    ...overrides,
  };
}

function observation(overrides: Partial<PriceObservationRow> = {}): PriceObservationRow {
  return {
    snapshotId: 'snap-1',
    offerId: 'offer-1',
    observedAt: new Date('2026-03-02T10:00:00.000Z'),
    itemPriceAmount: 10_000,
    itemPriceCurrency: 'EUR',
    shippingCostAmount: null,
    shippingCostCurrency: null,
    conditionKey: 'new',
    market: 'ES',
    freshnessLevel: 'current',
    anomalies: [],
    supersededByCorrection: false,
    quarantined: false,
    offerKind: 'external',
    offerStatus: 'active',
    offerMerchantId: 'merchant-1',
    offerStorefrontId: null,
    offerStaleAt: new Date('2026-03-09T10:00:00.000Z'),
    offerLastSeenAt: new Date('2026-03-02T10:00:00.000Z'),
    offerSourceId: 'source-1',
    ...overrides,
  };
}

const derivationInput = {
  displayCurrency: 'EUR' as const,
  granularity: 'day' as const,
  rates: rates(),
  priceDisplayPermittedSourceIds: new Set(['source-1']),
  officialStoreMerchantIds: new Set<string>(),
};

describe('the observation digest', () => {
  it('covers the observed TERMS and nothing that changes on every re-read', () => {
    // Two readings of identical terms taken hours apart hash the same, which is
    // what makes the anchor interval measure a real quantity. A digest that
    // included `observedAt` would never collide and would deduplicate nothing —
    // a check that cannot distinguish success from failure.
    expect(observationHash(terms())).toBe(observationHash(terms()));
  });

  it('distinguishes an absent shipping cost from a shipping cost of ZERO', () => {
    const absent = observationHash(terms());
    const free = observationHash(terms({ shippingCostAmount: 0, shippingCostCurrency: 'EUR' }));
    expect(absent).not.toBe(free);
  });

  it('distinguishes two currencies at the same magnitude', () => {
    expect(observationHash(terms())).not.toBe(observationHash(terms({ itemPriceCurrency: 'USD' })));
  });
});

describe('change reasons', () => {
  it('reports EVERY reason that applies, not the first', () => {
    const before = terms();
    const after = terms({ itemPriceAmount: 9_000, conditionKey: 'used_good', availability: 'out_of_stock' });
    expect(changeReasonsFor(after, before).sort()).toEqual(
      ['availability', 'condition', 'price'].sort(),
    );
  });

  it('reports `initial` alone for an offer nothing has observed', () => {
    expect(changeReasonsFor(terms(), undefined)).toEqual(['initial']);
  });

  it('counts a change in the KNOWN shipping cost', () => {
    expect(
      changeReasonsFor(terms({ shippingCostAmount: 500, shippingCostCurrency: 'EUR' }), terms()),
    ).toEqual(['known_cost']);
  });
});

describe('deduplication and the anchor interval', () => {
  const anchorIntervalMs = DAY_MS;
  const observedAt = new Date('2026-03-02T00:00:00.000Z');

  it('suppresses an identical observation INSIDE the interval', () => {
    const decision = decideObservationWrite({
      terms: terms(),
      previous: { terms: terms(), observedAt: new Date(observedAt.getTime() - DAY_MS + 1) },
      observedAt,
      anchorIntervalMs,
    });
    expect(decision).toEqual({ write: false, outcome: 'deduplicated' });
  });

  it('writes an identical observation as an ANCHOR exactly ON the boundary', () => {
    // The boundary case, both sides. `elapsed < interval` suppresses, so an
    // elapsed EQUAL to the interval must write — and a test one millisecond
    // either side of the boundary is the only one that can tell a `<` from a
    // `<=`.
    const onBoundary = decideObservationWrite({
      terms: terms(),
      previous: { terms: terms(), observedAt: new Date(observedAt.getTime() - anchorIntervalMs) },
      observedAt,
      anchorIntervalMs,
    });
    expect(onBoundary).toEqual({ write: true, changeReasons: ['anchor'] });

    const justInside = decideObservationWrite({
      terms: terms(),
      previous: {
        terms: terms(),
        observedAt: new Date(observedAt.getTime() - anchorIntervalMs + 1),
      },
      observedAt,
      anchorIntervalMs,
    });
    expect(justInside.write).toBe(false);
  });

  it('never suppresses an observation whose terms MOVED, however recent', () => {
    const decision = decideObservationWrite({
      terms: terms({ itemPriceAmount: 9_999 }),
      previous: { terms: terms(), observedAt: new Date(observedAt.getTime() - 1) },
      observedAt,
      anchorIntervalMs,
    });
    expect(decision).toEqual({ write: true, changeReasons: ['price'] });
  });

  it('treats a source republishing the PAST as inside the interval', () => {
    const decision = decideObservationWrite({
      terms: terms(),
      previous: { terms: terms(), observedAt: new Date(observedAt.getTime() + 10 * DAY_MS) },
      observedAt,
      anchorIntervalMs,
    });
    expect(decision.write).toBe(false);
  });
});

describe('anomaly detection', () => {
  it('does NOT fire on a legitimate half-price sale', () => {
    // The distinction the detector exists to make. A catalogue-wide sale moves
    // a price by two; publishing majors where minors were moves it by a
    // hundred. A threshold that could not tell them apart would quarantine
    // every Black Friday.
    expect(detectObservationAnomalies(terms({ itemPriceAmount: 5_000 }), terms())).toEqual([]);
  });

  it('DOES fire on a minor/major units error', () => {
    expect(detectObservationAnomalies(terms({ itemPriceAmount: 100 }), terms())).toContain(
      'price_scale_shift',
    );
    expect(
      detectObservationAnomalies(terms({ itemPriceAmount: 1_000_000 }), terms()),
    ).toContain('price_scale_shift');
  });

  it('fires exactly ON the factor, in both directions', () => {
    const up = terms({ itemPriceAmount: 10_000 * PRICE_SCALE_SHIFT_FACTOR });
    const down = terms({ itemPriceAmount: 10_000 / PRICE_SCALE_SHIFT_FACTOR });
    expect(detectObservationAnomalies(up, terms())).toContain('price_scale_shift');
    expect(detectObservationAnomalies(down, terms())).toContain('price_scale_shift');
  });

  it('reports a currency change and does NOT then judge the scale', () => {
    // A EUR→JPY switch moves the minor-unit magnitude by more than the factor
    // without anything being wrong: JPY has no minor unit at all. Reporting
    // both would make `price_scale_shift` fire on every legitimate
    // re-denomination.
    const found = detectObservationAnomalies(
      terms({ itemPriceCurrency: 'JPY', itemPriceAmount: 16_000 }),
      terms(),
    );
    expect(found).toContain('currency_changed');
    expect(found).not.toContain('price_scale_shift');
  });

  it('reports a compare-at BELOW the price it is supposed to be above', () => {
    expect(
      detectObservationAnomalies(
        terms({ compareAtPriceAmount: 9_000, compareAtPriceCurrency: 'EUR' }),
        undefined,
      ),
    ).toEqual(['compare_at_below_price']);
  });

  it('does not divide by a zero previous price', () => {
    expect(detectObservationAnomalies(terms(), terms({ itemPriceAmount: 0 }))).toEqual([]);
  });
});

describe('bucketing', () => {
  it('buckets a day, an ISO week and a month in UTC', () => {
    const instant = new Date('2026-03-04T23:30:00.000Z'); // a Wednesday
    expect(priceHistoryBucketStart(instant, 'day').toISOString()).toBe('2026-03-04T00:00:00.000Z');
    // ISO weeks start on MONDAY; `getUTCDay()` is 0 for Sunday, so a naive
    // subtraction of `getUTCDay()` would put the week boundary on Sunday.
    expect(priceHistoryBucketStart(instant, 'week').toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(priceHistoryBucketStart(instant, 'month').toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('puts a SUNDAY in the week that began the Monday before it', () => {
    const sunday = new Date('2026-03-08T12:00:00.000Z');
    expect(priceHistoryBucketStart(sunday, 'week').toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  it('walks month boundaries by length rather than by division', () => {
    // February is why the enumerator walks: a computed count over a fixed
    // 30-day month is wrong for exactly the granularity people check least.
    const buckets = priceHistoryBuckets(
      new Date('2026-01-15T00:00:00.000Z'),
      new Date('2026-04-02T00:00:00.000Z'),
      'month',
    );
    expect(buckets.map((bucket) => bucket.toISOString())).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
    ]);
    expect(priceHistoryBucketEnd(new Date('2026-02-01T00:00:00.000Z'), 'month').toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    );
  });
});

describe('the derivation', () => {
  it('keeps segments separate — acceptance 2', () => {
    const { points } = derivePriceSeries({
      ...derivationInput,
      measures: ['lowest_item_price'],
      observations: [
        observation({ snapshotId: 'a', conditionKey: 'new', itemPriceAmount: 20_000 }),
        observation({ snapshotId: 'b', offerId: 'offer-2', conditionKey: 'used_good', itemPriceAmount: 5_000 }),
        observation({ snapshotId: 'c', offerId: 'offer-3', conditionKey: 'refurbished_seller', itemPriceAmount: 9_000 }),
      ],
    });

    const bySegment = new Map(points.map((point) => [point.segment, point.native.amount]));
    // The cheapest thing on the page is the used one, and it must NOT become
    // the "new" series' answer. Three separate answers, never one blended low.
    expect(bySegment.get('new')).toBe(20_000);
    expect(bySegment.get('used')).toBe(5_000);
    expect(bySegment.get('refurbished')).toBe(9_000);
  });

  it('excludes an unknown condition rather than defaulting it into `new`', () => {
    const { points, exclusions } = derivePriceSeries({
      ...derivationInput,
      measures: ['lowest_item_price'],
      observations: [observation({ conditionKey: 'unknown' })],
    });
    expect(points).toHaveLength(0);
    expect(exclusions[0]?.reasons).toContain('condition_unknown');
  });

  it('never treats an unpublished delivery cost as free — acceptance 7', () => {
    const { points, exclusions } = derivePriceSeries({
      ...derivationInput,
      measures: ['lowest_known_total'],
      observations: [observation()],
    });
    expect(points).toHaveLength(0);
    expect(exclusions[0]?.reasons).toContain('delivery_cost_unknown');
  });

  it('adds a KNOWN delivery cost into the total, in the item currency', () => {
    const { points } = derivePriceSeries({
      ...derivationInput,
      measures: ['lowest_known_total'],
      observations: [
        observation({ shippingCostAmount: 499, shippingCostCurrency: 'EUR' }),
      ],
    });
    expect(points[0]?.native).toEqual({ amount: 10_499, currency: 'EUR' });
  });

  it('excludes an observation whose currency the rate map cannot price — currency rule 6', () => {
    const { points, exclusions } = derivePriceSeries({
      ...derivationInput,
      measures: ['lowest_item_price'],
      // RON is a real currency and a legitimate observation. It is simply not
      // in the rate map, so comparing it against a EUR offer would be comparing
      // raw minor units — which the derivation refuses rather than guessing.
      observations: [observation({ itemPriceCurrency: 'RON' })],
    });
    expect(points).toHaveLength(0);
    expect(exclusions[0]?.reasons).toContain('currency_not_convertible');
  });

  it('carries the quote on a converted point and NONE on an unconverted one', () => {
    const { points } = derivePriceSeries({
      ...derivationInput,
      displayCurrency: 'USD',
      measures: ['lowest_item_price'],
      observations: [observation()],
    });
    const point = points[0];
    expect(point?.native).toEqual({ amount: 10_000, currency: 'EUR' });
    expect(point?.fx?.from).toBe('EUR');
    expect(point?.fx?.to).toBe('USD');
    expect(point?.fx?.rate).toBeCloseTo(1 / 0.9, 10);

    const same = derivePriceSeries({
      ...derivationInput,
      measures: ['lowest_item_price'],
      observations: [observation()],
    });
    expect(same.points[0]?.fx).toBeUndefined();
    expect(same.points[0]?.displayAmount).toBe(same.points[0]?.native.amount);
  });

  it('converts at each currency\'s OWN precision — JPY has no minor unit', () => {
    // 100 JPY is ¥100, not ¥1. A conversion that assumed two decimals
    // everywhere would be out by a factor of a hundred for exactly one of the
    // currencies in this map, and by 1e6 for FAIR.
    expect(CURRENCY_PRECISION.JPY).toBe(0);
    expect(CURRENCY_PRECISION.FAIR).toBe(8);

    const { points } = derivePriceSeries({
      ...derivationInput,
      displayCurrency: 'JPY',
      measures: ['lowest_item_price'],
      // €100.00 at 0.9 EUR and 150 JPY per USD ⇒ $111.11 ⇒ ¥16,667.
      observations: [observation()],
    });
    expect(points[0]?.displayAmount).toBe(16_667);
  });

  it('is DETERMINISTIC when two observations tie in the same millisecond', () => {
    // uuid v7 is NOT monotonic within a millisecond, so a tie broken on
    // insertion order or on the id alone would produce a different chart on
    // every rebuild for the same data — acceptance 5's exact failure. The
    // tiebreak is `(observedAt, snapshotId)`, which is total.
    const sameInstant = new Date('2026-03-02T10:00:00.000Z');
    const forwards = derivePriceSeries({
      ...derivationInput,
      measures: ['lowest_item_price'],
      observations: [
        observation({ snapshotId: 'bbb', offerId: 'offer-b', observedAt: sameInstant }),
        observation({ snapshotId: 'aaa', offerId: 'offer-a', observedAt: sameInstant }),
      ],
    });
    const backwards = derivePriceSeries({
      ...derivationInput,
      measures: ['lowest_item_price'],
      observations: [
        observation({ snapshotId: 'aaa', offerId: 'offer-a', observedAt: sameInstant }),
        observation({ snapshotId: 'bbb', offerId: 'offer-b', observedAt: sameInstant }),
      ],
    });
    expect(forwards.points[0]?.snapshotId).toBe('aaa');
    expect(backwards.points[0]?.snapshotId).toBe('aaa');
    expect(forwards.points).toEqual(backwards.points);
  });

  it('refuses a quarantined, superseded, anomalous or rights-withdrawn observation', () => {
    const cases: { row: Partial<PriceObservationRow>; reason: string }[] = [
      { row: { quarantined: true }, reason: 'source_run_quarantined' },
      { row: { supersededByCorrection: true }, reason: 'superseded_observation' },
      { row: { anomalies: ['price_scale_shift'] }, reason: 'anomalous_observation' },
      { row: { freshnessLevel: 'expired' }, reason: 'offer_not_comparable' },
      { row: { offerSourceId: 'source-withdrawn' }, reason: 'price_display_not_permitted' },
    ];
    for (const testCase of cases) {
      const { points, exclusions } = derivePriceSeries({
        ...derivationInput,
        measures: ['lowest_item_price'],
        observations: [observation(testCase.row)],
      });
      expect(points).toHaveLength(0);
      expect(exclusions[0]?.reasons).toContain(testCase.reason);
    }
  });

  it('admits a NATIVE observation, which has no source to hold a right', () => {
    const { points } = derivePriceSeries({
      ...derivationInput,
      measures: ['native_item_price'],
      observations: [observation({ offerKind: 'native', offerSourceId: null, offerMerchantId: null })],
    });
    expect(points).toHaveLength(1);
  });

  it('produces NOTHING for `mercaria_retail_item_price` — the #116 seam', () => {
    // The measure is representable and no offer kind can satisfy it, because
    // `OfferKind` has no `mercaria_retail` member. The emptiness is pinned so
    // the seam cannot be mistaken for a bug, and so closing it is a change to
    // the OFFER vocabulary rather than to the derivation.
    expect(PRICE_SERIES_MEASURES).toContain('mercaria_retail_item_price');
    const { points, exclusions } = derivePriceSeries({
      ...derivationInput,
      measures: ['mercaria_retail_item_price'],
      observations: [observation(), observation({ offerKind: 'native' })],
    });
    expect(points).toHaveLength(0);
    expect(exclusions.every((exclusion) => exclusion.reasons.includes('not_mercaria_retail_offer'))).toBe(
      true,
    );
  });

  it('produces an EMPTY official-store series when #55 has verified nobody', () => {
    const { points, exclusions } = derivePriceSeries({
      ...derivationInput,
      measures: ['official_store_item_price'],
      observations: [observation()],
    });
    expect(points).toHaveLength(0);
    expect(exclusions[0]?.reasons).toContain('not_official_store');
  });

  it('counts the contributing observations of a bucket', () => {
    const { points } = derivePriceSeries({
      ...derivationInput,
      measures: ['lowest_item_price'],
      observations: [
        observation({ snapshotId: 'a', itemPriceAmount: 12_000 }),
        observation({ snapshotId: 'b', offerId: 'offer-2', itemPriceAmount: 11_000 }),
        observation({ snapshotId: 'c', offerId: 'offer-3', itemPriceAmount: 13_000 }),
      ],
    });
    // One is not the same as three, and a chart that could not say so cannot
    // explain why a "lowest price" jumped when one seller delisted.
    expect(points[0]?.contributingObservationCount).toBe(3);
    expect(points[0]?.native.amount).toBe(11_000);
  });
});
