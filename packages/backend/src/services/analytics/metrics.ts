/**
 * The metric registry, as CODE (#77 metrics, acceptance 6).
 *
 * The definitions themselves live in `@mercaria/shared-types` so a dashboard
 * client can render them beside the numbers; what lives here is the machinery
 * that makes them computable and the wiring that makes them un-fakeable:
 *
 *  - `metricByKey` — the lookup every read surface goes through, so a metric
 *    with no definition cannot be served. Combined with the CHECK on
 *    `analytics_rollups.metric_key`, a number whose definition is unstated
 *    cannot even be STORED, which is acceptance 6 approached from both ends.
 *  - `EVENT_METRIC_SPECS` — which event types feed which metric, for the
 *    event-sourced ones.
 *  - `assertFinancialMetricsAreNotTelemetry` — the guard that identity rule 8
 *    ("financial truth comes from payments, orders, refunds and affiliate
 *    reports, not from client telemetry") is a property of the registry rather
 *    than of whoever writes the next metric.
 */

import type { AnalyticsEventType, AnalyticsMetricDefinition } from '@mercaria/shared-types';
import {
  ANALYTICS_FINANCIAL_METRIC_SOURCES,
  ANALYTICS_METRICS,
  ANALYTICS_SEARCH_SUCCESS_ACTIONS,
} from '@mercaria/shared-types';

/** Every definition, by key. */
const BY_KEY = new Map<string, AnalyticsMetricDefinition>(
  ANALYTICS_METRICS.map((metric) => [metric.key, metric]),
);

/**
 * The definition for a key, or `undefined`.
 *
 * Every read surface calls this and refuses on `undefined`. A dashboard cannot
 * therefore render a metric whose numerator, denominator, window, source and
 * freshness are unstated — there is nothing to render them FROM.
 */
export function metricByKey(key: string): AnalyticsMetricDefinition | undefined {
  return BY_KEY.get(key);
}

/** Every definition a merchant may see for their own store. */
export function merchantVisibleMetrics(): readonly AnalyticsMetricDefinition[] {
  return ANALYTICS_METRICS.filter((metric) => metric.merchantVisible);
}

/**
 * How an event-sourced metric is counted from `analytics_events`.
 *
 * A ratio of two event-type SETS. That covers every metric whose source is
 * `analytics_events` except search success, whose numerator is a windowed
 * self-join and therefore has its own repository query — a shape this
 * declaration cannot express, and pretending otherwise would have meant a
 * `custom: true` flag that means "ignore everything above".
 */
export interface EventMetricSpec {
  readonly metricKey: string;
  readonly numeratorTypes: readonly AnalyticsEventType[];
  readonly denominatorTypes: readonly AnalyticsEventType[];
}

/**
 * The event-sourced metrics.
 *
 * `product_to_offer_selection_rate` and `native_add_to_cart_rate` use the same
 * denominator (`product_page_view`) while their definitions narrow it further —
 * to products with an eligible offer, and to products with a NATIVE offer. That
 * narrowing is not expressible over event types alone and is stated in each
 * definition's `attributionLimit` instead of being silently applied: a
 * denominator that says one thing in prose and another in SQL is worse than one
 * that admits it is broader than ideal.
 */
export const EVENT_METRIC_SPECS: readonly EventMetricSpec[] = [
  {
    metricKey: 'zero_result_rate',
    numeratorTypes: ['search_zero_results'],
    denominatorTypes: ['search_submitted'],
  },
  {
    metricKey: 'search_to_product_click_rate',
    numeratorTypes: ['search_result_click'],
    denominatorTypes: ['search_result_impression'],
  },
  {
    metricKey: 'product_to_offer_selection_rate',
    numeratorTypes: ['offer_selected'],
    denominatorTypes: ['product_page_view'],
  },
  {
    metricKey: 'external_click_through_rate',
    numeratorTypes: ['external_outbound_click'],
    denominatorTypes: ['offer_impression'],
  },
  {
    metricKey: 'native_add_to_cart_rate',
    numeratorTypes: ['native_add_to_cart'],
    denominatorTypes: ['product_page_view'],
  },
  {
    metricKey: 'order_portal_delivery_success',
    numeratorTypes: ['guest_recovery_exchanged'],
    denominatorTypes: ['guest_recovery_requested'],
  },
  {
    metricKey: 'oxy_claim_funnel',
    numeratorTypes: ['guest_claim_completed'],
    denominatorTypes: ['guest_claim_offered'],
  },
  {
    metricKey: 'guest_eligibility_coverage',
    numeratorTypes: ['guest_eligibility_accepted'],
    denominatorTypes: ['guest_eligibility_accepted', 'guest_eligibility_rejected'],
  },
];

/** The qualifying actions for search success, re-exported for the rollup. */
export const SEARCH_SUCCESS_ACTIONS: readonly AnalyticsEventType[] = [
  ...ANALYTICS_SEARCH_SUCCESS_ACTIONS,
];

/**
 * Which metrics claim a financial source, and which of those genuinely have
 * one.
 *
 * Identity rule 8 is easy to state and easy to erode: someone adds a "revenue"
 * metric sourced from `analytics_events` because the events are right there and
 * the join is easier. This is the shape of that erosion, so the guard looks for
 * exactly it — a metric whose KEY talks about money while its SOURCE is
 * telemetry.
 *
 * Deliberately keyed on the vocabulary rather than on a per-metric flag: a flag
 * is a thing to forget, and the words below are the ones a money metric is
 * actually called.
 */
export const FINANCIAL_METRIC_KEY_MARKERS = [
  'gmv',
  'revenue',
  'commission',
  'payment',
  'paid',
  'conversion',
  'refund',
  'checkout',
] as const;

/** A metric whose key claims money but whose source is telemetry. */
export interface FinancialSourceViolation {
  readonly metricKey: string;
  readonly source: string;
}

/**
 * Every metric whose key names money while its source is telemetry.
 *
 * Returns the violations rather than throwing, so the test can name each one
 * and the mutation self-test can prove the detector detects.
 */
export function findFinancialSourceViolations(
  metrics: readonly AnalyticsMetricDefinition[] = ANALYTICS_METRICS,
): readonly FinancialSourceViolation[] {
  const financial = new Set<string>(ANALYTICS_FINANCIAL_METRIC_SOURCES);
  return metrics
    .filter((metric) => metricKeyClaimsMoney(metric.key) && !financial.has(metric.source))
    .map((metric) => ({ metricKey: metric.key, source: metric.source }));
}

/**
 * Whether a metric key names money.
 *
 * Exported so the gate can assert a VACUITY FLOOR — a marker list that matched
 * nothing would make `findFinancialSourceViolations` return `[]` for the best
 * possible reason and the worst possible cause.
 */
export function metricKeyClaimsMoney(key: string): boolean {
  return FINANCIAL_METRIC_KEY_MARKERS.some((marker) => key.includes(marker));
}
