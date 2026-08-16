/**
 * The two pure derivations of the bounded referral pilot (#149), over every
 * boundary — and the measure registry #149's two lists are stated in.
 *
 * `deriveReferralPilotAdmission` and `evaluateReferralPilotThresholds` are pure
 * precisely so this file can drive them without a database, and the boundary is
 * where a safety bound gets it wrong: the cap that admits one too many, the
 * strict `>` that turns a one-occurrence stop into a two-occurrence one, and the
 * unmeasured metric that reads as a passing one.
 */

import { describe, expect, it } from 'vitest';
import {
  REFERRAL_PILOT_ADMISSION_REFUSALS,
  REFERRAL_PILOT_EXCLUDED_SUBJECTS,
  REFERRAL_PILOT_FORBIDDEN_MEASURE_SOURCES,
  REFERRAL_PILOT_MEASURES,
  REFERRAL_PILOT_MEASURE_SOURCES,
  REFERRAL_PILOT_STOP_METRICS,
  REFERRAL_PILOT_STOP_METRIC_MEASURES,
  REFERRAL_PILOT_STOP_ONLY_MEASURES,
  REFERRAL_PILOT_SUBJECTS,
} from '@mercaria/shared-types';
import {
  deriveReferralPilotAdmission,
  type ReferralPilotEntry,
  type ReferralPilotState,
} from '../admission.js';
import {
  evaluateReferralPilotThresholds,
  measureForStopMetric,
  REFERRAL_PILOT_RECOMMENDED_THRESHOLDS,
  type ReferralPilotMeasurement,
  type ReferralPilotThreshold,
} from '../thresholds.js';
import { composeReferralPilotReport, NET_CONTRIBUTION_COMPONENTS } from '../report.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const PARTNER = 'partner-1';
const PROGRAM = 'program-1';

function state(overrides: Partial<ReferralPilotState> = {}): ReferralPilotState {
  return {
    bounds: {
      cohortId: 'cohort-1',
      version: 1,
      subject: 'customer_acquisition',
      programId: PROGRAM,
      startsAt: new Date('2026-05-01T00:00:00.000Z'),
      endsAt: new Date('2026-07-01T00:00:00.000Z'),
      maxAttributionsPerPartner: 50,
      maxAttributionsTotal: 200,
    },
    allowlistedPartners: new Set([PARTNER]),
    liveStops: [],
    counts: { total: 0, forPartner: 0 },
    ...overrides,
  };
}

function entry(overrides: Partial<ReferralPilotEntry> = {}): ReferralPilotEntry {
  return {
    programId: PROGRAM,
    partnerId: PARTNER,
    subjectKind: 'oxy_user',
    market: null,
    at: NOW,
    ...overrides,
  };
}

describe('the pilot admits only what its published bounds name', () => {
  it('admits an allow-listed partner inside the window, naming the cohort version', () => {
    expect(deriveReferralPilotAdmission(state(), entry())).toEqual({
      outcome: 'admitted',
      cohortId: 'cohort-1',
      cohortVersion: 1,
    });
  });

  it('refuses everything when no cohort is active — the off position', () => {
    // An empty pilot IS the off position, which is why this domain adds no
    // environment variable: with no bounds published nothing may enter.
    expect(deriveReferralPilotAdmission(state({ bounds: null }), entry())).toEqual({
      outcome: 'refused',
      reason: 'no_active_cohort',
    });
  });

  it('refuses another programme, an unlisted partner and the wrong subject kind', () => {
    expect(deriveReferralPilotAdmission(state(), entry({ programId: 'other' }))).toEqual({
      outcome: 'refused',
      reason: 'program_not_in_pilot',
    });
    expect(
      deriveReferralPilotAdmission(
        state({ allowlistedPartners: new Set(['someone-else']) }),
        entry(),
      ),
    ).toEqual({ outcome: 'refused', reason: 'partner_not_allowlisted' });
    // A customer pilot does not attribute merchants, and a merchant pilot does
    // not attribute buyers — one cohort, one economy.
    expect(deriveReferralPilotAdmission(state(), entry({ subjectKind: 'merchant' }))).toEqual({
      outcome: 'refused',
      reason: 'subject_kind_not_in_pilot',
    });
  });

  it('keeps "not yet" and "over" apart, at the exact instants', () => {
    const bounds = state().bounds;
    if (bounds === null) throw new Error('fixture');
    // Start is INCLUSIVE, end is EXCLUSIVE.
    expect(deriveReferralPilotAdmission(state(), entry({ at: bounds.startsAt })).outcome).toBe(
      'admitted',
    );
    expect(
      deriveReferralPilotAdmission(
        state(),
        entry({ at: new Date(bounds.startsAt.getTime() - 1) }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'before_pilot_start' });
    expect(deriveReferralPilotAdmission(state(), entry({ at: bounds.endsAt }))).toEqual({
      outcome: 'refused',
      reason: 'after_pilot_end',
    });
    expect(
      deriveReferralPilotAdmission(state(), entry({ at: new Date(bounds.endsAt.getTime() - 1) }))
        .outcome,
    ).toBe('admitted');
  });

  it('admits the fiftieth entry and refuses the fifty-first, per partner and program-wide', () => {
    expect(
      deriveReferralPilotAdmission(state({ counts: { total: 10, forPartner: 49 } }), entry())
        .outcome,
    ).toBe('admitted');
    expect(
      deriveReferralPilotAdmission(state({ counts: { total: 10, forPartner: 50 } }), entry()),
    ).toEqual({ outcome: 'refused', reason: 'partner_entry_cap_reached' });
    expect(
      deriveReferralPilotAdmission(state({ counts: { total: 199, forPartner: 0 } }), entry())
        .outcome,
    ).toBe('admitted');
    expect(
      deriveReferralPilotAdmission(state({ counts: { total: 200, forPartner: 0 } }), entry()),
    ).toEqual({ outcome: 'refused', reason: 'program_entry_cap_reached' });
  });

  it('matches a partner stop EXACTLY, never by prefix', () => {
    const stop = { metric: 'privacy_incident', scope: 'partner', scopeRef: PARTNER } as const;
    expect(deriveReferralPilotAdmission(state({ liveStops: [stop] }), entry())).toEqual({
      outcome: 'refused',
      reason: 'stop_threshold_active',
    });
    // A prefix test would stop `partner-11` too, which is somebody else.
    expect(
      deriveReferralPilotAdmission(
        state({ liveStops: [stop] }),
        entry({ partnerId: `${PARTNER}1` }),
      ).outcome,
    ).toBe('refused'); // ...because it is not allow-listed, NOT because of the stop.
    expect(
      deriveReferralPilotAdmission(
        state({ liveStops: [stop], allowlistedPartners: new Set([`${PARTNER}1`]) }),
        entry({ partnerId: `${PARTNER}1` }),
      ).outcome,
    ).toBe('admitted');
  });

  it('lets a pilot-scoped stop cover everything, and a market stop cover nothing yet', () => {
    expect(
      deriveReferralPilotAdmission(
        state({
          liveStops: [{ metric: 'privacy_incident', scope: 'pilot', scopeRef: '' }],
        }),
        entry(),
      ),
    ).toEqual({ outcome: 'refused', reason: 'stop_threshold_active' });
    // No caller knows a market today, so a market stop cannot bite — which is
    // why the publish path refuses a market-scoped threshold rather than
    // letting an operator create a bound that reads as live and is not.
    expect(
      deriveReferralPilotAdmission(
        state({ liveStops: [{ metric: 'privacy_incident', scope: 'market', scopeRef: 'ES' }] }),
        entry(),
      ).outcome,
    ).toBe('admitted');
  });

  it('names a refusal for every bound, with no duplicates', () => {
    expect(REFERRAL_PILOT_ADMISSION_REFUSALS).toHaveLength(9);
    expect(new Set(REFERRAL_PILOT_ADMISSION_REFUSALS).size).toBe(9);
  });
});

describe('a threshold nobody measured is unmeasured, never within', () => {
  const threshold: ReferralPilotThreshold = {
    metric: 'refund_or_dispute_rate',
    unit: 'rate_bps',
    thresholdValue: 3_000,
    windowHours: 720,
    scope: 'pilot',
  };

  function measurement(
    overrides: Partial<ReferralPilotMeasurement> = {},
  ): ReferralPilotMeasurement {
    return {
      metric: 'refund_or_dispute_rate',
      unit: 'rate_bps',
      value: 100,
      scopeRef: '',
      sampleSize: 100,
      ...overrides,
    };
  }

  it('reports one outcome per THRESHOLD, so a missing measurement is visible', () => {
    expect(evaluateReferralPilotThresholds([threshold], [])).toEqual([
      { outcome: 'unmeasured', metric: 'refund_or_dispute_rate', reason: 'no_measurement' },
    ]);
  });

  it('keeps `no_producer` apart from `no_measurement`, and names the seam', () => {
    // `merchant_quality_deterioration` reads a measure nothing produces (#85
    // owns the projection). Reporting it as `no_measurement` would make a
    // permanent gap look like a transient one.
    const outcome = evaluateReferralPilotThresholds(
      [{ ...threshold, metric: 'merchant_quality_deterioration' }],
      [measurement({ metric: 'merchant_quality_deterioration' })],
    )[0];
    expect(outcome).toEqual({
      outcome: 'unmeasured',
      metric: 'merchant_quality_deterioration',
      reason: 'no_producer',
      seam: '#85',
    });
  });

  it('refuses a unit mismatch rather than comparing two different questions', () => {
    expect(
      evaluateReferralPilotThresholds([threshold], [measurement({ unit: 'minor_units' })])[0],
    ).toEqual({
      outcome: 'unmeasured',
      metric: 'refund_or_dispute_rate',
      reason: 'unit_mismatch',
    });
  });

  it('refuses a RATE off a sample below twenty, and never a count', () => {
    expect(
      evaluateReferralPilotThresholds([threshold], [measurement({ sampleSize: 19 })])[0]?.outcome,
    ).toBe('unmeasured');
    expect(
      evaluateReferralPilotThresholds([threshold], [measurement({ sampleSize: 20 })])[0]?.outcome,
    ).toBe('within');
    // One privacy incident is one incident whatever the denominator.
    const countThreshold: ReferralPilotThreshold = {
      metric: 'privacy_incident',
      unit: 'count',
      thresholdValue: 0,
      windowHours: 0,
      scope: 'pilot',
    };
    expect(
      evaluateReferralPilotThresholds(
        [countThreshold],
        [measurement({ metric: 'privacy_incident', unit: 'count', value: 1, sampleSize: 1 })],
      )[0],
    ).toEqual({
      outcome: 'breached',
      metric: 'privacy_incident',
      scope: 'pilot',
      scopeRef: '',
      observedValue: 1,
      thresholdValue: 0,
    });
  });

  it('breaches STRICTLY above, so the threshold value itself is within', () => {
    expect(
      evaluateReferralPilotThresholds([threshold], [measurement({ value: 3_000 })])[0]?.outcome,
    ).toBe('within');
    expect(
      evaluateReferralPilotThresholds([threshold], [measurement({ value: 3_001 })])[0]?.outcome,
    ).toBe('breached');
  });

  it('drops the scopeRef on a pilot-wide breach, so the live-stop key stays one row', () => {
    const outcome = evaluateReferralPilotThresholds(
      [threshold],
      [measurement({ value: 9_999, scopeRef: 'partner-9' })],
    )[0];
    expect(outcome?.outcome).toBe('breached');
    if (outcome?.outcome !== 'breached') return;
    expect(outcome.scopeRef).toBe('');
  });

  it('recommends a strict SUBSET of the twelve, rather than inventing numbers', () => {
    expect(REFERRAL_PILOT_RECOMMENDED_THRESHOLDS.length).toBeGreaterThanOrEqual(1);
    expect(REFERRAL_PILOT_RECOMMENDED_THRESHOLDS.length).toBeLessThan(
      REFERRAL_PILOT_STOP_METRICS.length,
    );
    for (const recommended of REFERRAL_PILOT_RECOMMENDED_THRESHOLDS) {
      expect(REFERRAL_PILOT_STOP_METRICS).toContain(recommended.metric);
      // A rate is bounded by its own denominator.
      if (recommended.unit === 'rate_bps') {
        expect(recommended.thresholdValue).toBeLessThanOrEqual(10_000);
      }
    }
  });
});

describe('every measure #149 names is defined exactly once, completely', () => {
  const all = [...REFERRAL_PILOT_MEASURES, ...REFERRAL_PILOT_STOP_ONLY_MEASURES];

  it('states a numerator, a denominator and an attribution limit for each', () => {
    // #77's rule: a number whose definition is unstated cannot be stored, and
    // TypeScript can only make the fields mandatory — not non-empty.
    expect(all.length).toBeGreaterThanOrEqual(30);
    for (const measure of all) {
      expect(measure.numerator.length, measure.key).toBeGreaterThan(20);
      expect(measure.denominator.length, measure.key).toBeGreaterThan(10);
      expect(measure.attributionLimit.length, measure.key).toBeGreaterThan(40);
    }
    expect(new Set(all.map((measure) => measure.key)).size).toBe(all.length);
  });

  it('carries a seam EXACTLY when nothing could derive it', () => {
    for (const measure of all) {
      expect(measure.seam === undefined, measure.key).toBe(measure.producer !== 'unavailable');
    }
  });

  it('splits #149 into its two published lists', () => {
    const metrics = REFERRAL_PILOT_MEASURES.filter((m) => m.kind === 'pilot_metric');
    const economics = REFERRAL_PILOT_MEASURES.filter((m) => m.kind === 'unit_economics');
    expect(metrics.length).toBeGreaterThanOrEqual(18);
    expect(economics).toHaveLength(12);
  });

  it('gives every stop metric a defined measure to read', () => {
    // A threshold published against a number nobody defined is one nothing can
    // evaluate — so the map is total and every target resolves.
    for (const metric of REFERRAL_PILOT_STOP_METRICS) {
      expect(REFERRAL_PILOT_STOP_METRIC_MEASURES[metric], metric).toBeTruthy();
      expect(measureForStopMetric(metric), metric).toBeDefined();
    }
  });

  it('keeps the permitted and forbidden source sets DISJOINT', () => {
    const permitted = new Set<string>(REFERRAL_PILOT_MEASURE_SOURCES);
    for (const forbidden of REFERRAL_PILOT_FORBIDDEN_MEASURE_SOURCES) {
      expect(permitted.has(forbidden), forbidden).toBe(false);
    }
    // A client event is never financial truth, and GMV is never a base.
    expect(REFERRAL_PILOT_FORBIDDEN_MEASURE_SOURCES).toContain('analytics_events');
    expect(REFERRAL_PILOT_FORBIDDEN_MEASURE_SOURCES).toContain('gross_merchandise_value');
    for (const measure of all) {
      expect(permitted.has(measure.source), measure.key).toBe(true);
    }
  });

  it('keeps the launched and excluded pilot subjects DISJOINT', () => {
    const launched = new Set<string>(REFERRAL_PILOT_SUBJECTS);
    for (const excluded of REFERRAL_PILOT_EXCLUDED_SUBJECTS) {
      expect(launched.has(excluded), excluded).toBe(false);
    }
  });
});

describe('the report renders what it can and says what it cannot', () => {
  const aggregates = {
    attributions: 40,
    distinctSubjects: 38,
    conversions: 12,
    verifiedConversions: 10,
    rewards: 10,
    realizedBaseMinor: 50_000,
    accruedNetMinor: 10_000,
    heldNetMinor: 6_000,
    vestedNetMinor: 4_000,
  };

  it('measures the eight it produces and marks the rest unmeasured with a reason', () => {
    const report = composeReferralPilotReport({
      cohortId: 'c1',
      cohortVersion: 1,
      from: new Date('2026-05-01T00:00:00.000Z'),
      to: NOW,
      budgetMinor: 100_000,
      aggregates,
    });
    expect(report.lines).toHaveLength(REFERRAL_PILOT_MEASURES.length);
    const measured = report.lines.filter((line) => line.outcome === 'measured');
    expect(measured).toHaveLength(8);
    expect(report.unmeasuredCount).toBe(REFERRAL_PILOT_MEASURES.length - 8);
    for (const line of report.lines) {
      if (line.outcome === 'unmeasured') expect(line.reason).toBeTruthy();
    }

    const byKey = new Map(measured.map((line) => [line.definition.key, line]));
    // 10 verified of 40 attributions is 2,500 bps, floored.
    const rate = byKey.get('qualified_conversion_rate');
    expect(rate?.outcome === 'measured' ? rate.value : null).toBe(2_500);
    // 10,000 accrued against a 100,000 budget is 1,000 bps.
    const utilization = byKey.get('budget_utilization');
    expect(utilization?.outcome === 'measured' ? utilization.value : null).toBe(1_000);
  });

  it('refuses to call net contribution measurable while a component is not', () => {
    // Three of its five components have no producer, so the honest answer is
    // that the figure #149 turns an expansion decision on cannot be stated.
    const report = composeReferralPilotReport({
      cohortId: 'c1',
      cohortVersion: 1,
      from: new Date('2026-05-01T00:00:00.000Z'),
      to: NOW,
      budgetMinor: 100_000,
      aggregates,
    });
    expect(report.netContributionMeasurable).toBe(false);
    expect(NET_CONTRIBUTION_COMPONENTS).toHaveLength(5);
    for (const key of NET_CONTRIBUTION_COMPONENTS) {
      expect(REFERRAL_PILOT_MEASURES.some((measure) => measure.key === key), key).toBe(true);
    }
  });

  it('reports an empty sample as unmeasured rather than as a zero rate', () => {
    // A pilot with no attributions has a conversion rate of nothing, not of 0%.
    const report = composeReferralPilotReport({
      cohortId: 'c1',
      cohortVersion: 1,
      from: new Date('2026-05-01T00:00:00.000Z'),
      to: NOW,
      budgetMinor: 100_000,
      aggregates: { ...aggregates, attributions: 0, verifiedConversions: 0 },
    });
    const line = report.lines.find((entry) => entry.definition.key === 'qualified_conversion_rate');
    expect(line?.outcome).toBe('unmeasured');
    if (line?.outcome !== 'unmeasured') return;
    expect(line.reason).toBe('empty_sample');
    // …while a COUNT over the same empty window is a real zero.
    const subjects = report.lines.find(
      (entry) => entry.definition.key === 'eligible_referred_subjects',
    );
    expect(subjects?.outcome).toBe('measured');
  });
});
