/**
 * EVALUATING THE STOP THRESHOLDS (#149 "Stop thresholds").
 *
 * PURE, for `admission.ts`' reason: what makes a safety bound trustworthy is
 * that the arithmetic is one function a test can drive over every boundary, and
 * the boundary is exactly where a bound gets it wrong.
 *
 * ## A measurement that was not taken is not a passing measurement
 *
 * The failure this module is shaped around is a monitor that reported "no
 * breaches" because it read nothing. A threshold with no measurement is
 * therefore reported UNMEASURED — a third outcome beside `breached` and
 * `within` — and the caller counts it, because "twelve thresholds, four
 * measured" is a fact somebody has to see and "no breaches" hides it. It is the
 * `catalog_backfill_runs` vacuity floor applied to a safety bound.
 *
 * `no_producer` is kept apart from `no_measurement`, and the distinction is the
 * whole reason this domain can be honest about itself: the first says NOTHING
 * in this repository can compute the number today and names the issue that
 * would, the second says nobody supplied one this time. Collapsing them makes a
 * permanent gap look like a transient one, and a permanent gap in a stop
 * condition is a pilot whose review has a hole in it.
 *
 * ## `>` and not `>=`, stated because the difference is one occurrence
 *
 * A breach is `observed > threshold`. So a one-occurrence stop — a privacy
 * incident, a critical security finding — is written with a threshold of ZERO
 * and fires on the first. Writing it as `1` with `>=` would look identical and
 * fire on the same event, but then every RATE threshold would need re-reading
 * too, and "> 2% of conversions" is what #149 says. One comparator, one
 * reading, no per-metric exception.
 */

import {
  REFERRAL_PILOT_MEASURES,
  REFERRAL_PILOT_STOP_METRIC_MEASURES,
  REFERRAL_PILOT_STOP_ONLY_MEASURES,
  type ReferralPilotMeasureDefinition,
  type ReferralPilotStopMetric,
  type ReferralPilotStopScope,
  type ReferralPilotThresholdUnit,
  type ReferralPilotUnmeasuredReason,
} from '@mercaria/shared-types';

/** One published threshold, as a cohort version stores it. */
export interface ReferralPilotThreshold {
  readonly metric: ReferralPilotStopMetric;
  readonly unit: ReferralPilotThresholdUnit;
  readonly thresholdValue: number;
  /** The trailing window. `0` means "ever", for a one-occurrence stop. */
  readonly windowHours: number;
  readonly scope: ReferralPilotStopScope;
}

/**
 * What a monitor observed for one metric, in the threshold's OWN unit.
 *
 * The unit is carried on the measurement as well as the threshold, and they are
 * compared: a rate measured in basis points against a threshold in minor units
 * is not a smaller number, it is a different question, and comparing them is
 * how "> €500 net negative" gets read as "> 500 basis points" and never fires.
 */
export interface ReferralPilotMeasurement {
  readonly metric: ReferralPilotStopMetric;
  readonly unit: ReferralPilotThresholdUnit;
  readonly value: number;
  /** WHICH partner or market. Empty for a pilot-wide measurement. */
  readonly scopeRef: string;
  /** How many observations the value was derived from — the vacuity floor. */
  readonly sampleSize: number;
}

/** One threshold's verdict. */
export type ReferralPilotThresholdOutcome =
  | {
      readonly outcome: 'breached';
      readonly metric: ReferralPilotStopMetric;
      readonly scope: ReferralPilotStopScope;
      readonly scopeRef: string;
      readonly observedValue: number;
      readonly thresholdValue: number;
    }
  | { readonly outcome: 'within'; readonly metric: ReferralPilotStopMetric }
  | {
      readonly outcome: 'unmeasured';
      readonly metric: ReferralPilotStopMetric;
      readonly reason: ReferralPilotUnmeasuredReason;
      /** The issue that owes the producer, when the reason is `no_producer`. */
      readonly seam?: string;
    };

/**
 * The smallest sample a RATE may be read from.
 *
 * A 2% threshold against three conversions fires on the first refund, which is
 * not a signal about the pilot — it is a signal about three conversions. Counts,
 * money amounts and durations have no such floor: one privacy incident is one
 * incident whatever the denominator, and €500 absorbed is €500.
 */
const MINIMUM_RATE_SAMPLE = 20;

/** Every measure definition, including the three that exist only for a stop. */
const ALL_MEASURES: readonly ReferralPilotMeasureDefinition[] = [
  ...REFERRAL_PILOT_MEASURES,
  ...REFERRAL_PILOT_STOP_ONLY_MEASURES,
];

/**
 * The measure a stop metric is read from, or `undefined` if the map names one
 * that does not exist — which `measures.test.ts` fails the build on.
 */
export function measureForStopMetric(
  metric: ReferralPilotStopMetric,
): ReferralPilotMeasureDefinition | undefined {
  const key = REFERRAL_PILOT_STOP_METRIC_MEASURES[metric];
  return ALL_MEASURES.find((measure) => measure.key === key);
}

/**
 * Evaluate every published threshold against what was measured.
 *
 * Returns one outcome per THRESHOLD, never per measurement — so a metric nobody
 * measured is visible as `unmeasured` rather than absent from the result, which
 * is the difference between a monitor that is quiet and a monitor that is
 * broken.
 *
 * The `no_producer` check runs FIRST, before "did anybody supply one". A
 * measurement handed in for a metric this repository cannot compute is treated
 * as absent rather than believed: the honest state of eight of #149's twelve is
 * that nothing produces them, and accepting a hand-supplied number for one
 * would let a pilot report a clean bill of health it has no evidence for. An
 * operator who genuinely holds such a figure records it through the
 * `operator_entry` producer, which IS a producer.
 */
export function evaluateReferralPilotThresholds(
  thresholds: readonly ReferralPilotThreshold[],
  measurements: readonly ReferralPilotMeasurement[],
): readonly ReferralPilotThresholdOutcome[] {
  return thresholds.map((threshold) => {
    const measure = measureForStopMetric(threshold.metric);
    if (measure === undefined || measure.producer === 'unavailable') {
      return {
        outcome: 'unmeasured',
        metric: threshold.metric,
        reason: 'no_producer',
        ...(measure?.seam === undefined ? {} : { seam: measure.seam }),
      };
    }
    const measurement = measurements.find((entry) => entry.metric === threshold.metric);
    if (measurement === undefined) {
      return { outcome: 'unmeasured', metric: threshold.metric, reason: 'no_measurement' };
    }
    if (measurement.unit !== threshold.unit) {
      return { outcome: 'unmeasured', metric: threshold.metric, reason: 'unit_mismatch' };
    }
    if (measurement.sampleSize <= 0) {
      return { outcome: 'unmeasured', metric: threshold.metric, reason: 'empty_sample' };
    }
    if (threshold.unit === 'rate_bps' && measurement.sampleSize < MINIMUM_RATE_SAMPLE) {
      return { outcome: 'unmeasured', metric: threshold.metric, reason: 'empty_sample' };
    }
    if (measurement.value > threshold.thresholdValue) {
      return {
        outcome: 'breached',
        metric: threshold.metric,
        scope: threshold.scope,
        scopeRef: threshold.scope === 'pilot' ? '' : measurement.scopeRef,
        observedValue: measurement.value,
        thresholdValue: threshold.thresholdValue,
      };
    }
    return { outcome: 'within', metric: threshold.metric };
  });
}

/**
 * The bounds ADR 0005 recorded for the launch pilots, as a publishable set.
 *
 * DATA rather than a migration, and the distinction is #65's ruleset one: a
 * threshold set written by a migration is a policy nobody signed. An operator
 * publishes these with a cohort version, and the numbers come from the ADR
 * rather than from this file's author — so a reviewer can compare the two and
 * the pilot's bounds have a named source.
 *
 * FIVE of the twelve, and the other seven are deliberately ABSENT rather than
 * given a number invented here. ADR 0005 D17 quantified exactly four fraud
 * thresholds and D16 the budget; #149's other seven are conditions it names
 * without numbers. A published cohort must carry all twelve — the operator
 * surface refuses an incomplete set — so the gap is a decision somebody has to
 * make and record, not one this file makes silently.
 */
export const REFERRAL_PILOT_RECOMMENDED_THRESHOLDS: readonly ReferralPilotThreshold[] = [
  // ADR 0005 D17: "referred-cohort refund rate > 30% over trailing 30 days".
  {
    metric: 'refund_or_dispute_rate',
    unit: 'rate_bps',
    thresholdValue: 3_000,
    windowHours: 720,
    scope: 'pilot',
  },
  // ADR 0005 D17's dispute rate, > 2%, on the same trailing window.
  {
    metric: 'attribution_conflict_rate',
    unit: 'rate_bps',
    thresholdValue: 200,
    windowHours: 720,
    scope: 'partner',
  },
  // A self-referral or account-farm intervention rate above 1% of attributions
  // is D17's velocity posture expressed as an outcome rather than a threshold
  // on touches, which #148 already owns per partner.
  {
    metric: 'self_referral_or_account_farm_rate',
    unit: 'rate_bps',
    thresholdValue: 100,
    windowHours: 720,
    scope: 'partner',
  },
  // ADR 0005 D16: the program-level monthly ceiling. Expressed as utilization
  // of the cohort's published budget, so the number is the same whatever the
  // budget is.
  {
    metric: 'program_budget_exhaustion',
    unit: 'rate_bps',
    thresholdValue: 9_000,
    windowHours: 0,
    scope: 'pilot',
  },
  // One occurrence. #149 stop threshold 8, and the reason `>` is strict.
  {
    metric: 'privacy_incident',
    unit: 'count',
    thresholdValue: 0,
    windowHours: 0,
    scope: 'pilot',
  },
];
