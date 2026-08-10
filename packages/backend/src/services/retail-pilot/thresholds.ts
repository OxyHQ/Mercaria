/**
 * EVALUATING THE STOP THRESHOLDS (#125 "Stop thresholds").
 *
 * PURE, for `admission.ts`' reason: what makes a threshold trustworthy is that
 * the arithmetic is one function a test can drive over every boundary, and the
 * boundary is exactly where a safety bound gets it wrong.
 *
 * ## A measurement that was not taken is not a passing measurement
 *
 * The failure this module is shaped around is a monitor that reported "no
 * breaches" because it read nothing. A threshold with no measurement is
 * therefore reported as UNMEASURED — a third outcome beside `breached` and
 * `within` — and the caller counts it, because "twelve thresholds, nine
 * measured" is a fact somebody has to see and "no breaches" hides it. It is the
 * `catalog_backfill_runs` vacuity floor applied to a safety bound.
 *
 * ## `>` and not `>=`, stated because the difference is one occurrence
 *
 * A breach is `observed > threshold`. So a one-occurrence stop — #119 §10's
 * non-EU dispatch — is written with a threshold of ZERO, and fires on the
 * first. Writing it as `1` with `>=` would look identical and fire on the same
 * event, but then every RATE threshold would need re-reading too, and "> 2% of
 * orders" is what #125 says. One comparator, one reading, no per-metric
 * exception.
 */

import type {
  RetailPilotStopMetric,
  RetailPilotStopScope,
  RetailPilotThresholdUnit,
} from '@mercaria/shared-types';

/** One published threshold, as a cohort version stores it. */
export interface RetailPilotThreshold {
  readonly metric: RetailPilotStopMetric;
  readonly unit: RetailPilotThresholdUnit;
  readonly thresholdValue: number;
  /** The trailing window. `0` means "ever", for a one-occurrence stop. */
  readonly windowHours: number;
  readonly scope: RetailPilotStopScope;
}

/**
 * What a monitor observed for one metric, in the threshold's OWN unit.
 *
 * The unit is carried on the measurement as well as the threshold, and they are
 * compared: a rate measured in basis points against a threshold in minor units
 * is not a smaller number, it is a different question, and comparing them is
 * how "> €50/week" gets read as "> 50 basis points" and never fires.
 */
export interface RetailPilotMeasurement {
  readonly metric: RetailPilotStopMetric;
  readonly unit: RetailPilotThresholdUnit;
  readonly value: number;
  /** WHICH supplier, market or SKU. Empty for a pilot-wide measurement. */
  readonly scopeRef: string;
  /** How many observations the value was derived from — the vacuity floor. */
  readonly sampleSize: number;
}

/** One threshold's verdict. */
export type RetailPilotThresholdOutcome =
  | {
      readonly outcome: 'breached';
      readonly metric: RetailPilotStopMetric;
      readonly scope: RetailPilotStopScope;
      readonly scopeRef: string;
      readonly observedValue: number;
      readonly thresholdValue: number;
    }
  | { readonly outcome: 'within'; readonly metric: RetailPilotStopMetric }
  | {
      readonly outcome: 'unmeasured';
      readonly metric: RetailPilotStopMetric;
      readonly reason: 'no_measurement' | 'unit_mismatch' | 'empty_sample';
    };

/**
 * The smallest sample a RATE may be read from.
 *
 * A 2% threshold against three orders fires on the first failure, which is not
 * a signal about the pilot — it is a signal about three orders. Counts and
 * money amounts have no such floor: one product-safety incident is one
 * incident whatever the denominator, and €50 absorbed is €50.
 */
const MINIMUM_RATE_SAMPLE = 20;

/**
 * Evaluate every published threshold against what was measured.
 *
 * Returns one outcome per THRESHOLD, never per measurement — so a metric nobody
 * measured is visible as `unmeasured` rather than absent from the result, which
 * is the difference between a monitor that is quiet and a monitor that is
 * broken.
 */
export function evaluateStopThresholds(
  thresholds: readonly RetailPilotThreshold[],
  measurements: readonly RetailPilotMeasurement[],
): readonly RetailPilotThresholdOutcome[] {
  return thresholds.map((threshold) => {
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
 * The thresholds #119 §10 recorded for the Printful pilot, as a publishable set.
 *
 * DATA rather than a migration, and the distinction is #65's ruleset one: a
 * threshold set written by a migration is a policy nobody signed. An operator
 * publishes these with a cohort version, and the numbers come from the decision
 * document rather than from this file's author — so a reviewer can compare the
 * two and the pilot's bounds have a named source.
 *
 * `checkout_cost_change` and the four #125 names that §10 did not quantify
 * (`tracking_failure`, `cancellation_rejection`, `return_or_defect_rate`,
 * `customer_support_volume`, `supplier_credit_mismatch`,
 * `payment_refund_or_dispute_rate`) are deliberately ABSENT from this
 * recommendation rather than given a number invented here. A published cohort
 * must carry all thirteen — the operator surface refuses an incomplete set —
 * so the gap is a decision somebody has to make and record, not one this file
 * makes silently.
 */
export const PRINTFUL_PILOT_RECOMMENDED_THRESHOLDS: readonly RetailPilotThreshold[] = [
  // "> 2% of retail orders, trailing 7 days" (#119 §10).
  { metric: 'supplier_stock_rejection', unit: 'rate_bps', thresholdValue: 200, windowHours: 168, scope: 'supplier' },
  { metric: 'procurement_timeout_or_ambiguity', unit: 'rate_bps', thresholdValue: 200, windowHours: 168, scope: 'supplier' },
  // "> €50/week" absorbed negative variance.
  { metric: 'negative_realized_margin', unit: 'minor_units', thresholdValue: 5_000, windowHours: 168, scope: 'pilot' },
  // "> 10% of shipments, trailing 14 days".
  { metric: 'late_dispatch', unit: 'rate_bps', thresholdValue: 1_000, windowHours: 336, scope: 'supplier' },
  // "One occurrence" — ADR 0004 D2.9, the bound the architecture treats as absolute.
  { metric: 'non_eu_dispatch_origin', unit: 'count', thresholdValue: 0, windowHours: 0, scope: 'pilot' },
  // "One occurrence — delist immediately", so the scope is the SKU.
  { metric: 'product_safety_incident', unit: 'count', thresholdValue: 0, windowHours: 0, scope: 'sku' },
];
