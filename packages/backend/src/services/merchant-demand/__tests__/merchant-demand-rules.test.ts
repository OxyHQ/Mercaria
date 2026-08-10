/**
 * The pure rules of the merchant demand domain (#86).
 *
 * Everything here is a function of its arguments: the registry's own
 * consistency, the disclosure floors, the preview rounding, the preview
 * partition and the acquisition scorer. None of it needs a database, and the
 * ones that do — suppression against real counts, tenant isolation, supersession
 * and the claim transition — live in `merchant-demand.realdb.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  MERCHANT_ACQUISITION_CONTACT_SOURCE_KINDS,
  MERCHANT_ACQUISITION_FORBIDDEN_CONTACT_SOURCES,
  MERCHANT_ACQUISITION_FORBIDDEN_SCORE_INPUTS,
  MERCHANT_ACQUISITION_SCORE_INPUTS,
  MERCHANT_DEMAND_AGGREGATE_MIN_COUNT,
  MERCHANT_DEMAND_METRICS,
  MERCHANT_DEMAND_METRIC_KEYS,
  MERCHANT_DEMAND_MONEY_METRIC_KEYS,
  MERCHANT_DEMAND_PREVIEW_FORBIDDEN_METRIC_KEYS,
  MERCHANT_DEMAND_PREVIEW_METRIC_KEYS,
  MERCHANT_DEMAND_PREVIEW_MIN_COUNT,
  MERCHANT_DEMAND_PRODUCT_MIN_COUNT,
  MERCHANT_DEMAND_RESIDUAL_MIN_CONTRIBUTORS,
  MERCHANT_DEMAND_WINDOW_DAYS,
  discloseDemandCount,
  roundPreviewCount,
  scoreMerchantAcquisition,
  type MerchantAcquisitionFacts,
} from '@mercaria/shared-types';
import {
  findPreviewPartitionViolations,
  findTelemetryMoneyViolations,
  isPreviewVisible,
  merchantDemandMetricByKey,
  metricsAwaitingSeams,
  requireMerchantDemandMetric,
} from '../metrics.js';
import { toPreviewValue } from '../preview.service.js';
import {
  resolveClientDiscoveryFigure,
  resolveNetworkReportedFigure,
  resolvePriceAlertDemand,
  resolveZeroResultDemand,
} from '../seams.js';

describe('the registry is complete and states itself', () => {
  it('has real definitions — the vacuity floor', () => {
    expect(MERCHANT_DEMAND_METRICS.length).toBeGreaterThanOrEqual(15);
    expect(new Set(MERCHANT_DEMAND_METRIC_KEYS).size).toBe(MERCHANT_DEMAND_METRIC_KEYS.length);
  });

  it('every definition names a numerator, a denominator and an attribution limit', () => {
    for (const metric of MERCHANT_DEMAND_METRICS) {
      expect(metric.numerator.length, `${metric.key} numerator`).toBeGreaterThan(10);
      expect(metric.denominator.length, `${metric.key} denominator`).toBeGreaterThan(10);
      expect(metric.attributionLimit.length, `${metric.key} limit`).toBeGreaterThan(20);
      expect(metric.title.length, `${metric.key} title`).toBeGreaterThan(3);
    }
  });

  it('a key with no definition cannot be served, and `require` throws for one', () => {
    expect(merchantDemandMetricByKey('not_a_metric')).toBeUndefined();
    expect(() => requireMerchantDemandMetric('not_a_metric')).toThrow(/no definition/u);
  });

  it('no money metric is sourced from telemetry (#77 identity rule 8)', () => {
    expect(findTelemetryMoneyViolations()).toEqual([]);
    // The floor: a registry with no money metric would pass vacuously.
    expect(MERCHANT_DEMAND_MONEY_METRIC_KEYS.length).toBeGreaterThanOrEqual(3);
  });

  it('the money-key tuple is exactly the `money`-unit definitions', () => {
    const derived = MERCHANT_DEMAND_METRICS.filter((metric) => metric.unit === 'money').map(
      (metric) => metric.key,
    );
    expect([...MERCHANT_DEMAND_MONEY_METRIC_KEYS].sort()).toEqual(derived.sort());
  });

  it('#82’s metric is MEASURED, not a seam — the aggregation closed it', () => {
    const metric = requireMerchantDemandMetric('subjects_with_a_price_comparison');
    expect(metric.seam, 'a landed dependency must not still read as unbuilt').toBeUndefined();
    expect(metric.source).toBe('price_signals');
    // Named for what it COUNTS. "coverage" is #82's per-(segment, currency)
    // rate, which is a different number and must not borrow this label.
    expect(metric.key).not.toMatch(/coverage/u);
    expect(metric.attributionLimit).toMatch(/not #82’s per-segment coverage rate/u);
  });

  it('every seam names an ISSUE, so a dashboard can label it', () => {
    const awaiting = metricsAwaitingSeams();
    expect(awaiting.length).toBeGreaterThanOrEqual(5);
    for (const entry of awaiting) {
      expect(entry.seam, `${entry.key} seam`).toMatch(/^#\d+$/u);
    }
  });
});

describe('the preview partition is TOTAL — a metric in neither list fails', () => {
  it('classifies every metric exactly once', () => {
    const violations = findPreviewPartitionViolations();
    expect(violations.unclassified, 'a metric is in neither preview list').toEqual([]);
    expect(violations.overlapping, 'a metric is in both preview lists').toEqual([]);
  });

  it('both lists are non-empty and cover the registry — the vacuity floor', () => {
    expect(MERCHANT_DEMAND_PREVIEW_METRIC_KEYS.length).toBeGreaterThanOrEqual(2);
    expect(MERCHANT_DEMAND_PREVIEW_FORBIDDEN_METRIC_KEYS.length).toBeGreaterThanOrEqual(8);
    expect(
      MERCHANT_DEMAND_PREVIEW_METRIC_KEYS.length +
        MERCHANT_DEMAND_PREVIEW_FORBIDDEN_METRIC_KEYS.length,
    ).toBe(MERCHANT_DEMAND_METRIC_KEYS.length);
  });

  it('no money metric and no conversion metric is preview-visible (#86 preview rules 3 and 4)', () => {
    for (const key of MERCHANT_DEMAND_MONEY_METRIC_KEYS) {
      expect(isPreviewVisible(key), `${key} may not appear on a public preview`).toBe(false);
    }
    expect(isPreviewVisible('network_reported_conversions')).toBe(false);
    expect(isPreviewVisible('native_paid_orders')).toBe(false);
  });

  it('every preview-visible metric counts with a VISIT noun, never a sales one', () => {
    for (const key of MERCHANT_DEMAND_PREVIEW_METRIC_KEYS) {
      const definition = requireMerchantDemandMetric(key);
      expect(definition.unit, `${key} must be a count on the preview`).toBe('count');
      expect(['impressions', 'views', 'visits', 'clicks', 'searches']).toContain(definition.noun);
    }
  });
});

describe('disclosure: unknown is never zero and a bound is never published', () => {
  it('a count at the floor is measured; one below it is a STATE with no number', () => {
    const at = discloseDemandCount(MERCHANT_DEMAND_AGGREGATE_MIN_COUNT, MERCHANT_DEMAND_AGGREGATE_MIN_COUNT);
    expect(at.state).toBe('measured');
    if (at.state === 'measured' && at.measure.unit === 'count') {
      expect(at.measure.count).toBe(MERCHANT_DEMAND_AGGREGATE_MIN_COUNT);
    }

    const below = discloseDemandCount(MERCHANT_DEMAND_AGGREGATE_MIN_COUNT - 1, MERCHANT_DEMAND_AGGREGATE_MIN_COUNT);
    expect(below.state).toBe('suppressed');
    // The suppressed branch has NO count property to read — a bound is a
    // disclosure too, so "under 10" is not offered either.
    expect(Object.keys(below)).toEqual(['state', 'floor']);
  });

  it('the product floor is STRICTER than the aggregate floor', () => {
    expect(MERCHANT_DEMAND_PRODUCT_MIN_COUNT).toBeGreaterThan(MERCHANT_DEMAND_AGGREGATE_MIN_COUNT);
    expect(MERCHANT_DEMAND_PREVIEW_MIN_COUNT).toBeGreaterThan(MERCHANT_DEMAND_PRODUCT_MIN_COUNT);
  });
});

describe('the differencing defences are constants a reviewer can read', () => {
  it('a residual is never published over a SINGLE withheld product', () => {
    // The whole point. A value floor bounds how LARGE a published residual is
    // and says nothing about how few things it could be about — and a residual
    // over one withheld product IS that product's count, at any size.
    expect(MERCHANT_DEMAND_RESIDUAL_MIN_CONTRIBUTORS).toBeGreaterThanOrEqual(2);
  });

  it('the reporting windows are a CLOSED set, and no two differ by one day', () => {
    expect(MERCHANT_DEMAND_WINDOW_DAYS.length).toBeGreaterThanOrEqual(2);
    const sorted = [...MERCHANT_DEMAND_WINDOW_DAYS].sort((left, right) => left - right);
    // Adjacent windows a day apart would hand a caller a one-day slice by
    // subtraction, which is the attack the closed set exists to prevent — a
    // closed set of 29 and 30 would be closed and useless.
    for (let index = 1; index < sorted.length; index += 1) {
      expect(
        (sorted[index] ?? 0) - (sorted[index - 1] ?? 0),
        'two reporting windows differ by one day; their difference is one day of demand',
      ).toBeGreaterThan(1);
    }
    expect(new Set(sorted).size).toBe(sorted.length);
  });
});

describe('preview rounding rounds DOWN to two significant figures', () => {
  it('never reports MORE than happened', () => {
    for (const raw of [100, 137, 999, 1_000, 1_430, 8_299, 12_345, 999_999]) {
      expect(roundPreviewCount(raw), `rounding ${raw}`).toBeLessThanOrEqual(raw);
    }
  });

  it('matches the shapes #86 illustrates', () => {
    expect(roundPreviewCount(8_299)).toBe(8_200);
    expect(roundPreviewCount(1_430)).toBe(1_400);
    expect(roundPreviewCount(12_345)).toBe(12_000);
  });

  it('is defined at the edges rather than producing a NaN', () => {
    expect(roundPreviewCount(0)).toBe(0);
    expect(roundPreviewCount(-5)).toBe(0);
    expect(roundPreviewCount(Number.NaN)).toBe(0);
    // Below 100 the rounding is the identity, and the PREVIEW FLOOR is what
    // withholds those — rounding a 3 to a 0 would publish a zero where there
    // was demand.
    expect(roundPreviewCount(37)).toBe(37);
  });

  it('the preview re-states a suppression at ITS OWN floor, never the dashboard’s', () => {
    const suppressed = toPreviewValue({ state: 'suppressed', floor: MERCHANT_DEMAND_AGGREGATE_MIN_COUNT });
    expect(suppressed).toEqual({ state: 'suppressed', floor: MERCHANT_DEMAND_PREVIEW_MIN_COUNT });
  });

  it('a measured count under the preview floor is withheld, not rounded to zero', () => {
    const value = toPreviewValue({
      state: 'measured',
      measure: { unit: 'count', count: MERCHANT_DEMAND_PREVIEW_MIN_COUNT - 1 },
    });
    expect(value.state).toBe('suppressed');
  });

  it('an unavailable figure stays unavailable and keeps its reason', () => {
    const value = toPreviewValue({ state: 'unavailable', reason: 'awaiting_seam', seam: '#37' });
    expect(value).toEqual({ state: 'unavailable', reason: 'awaiting_seam', seam: '#37' });
  });
});

describe('the seams answer with NO number', () => {
  it('every one is unavailable and names why', () => {
    for (const value of [
      resolveClientDiscoveryFigure(),
      resolveNetworkReportedFigure(),
      resolvePriceAlertDemand(),
      resolveZeroResultDemand(),
    ]) {
      expect(value.state).toBe('unavailable');
      expect(Object.keys(value)).not.toContain('measure');
    }
  });

  it('the two REFUSALS are told apart from the two DEFERRALS by their reason', () => {
    // A deferral names an issue that owes work; a refusal says the figure must
    // not be produced. Collapsing them would make "#79 has not built it" and
    // "#79 decided nobody may ask" the same sentence on a dashboard.
    expect(resolveNetworkReportedFigure()).toEqual({
      state: 'unavailable',
      reason: 'awaiting_seam',
      seam: '#37',
    });
    expect(resolvePriceAlertDemand().state).toBe('unavailable');
    if (resolvePriceAlertDemand().state === 'unavailable') {
      expect(resolvePriceAlertDemand()).toMatchObject({
        reason: 'alert_subject_counts_unrepresentable',
      });
    }
    expect(resolveZeroResultDemand()).toMatchObject({ reason: 'relationship_not_defensible' });
  });
});

describe('acquisition scoring: an unmeasured input is left OUT of the mean', () => {
  const measured = (normalized: number) => ({ outcome: 'measured' as const, normalized });
  const missing = { outcome: 'unmeasured' as const, reason: 'collection_disabled' as const };

  function facts(overrides: Partial<MerchantAcquisitionFacts> = {}): MerchantAcquisitionFacts {
    return {
      aggregateDemand: measured(1),
      catalogSize: measured(1),
      catalogFreshness: measured(1),
      sourceQuality: measured(1),
      connectorFit: measured(1),
      unmetNativeDemand: measured(1),
      ...overrides,
    };
  }

  it('scores every measured input', () => {
    const score = scoreMerchantAcquisition(facts());
    expect(score.scoreBps).toBe(10_000);
    expect(score.contributingInputs).toHaveLength(MERCHANT_ACQUISITION_SCORE_INPUTS.length);
    expect(score.unmeasuredInputs).toEqual([]);
  });

  it('an unmeasured input does not drag the score DOWN — #58’s denominator rule', () => {
    const complete = scoreMerchantAcquisition(facts());
    const partial = scoreMerchantAcquisition(facts({ connectorFit: missing }));
    // Reading the missing input as zero would give 8,333. Leaving it out keeps
    // the score at what the measured inputs actually say.
    expect(partial.scoreBps).toBe(complete.scoreBps);
    expect(partial.unmeasuredInputs).toEqual([{ input: 'connector_fit', reason: 'collection_disabled' }]);
  });

  it('nothing measured scores zero AND reports every input unmeasured', () => {
    const score = scoreMerchantAcquisition({
      aggregateDemand: missing,
      catalogSize: missing,
      catalogFreshness: missing,
      sourceQuality: missing,
      connectorFit: missing,
      unmetNativeDemand: missing,
    });
    // "We scored it low" and "we could not score it" are distinguishable: the
    // second reports six unmeasured inputs beside the zero.
    expect(score.scoreBps).toBe(0);
    expect(score.contributingInputs).toEqual([]);
    expect(score.unmeasuredInputs).toHaveLength(MERCHANT_ACQUISITION_SCORE_INPUTS.length);
  });

  it('a normalized value outside [0, 1] cannot dominate the mean', () => {
    const score = scoreMerchantAcquisition(
      facts({ aggregateDemand: measured(50), catalogSize: measured(-9) }),
    );
    expect(score.scoreBps).toBeLessThanOrEqual(10_000);
    expect(score.scoreBps).toBeGreaterThanOrEqual(0);
  });

  it('the score version travels with every result', () => {
    expect(scoreMerchantAcquisition(facts()).scoreVersion).toMatch(/^\d{4}-\d{2}-\d{2}\./u);
  });
});

describe('the two prohibition vocabularies are DISJOINT', () => {
  it('no forbidden score input is also an allowed one', () => {
    const allowed = new Set<string>(MERCHANT_ACQUISITION_SCORE_INPUTS);
    const overlap = MERCHANT_ACQUISITION_FORBIDDEN_SCORE_INPUTS.filter((input) =>
      allowed.has(input),
    );
    expect(overlap, 'a prohibition became a scoring input').toEqual([]);
    expect(MERCHANT_ACQUISITION_SCORE_INPUTS.length).toBeGreaterThanOrEqual(5);
    expect(MERCHANT_ACQUISITION_FORBIDDEN_SCORE_INPUTS.length).toBeGreaterThanOrEqual(8);
  });

  it('the prohibitions #86 names are present as VALUES', () => {
    for (const forbidden of [
      'organic_rank_position',
      'ranking_policy_weight',
      'search_relevance_score',
      'affiliate_commission_rate',
      'fee_schedule_rate',
      'sponsored_placement',
    ]) {
      expect(MERCHANT_ACQUISITION_FORBIDDEN_SCORE_INPUTS).toContain(forbidden);
    }
  });

  it('no forbidden contact source is also an allowed one', () => {
    const allowed = new Set<string>(MERCHANT_ACQUISITION_CONTACT_SOURCE_KINDS);
    const overlap = MERCHANT_ACQUISITION_FORBIDDEN_CONTACT_SOURCES.filter((source) =>
      allowed.has(source),
    );
    expect(overlap, 'a prohibited contact origin became an allowed one').toEqual([]);
    expect(MERCHANT_ACQUISITION_CONTACT_SOURCE_KINDS.length).toBeGreaterThanOrEqual(4);
    expect(MERCHANT_ACQUISITION_FORBIDDEN_CONTACT_SOURCES.length).toBeGreaterThanOrEqual(8);
  });

  it('#86 privacy 7 is present as a VALUE — payment onboarding is named', () => {
    expect(MERCHANT_ACQUISITION_FORBIDDEN_CONTACT_SOURCES).toContain(
      'payment_onboarding_identity',
    );
    expect(MERCHANT_ACQUISITION_FORBIDDEN_CONTACT_SOURCES).toContain('stripe_connected_account');
  });
});
