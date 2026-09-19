/**
 * Every number this directory is allowed to produce, with its numerator, its
 * denominator and what it cannot see (#1015 W6, W13).
 *
 * ## Why the catalogue exists at all
 *
 * `docs/analytics.md` acceptance 6 is that a metric whose definition is unstated
 * cannot be served, and the sibling domain enforces it from both ends: a read
 * surface goes through `metricByKey` and refuses `undefined`, and a CHECK on
 * `analytics_rollups.metric_key` means an undefined metric cannot even be stored.
 * This domain has no rollup table, so only the first half is available — but the
 * half that matters is the same: a dashboard cannot render "conversion" without
 * rendering what the denominator was, because a digital conversion rate has four
 * plausible denominators and three of them flatter the platform.
 *
 * ## Why the definition type is LOCAL
 *
 * `AnalyticsMetricDefinition` in `@mercaria/shared-types` is the right shape and
 * the wrong vocabulary: its `AnalyticsMetricSource` union names `analytics_events`,
 * `payments`, `orders` and the affiliate reports, and every metric here is sourced
 * from `asset_download_events`, `asset_rights`, `asset_file_inspections` or
 * `ledger_transactions`. Widening that union is a shared-types change this
 * workstream does not own, and inventing a source that maps onto an existing member
 * would make a digital download indistinguishable from a page view in the one field
 * that says where a number came from.
 *
 * ## The rule at the bottom of #1015 W13, which this file is shaped around
 *
 * *"Downloads and fee yield must never become a hidden organic-ranking boost."*
 * Every definition below is a number about a WINDOW and a SCOPE — a store, or the
 * deployment — and `DIGITAL_METRIC_SCOPES` has exactly two members. There is no
 * per-listing, per-offer and per-variant metric in this catalogue, so there is
 * nothing for an ordering engine to join to even if it reached in.
 * `__tests__/analytics-boundaries.test.ts` holds both halves: ranking may not import
 * this directory, and nothing this directory returns is keyed by a thing ranking
 * orders.
 */

/** Where a number comes from. Four tables, named individually. */
export type DigitalMetricSource =
  | 'asset_rights'
  | 'asset_download_events'
  | 'asset_file_inspections'
  | 'ledger_transactions'
  | 'order_items'
  | 'digital_assets'
  | 'analytics_events';

/**
 * Who a number may be computed FOR.
 *
 * Two members, and the absence of a third is the ranking wall: a metric scoped to
 * a listing, an offer, a variant or a canonical product is the shape an ordering
 * engine can consume, and there is no such scope here to declare one in.
 */
export const DIGITAL_METRIC_SCOPES = ['store', 'deployment'] as const;
export type DigitalMetricScope = (typeof DIGITAL_METRIC_SCOPES)[number];

/** One metric, fully stated. */
export interface DigitalMetricDefinition {
  readonly key: string;
  readonly title: string;
  /** Exactly what is counted on top. Empty for a plain count. */
  readonly numerator: string;
  /** Exactly what is counted underneath. Never "all traffic". */
  readonly denominator: string;
  readonly source: DigitalMetricSource;
  readonly scope: readonly DigitalMetricScope[];
  /**
   * What this number CANNOT see — the sibling registry's `attributionLimit`, kept
   * because it is the field that stops a chart being read as more than it is.
   */
  readonly attributionLimit: string;
}

/**
 * The catalogue. #1015 W13's list, one entry each, plus the two creator-facing
 * aggregates W6 asks for.
 */
export const DIGITAL_METRICS: readonly DigitalMetricDefinition[] = Object.freeze([
  {
    key: 'digital_published_assets',
    title: 'Published assets by type',
    numerator: '',
    denominator: 'digital_assets in state `listed` with a current version, grouped by vertical',
    source: 'digital_assets',
    scope: ['store', 'deployment'],
    attributionLimit:
      'An asset, not a listing. One asset bound to two priced variants (Personal and ' +
      'Commercial) is ONE published asset, because ADR 0010 D2 makes the licence choice a ' +
      'variant rather than a second work.',
  },
  {
    key: 'digital_views',
    title: 'Views, free and paid',
    numerator: '',
    denominator:
      'product_page_view events on a listing bound to a digital licence option, split by whether ' +
      'the bound option is free',
    source: 'analytics_events',
    scope: ['store', 'deployment'],
    attributionLimit:
      'Inherits every limit of the analytics domain it is sourced from, including that ' +
      'production collection is OFF until the privacy review in docs/reviews is signed off. ' +
      'Where collection is off this is ZERO and must not be read as "nobody looked".',
  },
  {
    key: 'digital_downloads',
    title: 'Downloads, free and paid',
    numerator: '',
    denominator: 'asset_download_events with kind `completed`',
    source: 'asset_download_events',
    scope: ['store', 'deployment'],
    attributionLimit:
      'Counts TRANSFERS, not people and not purchases. A grant is redeemable five times so a ' +
      'resumed transfer counts more than once, and one right downloading ten files counts ten. ' +
      'It is a measure of delivery load, never of demand.',
  },
  {
    key: 'digital_paid_conversion',
    title: 'Paid conversion',
    numerator: 'paid digital order lines',
    denominator: 'views of listings bound to a PAID digital licence option',
    source: 'order_items',
    scope: ['store', 'deployment'],
    attributionLimit:
      'The denominator is views of PAID options only. Dividing by all views would mix the free ' +
      'catalogue into the rate and make a creator look better for giving things away, which is ' +
      'the off-by-one-concept mistake merchant-analytics.service names about denominators.',
  },
  {
    key: 'digital_gmv',
    title: 'Gross merchandise value',
    numerator: '',
    denominator: 'gross amount of paid digital order lines, PER CURRENCY',
    source: 'order_items',
    scope: ['store', 'deployment'],
    attributionLimit:
      'Per currency and never summed across currencies: the catalog converts nothing and ' +
      '`paid` converts nothing, so one total would be a conversion at an unnamed rate.',
  },
  {
    key: 'digital_realized_fee',
    title: 'Realized platform fee',
    numerator: '',
    denominator: 'Mercaria commission recorded in ledger_transactions for digital lines, per currency',
    source: 'ledger_transactions',
    scope: ['deployment'],
    attributionLimit:
      'The LEDGER is the only record of the commission (ADR 0001 D3), so this is what was ' +
      'actually earned rather than what a schedule says. Deployment scope only — a creator is ' +
      'shown their earnings, and what Mercaria kept is not a figure their dashboard needs.',
  },
  {
    key: 'digital_creator_earnings',
    title: 'Creator earnings',
    numerator: '',
    denominator: 'gross less realized fee on paid digital order lines, per currency',
    source: 'ledger_transactions',
    scope: ['store'],
    attributionLimit:
      'What the books say is owed for lines in this window. Not a payout: a payout is a ' +
      'provider transfer on its own schedule, and reading this as one would make a creator ' +
      'expect money on a day nothing moves.',
  },
  {
    key: 'digital_processing_outcomes',
    title: 'Asset processing success, failure and latency',
    numerator: 'inspections with verdict `measured`',
    denominator: 'inspections, by verdict',
    source: 'asset_file_inspections',
    scope: ['deployment'],
    attributionLimit:
      '`unsupported` is NOT a failure — a `.blend` cannot be measured and saying so is the ' +
      'honest result — so it is counted in its own bucket and excluded from the failure rate. ' +
      'Folding it into failures would make adding an unmeasurable format look like a regression.',
  },
  {
    key: 'digital_download_authorization_errors',
    title: 'Download authorization errors',
    numerator: 'asset_download_events with kind `refused`, by reason',
    denominator: 'asset_download_events',
    source: 'asset_download_events',
    scope: ['deployment'],
    attributionLimit:
      '`no_right` is the normal answer for an unauthenticated probe and is not an error in the ' +
      'operational sense, so the reasons are never summed into one "error rate". ADR 0010 D5 ' +
      'also makes "no right" and "somebody else\'s right" the SAME answer, so the two cannot be ' +
      'separated here and must not be presented as if they could.',
  },
  {
    key: 'digital_refund_dispute_rate',
    title: 'Refund and dispute rate',
    numerator: 'paid digital lines refunded, and paid digital lines disputed, counted separately',
    denominator: 'paid digital lines',
    source: 'asset_rights',
    scope: ['store', 'deployment'],
    attributionLimit:
      'Two numerators over one denominator, never added: a line can be both disputed and then ' +
      'refunded, and one combined rate would double-count exactly the worst cases.',
  },
  {
    key: 'digital_licence_option_mix',
    title: 'Licence option mix',
    numerator: '',
    denominator: 'paid digital lines grouped by update policy, and by licence version',
    source: 'order_items',
    scope: ['store', 'deployment'],
    attributionLimit:
      'Grouped on the update POLICY at deployment scope, because that is a closed three-member ' +
      'tuple and comparable across creators. A licence NAME is a creator\'s own mutable display ' +
      'copy, so the per-name mix is store-scoped only.',
  },
  {
    key: 'digital_geographic_revenue',
    title: 'Revenue by place of supply',
    numerator: '',
    denominator: 'paid digital lines grouped by orders.digital_supply_country, per currency',
    source: 'order_items',
    scope: ['store', 'deployment'],
    attributionLimit:
      'The place of SUPPLY, which is a country established by the consent evidence ADR 0010 D10 ' +
      'permits and never by an IP address. Countries below the cohort floor are pooled unnamed ' +
      '— see `geography.ts`, which states what that does and does not protect.',
  },
]);

const BY_KEY = new Map<string, DigitalMetricDefinition>(
  DIGITAL_METRICS.map((metric) => [metric.key, metric]),
);

/**
 * The definition for a key, or `undefined`.
 *
 * Every read surface calls this and refuses on `undefined`, so a dashboard cannot
 * render a number whose numerator, denominator, source and limits are unstated.
 */
export function digitalMetricByKey(key: string): DigitalMetricDefinition | undefined {
  return BY_KEY.get(key);
}

/** Every definition a CREATOR may see for their own assets. */
export function creatorVisibleDigitalMetrics(): readonly DigitalMetricDefinition[] {
  return DIGITAL_METRICS.filter((metric) => metric.scope.includes('store'));
}
