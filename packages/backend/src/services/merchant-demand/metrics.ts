/**
 * The merchant demand metric registry, as CODE (#86 acceptance 1 and 7).
 *
 * The definitions live in `@mercaria/shared-types` so a dashboard client can
 * render them beside the numbers; what lives here is the machinery that makes
 * them un-fakeable:
 *
 *  - `merchantDemandMetricByKey` — the lookup every read goes through, so a
 *    figure whose definition is unstated cannot be served. With the CHECK on
 *    `merchant_demand_metrics.metric_key` it cannot be STORED either, which is
 *    acceptance 1 approached from both ends.
 *  - `assertMerchantMoneyIsNotTelemetry` — #77 identity rule 8 pointed at this
 *    registry: a money figure whose source is `analytics_events` is a defect in
 *    the registry rather than an invisible one in a chart.
 *  - `assertPreviewPartitionIsTotal` — every metric must be either preview-safe
 *    or preview-forbidden, and being in NEITHER fails. A gate that skips what a
 *    hand-maintained map omits is not a gate.
 */

import {
  MERCHANT_DEMAND_FINANCIAL_SOURCES,
  MERCHANT_DEMAND_METRICS,
  MERCHANT_DEMAND_METRIC_KEYS,
  MERCHANT_DEMAND_PREVIEW_FORBIDDEN_METRIC_KEYS,
  MERCHANT_DEMAND_PREVIEW_METRIC_KEYS,
  type MerchantDemandMetricDefinition,
} from '@mercaria/shared-types';

/** Every definition, by key. */
const BY_KEY = new Map<string, MerchantDemandMetricDefinition>(
  MERCHANT_DEMAND_METRICS.map((metric) => [metric.key, metric]),
);

/**
 * The definition for a key, or `undefined`.
 *
 * Every read surface calls this and refuses on `undefined`, so a merchant
 * cannot be shown a figure whose numerator, denominator, source and attribution
 * limit are unstated — there is nothing to render them FROM.
 */
export function merchantDemandMetricByKey(
  key: string,
): MerchantDemandMetricDefinition | undefined {
  return BY_KEY.get(key);
}

/** The definition for a key, or a thrown error. Used where a miss is a bug. */
export function requireMerchantDemandMetric(key: string): MerchantDemandMetricDefinition {
  const definition = BY_KEY.get(key);
  if (definition === undefined) {
    throw new Error(`merchant demand metric '${key}' has no definition`);
  }
  return definition;
}

/** Every definition, in registry order. */
export function merchantDemandMetrics(): readonly MerchantDemandMetricDefinition[] {
  return MERCHANT_DEMAND_METRICS;
}

/** The definitions a public preview may show. */
export function previewVisibleMetrics(): readonly MerchantDemandMetricDefinition[] {
  const allowed = new Set<string>(MERCHANT_DEMAND_PREVIEW_METRIC_KEYS);
  return MERCHANT_DEMAND_METRICS.filter((metric) => allowed.has(metric.key));
}

/** May this key appear on the unclaimed preview? */
export function isPreviewVisible(key: string): boolean {
  return (MERCHANT_DEMAND_PREVIEW_METRIC_KEYS as readonly string[]).includes(key);
}

/**
 * Which metrics claim money and where their numbers come from.
 *
 * A money figure sourced from telemetry is the erosion #77 identity rule 8
 * names: somebody adds a revenue metric over `analytics_events` because the
 * events are right there and the join is easier. This looks for exactly that.
 */
export function findTelemetryMoneyViolations(): readonly string[] {
  const financial = new Set<string>(MERCHANT_DEMAND_FINANCIAL_SOURCES);
  return MERCHANT_DEMAND_METRICS.filter(
    (metric) => metric.unit === 'money' && !financial.has(metric.source),
  ).map((metric) => metric.key);
}

/**
 * Metrics that are in NEITHER preview list, and metrics that are in BOTH.
 *
 * Returned as data rather than thrown, so the gate can report which key it was
 * and so a vacuity floor can be asserted beside it.
 */
export function findPreviewPartitionViolations(): {
  readonly unclassified: readonly string[];
  readonly overlapping: readonly string[];
} {
  const allowed = new Set<string>(MERCHANT_DEMAND_PREVIEW_METRIC_KEYS);
  const forbidden = new Set<string>(MERCHANT_DEMAND_PREVIEW_FORBIDDEN_METRIC_KEYS);
  return {
    unclassified: MERCHANT_DEMAND_METRIC_KEYS.filter(
      (key) => !allowed.has(key) && !forbidden.has(key),
    ),
    overlapping: MERCHANT_DEMAND_METRIC_KEYS.filter(
      (key) => allowed.has(key) && forbidden.has(key),
    ),
  };
}

/**
 * Every metric that names a seam, so a dashboard can label it.
 *
 * Derived from the DEFINITIONS rather than from `seams.ts`, because the
 * definition is what a client renders — a seam listed in one place and not on
 * its metric would show a figure as measurable when it is not.
 */
export function metricsAwaitingSeams(): readonly { key: string; seam: string }[] {
  return MERCHANT_DEMAND_METRICS.filter((metric) => metric.seam !== undefined).map((metric) => ({
    key: metric.key,
    seam: metric.seam ?? '',
  }));
}
