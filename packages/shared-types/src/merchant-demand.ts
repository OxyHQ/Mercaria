/**
 * Merchant demand facts, reporting snapshots and the acquisition pipeline (#86).
 *
 * Three audiences, one vocabulary. An UNCLAIMED merchant may be shown a
 * bounded, rounded proof that Mercaria sends it demand; a CLAIMED merchant sees
 * its own aggregate demand in full; an operator sees a scored acquisition
 * pipeline. All three read the same {@link MERCHANT_DEMAND_METRICS} registry,
 * so a figure on the public preview and a figure on the merchant dashboard are
 * the same measurement with different disclosure applied rather than two
 * computations that can disagree.
 *
 * ## Four labels that may never be merged, and the type is what stops it
 *
 * #86 asks that "affiliate commission, external order value, native GMV and
 * inferred demand" stay separately labelled. Every metric therefore carries a
 * {@link MerchantDemandMetricKind}, and there is no `total`, `sum`, `combined`
 * or `revenue` field ANYWHERE in this file or in the tables that store these
 * rows — an addition across kinds has nowhere to be written down. That is the
 * `DualMoney` decision applied to reporting: two amounts that mean different
 * things get two fields, never one with a note beside it.
 *
 * ## Unknown is never zero, and never a soft yes
 *
 * {@link MerchantDemandValue} is a three-way discriminated union whose
 * `unavailable` branch has NO measure to read and whose `suppressed` branch has
 * no count. A surface that wants to render a number has to write out the branch
 * where there is not one. That matters more here than almost anywhere else in
 * the codebase: a merchant demand figure reading 0 and a merchant demand figure
 * that cannot yet be measured look identical on a chart and mean opposite
 * things — the first says nobody wanted your products and the second says we
 * have not built the counter.
 *
 * The discriminants are STRINGS. `@mercaria/backend` compiles without
 * `strictNullChecks`, where TypeScript does not narrow a union on the
 * truthiness of a boolean-literal discriminant (#68's finding, hit again by
 * #110 and #122).
 *
 * ## Outbound clicks are never labelled sales
 *
 * `human_outbound_clicks` is an `observed_interaction`;
 * `network_reported_conversions` is an `affiliate_conversion` sourced from the
 * network's own report. They are different kinds, so nothing can add them, and
 * the copy vocabulary ({@link MERCHANT_DEMAND_COUNT_NOUNS}) has no member that
 * would let a click be rendered with a sales noun.
 */

import { ANALYTICS_MERCHANT_MIN_COHORT } from './analytics';
import type { CurrencyCode } from './money';

/**
 * The event-interpretation contract version stamped on every snapshot.
 *
 * A code CONSTANT rather than a table, for `CATALOG_BACKFILL_MAPPING_VERSION`'s
 * reason: how an event becomes a demand fact is a PROCEDURE this repository
 * ships, and a table would let somebody publish a version whose rules nobody
 * released. Bumping it means a snapshot taken before and one taken after are
 * not comparable, and the snapshot says so by carrying the version it was built
 * under.
 */
export const MERCHANT_DEMAND_EVENT_POLICY_VERSION = '2026-08-10.1';

/**
 * The attribution contract version stamped on every snapshot.
 *
 * Separate from the event policy because the two change for different reasons:
 * the event policy moves when a new event type feeds a metric, the attribution
 * policy moves when the rule that ties an event to a MERCHANT changes (today:
 * "the merchant's CURRENT offer set", see
 * {@link MERCHANT_DEMAND_ATTRIBUTION_LIMITS}).
 */
export const MERCHANT_DEMAND_ATTRIBUTION_POLICY_VERSION = '2026-08-10.1';

/**
 * The labels a figure carries, and which may never be added together.
 *
 * Not a presentation concern. Two of these are money that Mercaria did not
 * receive and did not measure (`affiliate_commission`, `external_order_value`
 * come from a NETWORK's revisable report), one is money that moved through
 * Mercaria's own ledger (`native_gmv`), and one is not money at all
 * (`inferred_demand` counts intent). A single "revenue" line over any two of
 * them would be a number nobody could defend to the merchant it was shown to.
 */
export const MERCHANT_DEMAND_METRIC_KINDS = [
  /** Something a person did on a Mercaria surface. Never a sale. */
  'observed_interaction',
  /** A conversion the affiliate NETWORK reported. Revisable for weeks. */
  'affiliate_conversion',
  /** Commission the network reported. Money Mercaria was told about. */
  'affiliate_commission',
  /** Basket value the network reported for an order placed on the merchant's own site. */
  'external_order_value',
  /** Money that moved through a Mercaria native order. From `orders`, never telemetry. */
  'native_gmv',
  /** Intent, not purchase: saves, unmet demand, products with no native offer. */
  'inferred_demand',
  /** How much of a question Mercaria can answer at all. */
  'coverage',
  /** Whether the merchant's catalogue is fresh enough to sell from. */
  'catalog_health',
] as const;

/** One of {@link MERCHANT_DEMAND_METRIC_KINDS}. */
export type MerchantDemandMetricKind = (typeof MERCHANT_DEMAND_METRIC_KINDS)[number];

/**
 * The kinds that carry MONEY.
 *
 * Rendered into the `merchant_demand_metrics` CHECK, so a count metric cannot
 * be stored with an amount and a money metric cannot be stored without a
 * currency. Money never mixes currencies here for the reason reports do not:
 * one row, one currency, named on the row.
 */
export const MERCHANT_DEMAND_MONEY_METRIC_KINDS = [
  'affiliate_commission',
  'external_order_value',
  'native_gmv',
] as const;

/** How a metric is measured. */
export const MERCHANT_DEMAND_METRIC_UNITS = ['count', 'money', 'rate'] as const;

/** One of {@link MERCHANT_DEMAND_METRIC_UNITS}. */
export type MerchantDemandMetricUnit = (typeof MERCHANT_DEMAND_METRIC_UNITS)[number];

/**
 * Where a demand figure comes from.
 *
 * The #77 posture, narrowed: `analytics_events` is telemetry and everything
 * else is a durable record somebody else owns. A money metric sourced from
 * telemetry is refused by `assertMerchantMoneyIsNotTelemetry`.
 */
export const MERCHANT_DEMAND_SOURCES = [
  'analytics_events',
  'orders',
  'offers',
  'affiliate_reports',
  'product_saves',
  'price_signals',
  'price_alerts',
  'analytics_search_queries',
] as const;

/** One of {@link MERCHANT_DEMAND_SOURCES}. */
export type MerchantDemandSource = (typeof MERCHANT_DEMAND_SOURCES)[number];

/** The durable, non-telemetry sources — the ones a money figure may name. */
export const MERCHANT_DEMAND_FINANCIAL_SOURCES = ['orders', 'affiliate_reports'] as const;

/**
 * The channel a figure is sliced by (#86 snapshot item 7).
 *
 * `''` on a stored row means NOT SLICED, the `analytics_rollups` convention: a
 * nullable dimension breaks the bucket unique outright, because Postgres treats
 * NULLs as distinct.
 */
export const MERCHANT_DEMAND_CHANNELS = ['native', 'external'] as const;

/** One of {@link MERCHANT_DEMAND_CHANNELS}. */
export type MerchantDemandChannel = (typeof MERCHANT_DEMAND_CHANNELS)[number];

/**
 * Why a figure has no value.
 *
 * Every one of these is a DIFFERENT thing to do about it, which is why they are
 * not one `unavailable` state: `awaiting_seam` is somebody else's issue,
 * `collection_disabled` is this deployment's own configuration,
 * `merchant_scope_absent_on_event` is a dimension the emitter never carried,
 * and the last two are decisions that a figure must NOT be produced.
 */
export const MERCHANT_DEMAND_UNAVAILABLE_REASONS = [
  /** The events or reports exist in the vocabulary and nothing emits them yet. */
  'awaiting_seam',
  /** `ANALYTICS_COLLECTION_MODE=off` — there are no events to count, which is not zero demand. */
  'collection_disabled',
  /** The event is emitted and carries no merchant or store dimension to scope it by. */
  'merchant_scope_absent_on_event',
  /** #86 fact 8: the merchant's relationship to the demand cannot be defended. */
  'relationship_not_defensible',
  /** #79 makes "who is watching this product" unrepresentable, deliberately. */
  'alert_subject_counts_unrepresentable',
  /** The merchant has no active native store link, so a native figure would be about nothing. */
  'no_native_activation',
] as const;

/** One of {@link MERCHANT_DEMAND_UNAVAILABLE_REASONS}. */
export type MerchantDemandUnavailableReason =
  (typeof MERCHANT_DEMAND_UNAVAILABLE_REASONS)[number];

/** The noun a count may be rendered with. There is no sales noun in this list. */
export const MERCHANT_DEMAND_COUNT_NOUNS = [
  'searches',
  'views',
  'impressions',
  'visits',
  'clicks',
  'saves',
  'products',
  'orders',
] as const;

/** One of {@link MERCHANT_DEMAND_COUNT_NOUNS}. */
export type MerchantDemandCountNoun = (typeof MERCHANT_DEMAND_COUNT_NOUNS)[number];

/**
 * One demand metric, completely stated.
 *
 * #86 acceptance 1 ("every displayed metric is reproducible from documented
 * durable events") and acceptance 7 ("dashboards name time range, freshness,
 * denominator and known limitations") are enforced by the SHAPE: there is no
 * optional field here except `seam`, so a metric with an unstated denominator
 * does not compile.
 */
export interface MerchantDemandMetricDefinition {
  /** Stable key. Stored on every metric row, so renaming one is a migration. */
  readonly key: string;
  /** What a reader sees. */
  readonly title: string;
  /** The label that may never be merged with another. */
  readonly kind: MerchantDemandMetricKind;
  readonly unit: MerchantDemandMetricUnit;
  /** The noun a count is rendered with. `impressions` is not `sales`. */
  readonly noun: MerchantDemandCountNoun;
  /** Exactly what is counted on top. */
  readonly numerator: string;
  /** Exactly what is counted underneath. Never "all traffic". */
  readonly denominator: string;
  /** Which durable record it is read from. */
  readonly source: MerchantDemandSource;
  /** Whether bot, preview and internal traffic are excluded. */
  readonly humanOnly: boolean;
  /** Whether the figure is subject to the disclosure floor. */
  readonly thresholded: boolean;
  /** What this metric cannot tell you. Rendered beside it, always. */
  readonly attributionLimit: string;
  /**
   * The issue that owes the events, reports or ports this metric needs.
   *
   * A metric with a seam is LISTED, answers `unavailable` and says which issue
   * owes it — the difference between "not measured yet" and "measured as
   * nothing". `undefined` means the metric is computable today.
   */
  readonly seam?: string;
}

/**
 * The attribution rules every figure in this domain is subject to, stated once.
 *
 * Referenced by the definitions below rather than restated in each, so a change
 * to the rule cannot leave nineteen prose copies disagreeing about it.
 */
export const MERCHANT_DEMAND_ATTRIBUTION_LIMITS = Object.freeze({
  /**
   * An event names a canonical product, not a merchant. The merchant's demand
   * is therefore measured over the products it CURRENTLY offers — which is what
   * #86 fact 1 asks for in those words, and which means a product added
   * yesterday contributes views from earlier in the window.
   */
  currentOfferSet:
    'Attributed to the products this merchant offers NOW, so a product added during ' +
    'the window contributes interactions from before it was added, and a product ' +
    'withdrawn during the window contributes none.',
  /** Network reports are revisable for weeks after the click that produced them. */
  networkRevisable:
    'Network-reported figures are the network’s own and are revised for weeks; a ' +
    'later correction changes this number and a superseding snapshot records it.',
  /** A click is not a sale, and dividing the two would produce a moving ratio. */
  clickNotSale:
    'A click is a visit Mercaria sent, never a sale. It is never divided into a ' +
    'network conversion: the report is revisable and the click is not, so the ratio ' +
    'would move without either input being wrong.',
  /**
   * A product-composed figure and its breakdown are ONE partition, so the
   * difference between them can never be one withheld product.
   */
  composedFromRows:
    'Composed from the product breakdown beside it: the disclosed rows plus at most one ' +
    'residual over the withheld ones. When too few products are withheld for a residual to ' +
    'hide them, it is folded away and this counts the disclosed rows only — which the ' +
    'figure’s basis states.',
  /** Intent is not purchase. */
  intentNotPurchase:
    'Intent, not purchase. A save or an unmet search says somebody wanted the thing ' +
    'and says nothing about whether they bought it, here or anywhere.',
});

/**
 * Every merchant demand metric #86 names, defined once.
 *
 * The order follows the issue's "Merchant demand facts" list 1–10 so the two can
 * be checked against each other without a mapping table.
 */
export const MERCHANT_DEMAND_METRICS: readonly MerchantDemandMetricDefinition[] = [
  // 1. Search-result impressions for products the merchant currently offers.
  {
    key: 'search_result_impressions',
    title: 'Search-result impressions',
    kind: 'observed_interaction',
    unit: 'count',
    noun: 'impressions',
    numerator:
      '`search_result_impression` events naming a canonical product this merchant currently offers',
    denominator: 'The same events across the whole marketplace in the window',
    source: 'analytics_events',
    humanOnly: true,
    thresholded: true,
    attributionLimit: MERCHANT_DEMAND_ATTRIBUTION_LIMITS.currentOfferSet,
    // A search-result impression is a viewport fact only a browser knows, and
    // the storefront has no analytics client. Deriving it server-side from "the
    // page was served" would count rows nobody scrolled to.
    seam: '#111',
  },
  // 2. Canonical product-page views with an eligible merchant offer.
  {
    key: 'product_page_views_with_offer',
    title: 'Product-page views with one of your offers',
    kind: 'observed_interaction',
    unit: 'count',
    noun: 'views',
    numerator:
      '`product_page_view` events on canonical products this merchant currently offers',
    denominator: 'All `product_page_view` events in the window',
    source: 'analytics_events',
    humanOnly: true,
    thresholded: true,
    attributionLimit:
      `${MERCHANT_DEMAND_ATTRIBUTION_LIMITS.currentOfferSet} ` +
      MERCHANT_DEMAND_ATTRIBUTION_LIMITS.composedFromRows,
  },
  // 3. Offer impressions.
  {
    key: 'offer_impressions',
    title: 'Your offers shown',
    kind: 'observed_interaction',
    unit: 'count',
    noun: 'impressions',
    numerator:
      '`offer_impression` events naming this merchant, attributed to a canonical product ' +
      'directly or through the variant they name',
    denominator: 'All `offer_impression` events in the window',
    source: 'analytics_events',
    humanOnly: true,
    thresholded: true,
    attributionLimit:
      'One event per offer SERVED, not per offer seen: a comparison list is rendered ' +
      `whole, so an offer below the fold is counted. ${MERCHANT_DEMAND_ATTRIBUTION_LIMITS.composedFromRows}`,
  },
  // 4. Human outbound clicks to the merchant.
  {
    key: 'human_outbound_clicks',
    title: 'Visits Mercaria sent you',
    kind: 'observed_interaction',
    unit: 'count',
    noun: 'visits',
    numerator: '`external_outbound_click` events naming this merchant, human traffic only',
    denominator: '`offer_impression` events naming this merchant',
    source: 'analytics_events',
    humanOnly: true,
    thresholded: true,
    attributionLimit: MERCHANT_DEMAND_ATTRIBUTION_LIMITS.clickNotSale,
    // The redirect itself is #37's; until it exists there is no click to count.
    seam: '#37',
  },
  // 5. Network-reported conversions and commission.
  {
    key: 'network_reported_conversions',
    title: 'Conversions the network reported',
    kind: 'affiliate_conversion',
    unit: 'count',
    noun: 'orders',
    numerator: 'Conversions the affiliate network attributed to Mercaria for this merchant',
    denominator: 'Not a rate — a count the network published',
    source: 'affiliate_reports',
    humanOnly: false,
    thresholded: true,
    attributionLimit: MERCHANT_DEMAND_ATTRIBUTION_LIMITS.networkRevisable,
    seam: '#37',
  },
  {
    key: 'affiliate_commission',
    title: 'Commission the network reported',
    kind: 'affiliate_commission',
    unit: 'money',
    noun: 'orders',
    numerator: 'Commission the network reported for conversions attributed to Mercaria',
    denominator: 'Not a rate — an amount the network published',
    source: 'affiliate_reports',
    humanOnly: false,
    thresholded: true,
    attributionLimit: MERCHANT_DEMAND_ATTRIBUTION_LIMITS.networkRevisable,
    seam: '#37',
  },
  {
    key: 'external_order_value',
    title: 'Basket value the network reported',
    kind: 'external_order_value',
    unit: 'money',
    noun: 'orders',
    numerator: 'Order value the network reported for conversions attributed to Mercaria',
    denominator: 'Not a rate — an amount the network published',
    source: 'affiliate_reports',
    humanOnly: false,
    thresholded: true,
    attributionLimit: MERCHANT_DEMAND_ATTRIBUTION_LIMITS.networkRevisable,
    seam: '#37',
  },
  // 6. Native offer views, add-to-cart, checkout and paid orders after activation.
  {
    key: 'native_offer_views',
    title: 'Views of products you sell natively',
    kind: 'observed_interaction',
    unit: 'count',
    noun: 'views',
    numerator:
      '`product_page_view` events on canonical products carrying an active NATIVE offer of this merchant',
    denominator: 'All `product_page_view` events in the window',
    source: 'analytics_events',
    humanOnly: true,
    thresholded: true,
    attributionLimit:
      `${MERCHANT_DEMAND_ATTRIBUTION_LIMITS.currentOfferSet} ` +
      MERCHANT_DEMAND_ATTRIBUTION_LIMITS.composedFromRows,
  },
  {
    key: 'native_add_to_cart',
    title: 'Add-to-cart on your native offers',
    kind: 'observed_interaction',
    unit: 'count',
    noun: 'clicks',
    numerator: '`native_add_to_cart` events for a variant of one of this merchant’s listings',
    denominator: '`native_offer_views`',
    source: 'analytics_events',
    humanOnly: true,
    thresholded: true,
    attributionLimit:
      'The emitted event names a listing and a variant and carries no store or merchant ' +
      'dimension, so it cannot be scoped to a merchant without a join this domain ' +
      'deliberately does not perform on the read path.',
    seam: '#111',
  },
  {
    key: 'native_checkout_starts',
    title: 'Checkouts started including your native offers',
    kind: 'observed_interaction',
    unit: 'count',
    noun: 'clicks',
    numerator: '`checkout_started` events whose group contains an order for this merchant’s store',
    denominator: '`native_add_to_cart`',
    source: 'analytics_events',
    humanOnly: true,
    thresholded: true,
    attributionLimit:
      'A checkout group spans several sellers, so one event cannot name one store — ' +
      'the emitted event carries no store dimension at all.',
    seam: '#111',
  },
  {
    key: 'native_paid_orders',
    title: 'Paid native orders',
    kind: 'native_gmv',
    unit: 'count',
    noun: 'orders',
    numerator: 'Orders on this merchant’s linked native store that reached a paid state',
    denominator: 'Not a rate — a count of durable order records',
    source: 'orders',
    humanOnly: false,
    thresholded: true,
    attributionLimit:
      'Read from `orders`, never from a client event: a paid-order figure a browser ' +
      'could inflate is worse than no figure. Refunded orders stay counted — the ' +
      'purchase happened and a refund is a later, separate fact.',
  },
  {
    key: 'native_gmv',
    title: 'Native gross merchandise value',
    kind: 'native_gmv',
    unit: 'money',
    noun: 'orders',
    numerator:
      'Sum of the SHOP-currency grand totals of this merchant’s paid native orders',
    denominator: 'Not a rate — an amount from durable order records',
    source: 'orders',
    humanOnly: false,
    thresholded: true,
    attributionLimit:
      'The store’s own accounting currency only. Orders in another shop currency are ' +
      'reported as their own row and never converted into this one.',
  },
  // 7. Product saves and alerts, only as thresholded aggregate demand.
  {
    key: 'product_save_demand',
    title: 'Shoppers saving your products',
    kind: 'inferred_demand',
    unit: 'count',
    noun: 'saves',
    numerator:
      'Sum of #80 save counts, per product, for canonical products this merchant currently offers',
    denominator: 'Not a rate — a count of saves',
    source: 'product_saves',
    humanOnly: false,
    thresholded: true,
    attributionLimit: MERCHANT_DEMAND_ATTRIBUTION_LIMITS.intentNotPurchase,
  },
  {
    key: 'price_alert_demand',
    title: 'Shoppers watching your prices',
    kind: 'inferred_demand',
    unit: 'count',
    noun: 'saves',
    numerator: 'Price alerts whose subject is a product this merchant offers',
    denominator: 'Not a rate — a count of alerts',
    source: 'price_alerts',
    humanOnly: false,
    thresholded: true,
    attributionLimit:
      '#79 makes "who is watching this product" unaskable by design — no route, no ' +
      'operator handle and no repository function takes a product, a merchant or an ' +
      'account, and the subject index is composite-and-partial so it cannot serve one. ' +
      'Publishing a floored aggregate is #79’s decision to make, not this domain’s.',
    seam: '#79',
  },
  // 8. Zero-result or no-offer demand, only when the relationship is defensible.
  {
    key: 'zero_result_demand',
    title: 'Searches that found nothing',
    kind: 'inferred_demand',
    unit: 'count',
    noun: 'searches',
    numerator: 'Zero-result searches for products associated with this merchant',
    denominator: 'All zero-result searches in the window',
    source: 'analytics_search_queries',
    humanOnly: true,
    thresholded: true,
    attributionLimit:
      'A zero-result search names no product — that is what makes it zero-result — so ' +
      'there is no defensible relationship between it and a merchant. Associating one ' +
      'by title similarity would attribute a stranger’s query to a merchant’s demand.',
    seam: '#70',
  },
  {
    key: 'demand_without_native_offer',
    title: 'Products with demand and no native offer',
    kind: 'inferred_demand',
    unit: 'count',
    noun: 'products',
    numerator:
      'Canonical products this merchant offers externally, above the product floor of views, with no active native offer',
    denominator: 'Canonical products this merchant currently offers',
    source: 'analytics_events',
    humanOnly: true,
    thresholded: true,
    attributionLimit: MERCHANT_DEMAND_ATTRIBUTION_LIMITS.intentNotPurchase,
  },
  // 9. Price-competitiveness availability, from #82.
  //
  // NOT named "coverage", deliberately. #82 publishes a `coverage` rate over ONE
  // condition segment in ONE comparison currency, both named by its caller; this
  // counts subjects evaluated in the segment and the currency the MERCHANT
  // priced each one in. The two are different questions and can legitimately
  // disagree, so they carry different names and each ships its own definition —
  // `countMerchantComparableSubjects`' docblock states the relationship once.
  {
    key: 'subjects_with_a_price_comparison',
    title: 'Products with a price comparison available',
    kind: 'coverage',
    unit: 'rate',
    noun: 'products',
    numerator:
      'This merchant’s subjects for which #82 produced at least one MEASURED signal, each ' +
      'evaluated in its own declared condition segment and its own listed currency',
    denominator: 'This merchant’s subjects #82 examined, bounded by the snapshot’s page',
    source: 'price_signals',
    humanOnly: false,
    // NOT thresholded, and that is a decision rather than an oversight. Every
    // other floor in this domain exists because a small count is a PERSON;
    // both halves of this rate are counts of the merchant's OWN offers, and
    // comparability is derived from other sellers' offers that Mercaria already
    // publishes on `/offer-comparison`. There is no buyer behaviour anywhere in
    // it, so there is nothing a floor would protect. See the doc's
    // "Why this rate needs no floor".
    thresholded: false,
    attributionLimit:
      'This says how many of your products Mercaria can COMPARE, never how you compare. It ' +
      'moves when the market around a product thins out, not when your prices change — and it ' +
      'is not #82’s per-segment coverage rate, which asks about one condition segment in one ' +
      'currency and will differ. It is also a POINT-IN-TIME observation and does not depend on ' +
      'the snapshot’s window: the same merchant measured over 7 days and over 90 gets the same ' +
      'figure, because comparability is a property of the market right now.',
  },
  // 10. Catalog freshness and unavailable-click rate.
  {
    key: 'catalog_freshness_rate',
    title: 'Catalogue fresh enough to show',
    kind: 'catalog_health',
    unit: 'rate',
    noun: 'products',
    numerator:
      'This merchant’s active offers whose #68 freshness verdict admits them to a comparison',
    denominator: 'This merchant’s active offers',
    source: 'offers',
    humanOnly: false,
    thresholded: false,
    attributionLimit:
      'Derived live against each source’s own freshness contract (#68). It measures ' +
      'whether Mercaria may still show a price, not whether the price is right.',
  },
  {
    key: 'unavailable_click_rate',
    title: 'Visits that landed on something unavailable',
    kind: 'catalog_health',
    unit: 'rate',
    noun: 'visits',
    numerator: 'Outbound clicks on an offer that was already unavailable',
    denominator: 'Outbound clicks',
    source: 'analytics_events',
    humanOnly: true,
    thresholded: true,
    attributionLimit: MERCHANT_DEMAND_ATTRIBUTION_LIMITS.clickNotSale,
    seam: '#37',
  },
];

/** Every metric key, in registry order. Renders the `metric_key` CHECK. */
export const MERCHANT_DEMAND_METRIC_KEYS = MERCHANT_DEMAND_METRICS.map((metric) => metric.key);

/** The keys whose unit is `money`. Renders the money-shape CHECK. */
export const MERCHANT_DEMAND_MONEY_METRIC_KEYS = MERCHANT_DEMAND_METRICS.filter(
  (metric) => metric.unit === 'money',
).map((metric) => metric.key);

/** The keys whose unit is `rate`. Renders the rate-shape CHECK. */
export const MERCHANT_DEMAND_RATE_METRIC_KEYS = MERCHANT_DEMAND_METRICS.filter(
  (metric) => metric.unit === 'rate',
).map((metric) => metric.key);

/**
 * The metrics an UNCLAIMED merchant's public preview may show.
 *
 * Two, and both are things Mercaria observed on its own surfaces and can
 * describe with a visit noun. #86 preview rules 3 and 4 — "say visits or clicks
 * unless a conversion is actually reported" and "never invent attributed sales"
 * — are held by this list rather than by the copy, because copy is reviewed once
 * and a list is checked on every build.
 */
export const MERCHANT_DEMAND_PREVIEW_METRIC_KEYS = [
  'search_result_impressions',
  'product_page_views_with_offer',
  'offer_impressions',
  'human_outbound_clicks',
] as const;

/**
 * The metrics a preview may NEVER show, named as VALUES.
 *
 * Disjoint from {@link MERCHANT_DEMAND_PREVIEW_METRIC_KEYS} AND covering the
 * rest of the registry exactly — a metric in NEITHER list fails the build. A
 * gate that skipped what is missing from a hand-maintained map would not be a
 * gate: a nineteenth metric added without a decision would default into
 * whichever behaviour the code happened to have.
 */
export const MERCHANT_DEMAND_PREVIEW_FORBIDDEN_METRIC_KEYS = [
  'network_reported_conversions',
  'affiliate_commission',
  'external_order_value',
  'native_offer_views',
  'native_add_to_cart',
  'native_checkout_starts',
  'native_paid_orders',
  'native_gmv',
  'product_save_demand',
  'price_alert_demand',
  'zero_result_demand',
  'demand_without_native_offer',
  'subjects_with_a_price_comparison',
  'catalog_freshness_rate',
  'unavailable_click_rate',
] as const;

/**
 * The aggregate disclosure floor.
 *
 * Deliberately the SAME constant #77's merchant summary uses rather than a
 * second one: "how many people saw my products" is the same class of question
 * whether it is asked of a native store or of a canonical merchant, and two
 * floors for one question is two numbers that can be differenced.
 */
export const MERCHANT_DEMAND_AGGREGATE_MIN_COUNT = ANALYTICS_MERCHANT_MIN_COHORT;

/**
 * The floor a PRODUCT-level row must clear to exist at all (#86 privacy 1).
 *
 * Higher than the aggregate floor, and #77's query floor is the precedent: a
 * product-level row is a much finer slice of the same population, and a handful
 * of views of one obscure product in one market is a person.
 */
export const MERCHANT_DEMAND_PRODUCT_MIN_COUNT = 25;

/**
 * The floor a PUBLIC preview figure must clear (#86 preview rule 6).
 *
 * Higher again, because the preview is shown to whoever asks — including, in a
 * claim flow, to somebody who has not proved they are the merchant. "Require
 * enough data to prevent inference about one person" is a stronger requirement
 * when the reader is unauthenticated.
 */
export const MERCHANT_DEMAND_PREVIEW_MIN_COUNT = 100;

/**
 * Round a preview count DOWN to two significant figures (#86 preview rule 1).
 *
 * Down rather than to nearest: a rounded figure a merchant is shown must never
 * be larger than what happened, or the preview overstates Mercaria's demand in
 * exactly the conversation where overstating it is a commercial claim.
 *
 * Two significant figures rather than a fixed bucket size, because the counts
 * this describes span four orders of magnitude and a fixed bucket is either
 * uselessly coarse at the bottom or discloses too much at the top.
 */
export function roundPreviewCount(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  const floored = Math.floor(count);
  if (floored < 100) return floored;
  const magnitude = 10 ** (Math.floor(Math.log10(floored)) - 1);
  return Math.floor(floored / magnitude) * magnitude;
}

/**
 * What population a product-composed AGGREGATE actually covers.
 *
 * An aggregate and a product breakdown that sum over the same population at
 * different GRAINS are a differencing attack waiting to be run: publish the
 * exact total and the rows above a floor, and the withheld rows are the
 * subtraction. Every product-composed figure in this domain is therefore built
 * from the SAME partition the rows are, as the disclosed rows plus at most one
 * RESIDUAL bucket — and the residual is published only when it can hide its own
 * contributors ({@link MERCHANT_DEMAND_RESIDUAL_MIN_CONTRIBUTORS}) and clears
 * the value floor.
 *
 * When it cannot, the residual is folded away and the figure becomes what it
 * then is: a total over the disclosed rows. That is a different number, so it
 * carries a different basis and says so — a total wearing the whole
 * catalogue's name is the thing this exists to prevent.
 */
export const MERCHANT_DEMAND_AGGREGATE_BASES = [
  /** Disclosed rows plus a residual that clears both floors. */
  'whole_catalogue',
  /** The disclosed rows only; the residual was folded away. */
  'disclosed_rows_only',
] as const;

/** One of {@link MERCHANT_DEMAND_AGGREGATE_BASES}. */
export type MerchantDemandAggregateBasis = (typeof MERCHANT_DEMAND_AGGREGATE_BASES)[number];

/**
 * How many WITHHELD products a residual must be spread over before it is
 * published.
 *
 * Two, and it may never be one. A value floor alone does not save you: with a
 * single sub-floor product the residual IS that product's count, so a residual
 * of 40 over one contributor discloses 40 exactly while clearing any floor you
 * like. The floor bounds the SIZE of what is published; this bounds how many
 * things it could be about, and only the second makes a subtraction ambiguous.
 *
 * Two is the smallest number that makes it ambiguous at all, and the cost of
 * more is real — a long tail of one-view products would fold the residual away
 * permanently and leave every merchant reading a partial total.
 */
export const MERCHANT_DEMAND_RESIDUAL_MIN_CONTRIBUTORS = 2;

/**
 * The reporting windows a caller may ask for, in days.
 *
 * A CLOSED set, not a bounded integer. Overlapping windows difference exactly
 * as grains do — 30 days minus 29 days is one day, and one day of one product's
 * demand is where a single person lives. A free integer with `refresh=true`
 * lets a claimant walk the boundary a day at a time; three fixed windows do
 * not overlap by one day at any point.
 */
export const MERCHANT_DEMAND_WINDOW_DAYS = [7, 30, 90] as const;

/** One of {@link MERCHANT_DEMAND_WINDOW_DAYS}. */
export type MerchantDemandWindowDays = (typeof MERCHANT_DEMAND_WINDOW_DAYS)[number];

/** A measured figure: exactly one shape per unit, and none of them is nullable. */
export type MerchantDemandMeasure =
  | { readonly unit: 'count'; readonly count: number }
  | { readonly unit: 'money'; readonly amount: number; readonly currency: CurrencyCode }
  | { readonly unit: 'rate'; readonly numerator: number; readonly denominator: number };

/**
 * A figure, or the honest reason there is not one.
 *
 * The `suppressed` branch carries the FLOOR and no count — a bound is a
 * disclosure too, so "under 25" is not offered either. The `unavailable` branch
 * carries no measure at all.
 */
export type MerchantDemandValue =
  | { readonly state: 'measured'; readonly measure: MerchantDemandMeasure }
  | { readonly state: 'suppressed'; readonly floor: number }
  | {
      readonly state: 'unavailable';
      readonly reason: MerchantDemandUnavailableReason;
      readonly seam?: string;
    };

/**
 * Apply the disclosure floor to a COUNT.
 *
 * The ONE policy function; every surface that shows a demand count to anybody
 * calls it. Below the floor the answer is a STATE, never a rounded number and
 * never a bounded one.
 */
export function discloseDemandCount(count: number, floor: number): MerchantDemandValue {
  if (count >= floor) return { state: 'measured', measure: { unit: 'count', count } };
  return { state: 'suppressed', floor };
}

/** One metric on a snapshot, as a reader sees it. */
export interface MerchantDemandMetricRow {
  readonly metricKey: string;
  readonly kind: MerchantDemandMetricKind;
  /** `''` when the figure is not sliced by channel. */
  readonly channel: MerchantDemandChannel | '';
  /** `''` when the figure is not sliced by storefront. */
  readonly storefrontId: string;
  /** `''` when the figure is not sliced by catalogue source. */
  readonly sourceId: string;
  readonly value: MerchantDemandValue;
  /**
   * For a product-composed figure, what population it covers. Absent for a
   * figure that has no product breakdown beside it to be differenced against.
   */
  readonly aggregateBasis?: MerchantDemandAggregateBasis;
  readonly definition: MerchantDemandMetricDefinition;
}

/** One product-level row. Present only where the product floor was cleared. */
export interface MerchantDemandProductRow {
  readonly canonicalProductId: string;
  readonly productPageViews: number;
  readonly offerImpressions: number;
  /** Whether the merchant has an active NATIVE offer for this product. */
  readonly hasNativeOffer: boolean;
  /** The #68 verdict for this merchant's freshest offer on the product. */
  readonly offerFreshness: 'current' | 'warning' | 'expired' | 'unavailable' | 'unknown';
}

/** What a snapshot could NOT answer, and why (#86 snapshot item 8). */
export interface MerchantDemandCoverage {
  /** Canonical products the merchant currently offers. */
  readonly productsOffered: number;
  /** Product-level rows the floor admitted. */
  readonly productRowsDisclosed: number;
  /** Product-level rows the floor withheld. Never their values. */
  readonly productRowsSuppressed: number;
  /** Metrics that answered `unavailable`, by reason. */
  readonly unavailableMetrics: readonly {
    readonly metricKey: string;
    readonly reason: MerchantDemandUnavailableReason;
    readonly seam?: string;
  }[];
}

/** A persisted snapshot, as a reader sees it (#86 §MerchantDemandSnapshot). */
export interface MerchantDemandSnapshotView {
  readonly id: string;
  readonly merchantId: string;
  /** ISO 3166-1 alpha-2, or `''` for "every market". */
  readonly market: string;
  readonly windowFrom: string;
  readonly windowTo: string;
  /** The newest durable observation the snapshot could see. */
  readonly dataFreshAsOf: string;
  readonly eventPolicyVersion: string;
  readonly attributionPolicyVersion: string;
  /** The analytics collection mode in force when it was built. */
  readonly collectionMode: string;
  readonly aggregateFloor: number;
  readonly productFloor: number;
  readonly metrics: readonly MerchantDemandMetricRow[];
  readonly products: readonly MerchantDemandProductRow[];
  readonly coverage: MerchantDemandCoverage;
  readonly createdAt: string;
  readonly supersededAt?: string;
}

/**
 * The bounded proof an UNCLAIMED merchant may be shown.
 *
 * A DIFFERENT TYPE from the dashboard, not a filtered one — the `MerchantOrder`
 * device. There is no product list, no money field and no conversion field to
 * omit, so a serializer that reached for one would fail `tsc` rather than ship
 * it.
 */
export interface MerchantDemandPreview {
  readonly merchantId: string;
  readonly market: string;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly dataFreshAsOf: string;
  /** Rounded down to two significant figures, above the preview floor, or withheld. */
  readonly lines: readonly {
    readonly metricKey: string;
    readonly noun: MerchantDemandCountNoun;
    readonly title: string;
    readonly value: MerchantDemandValue;
    readonly attributionLimit: string;
  }[];
  /** Stated in the payload, never composed by a client. */
  readonly disclosure: {
    readonly rounding: string;
    readonly floor: number;
    readonly limitation: string;
  };
}

/* ------------------------------------------------------------------------- */
/* The operator acquisition pipeline                                          */
/* ------------------------------------------------------------------------- */

/**
 * The OUTREACH state of a candidate — what Mercaria has done about it.
 *
 * Deliberately NOT the claim state. `merchants.claim_state` is ADR 0002 D9's
 * ONE stored claim verdict and #83 is its only writer; a second column here
 * that also said "claimed" would be two representations of one fact, and the
 * one that would go stale is the one an operator reads. The CONVERSION funnel is
 * DERIVED — see {@link MERCHANT_ACQUISITION_CONVERSION_STAGES}.
 */
export const MERCHANT_ACQUISITION_STATES = [
  'identified',
  'queued',
  'in_outreach',
  'awaiting_response',
  'closed_won',
  'closed_declined',
  'excluded',
] as const;

/** One of {@link MERCHANT_ACQUISITION_STATES}. */
export type MerchantAcquisitionState = (typeof MERCHANT_ACQUISITION_STATES)[number];

/** The states in which a candidate is still being worked. */
export const MERCHANT_ACQUISITION_OPEN_STATES = [
  'identified',
  'queued',
  'in_outreach',
  'awaiting_response',
] as const;

/**
 * The conversion funnel, DERIVED on every read and stored nowhere.
 *
 * Each stage's authority is somebody else's stored fact: `claimed` is
 * `merchants.claim_state` (#83), `store_linked` is an active `native_store_links`
 * row (#54/#84), `payment_ready` is `provider_accounts.onboarding_state` (#46),
 * `native_activated` is an active native OFFER (#57). Copying any of them here
 * would create a second answer that goes stale the moment a claim is revoked.
 */
export const MERCHANT_ACQUISITION_CONVERSION_STAGES = [
  'unclaimed',
  'claimed',
  'store_linked',
  'payment_ready',
  'native_activated',
] as const;

/** One of {@link MERCHANT_ACQUISITION_CONVERSION_STAGES}. */
export type MerchantAcquisitionConversionStage =
  (typeof MERCHANT_ACQUISITION_CONVERSION_STAGES)[number];

/** Why a candidate is excluded from outreach. */
export const MERCHANT_ACQUISITION_EXCLUSION_REASONS = [
  'do_not_contact_requested',
  'merchant_suppressed',
  'rights_withdrawn',
  'duplicate_of_another_candidate',
  'out_of_market',
  'competitor_conflict',
  'legal_review_required',
  'operator_judgement',
] as const;

/** One of {@link MERCHANT_ACQUISITION_EXCLUSION_REASONS}. */
export type MerchantAcquisitionExclusionReason =
  (typeof MERCHANT_ACQUISITION_EXCLUSION_REASONS)[number];

/**
 * Where a public business contact may be found.
 *
 * These name a PLACE, never a value — see
 * {@link MERCHANT_ACQUISITION_FORBIDDEN_CONTACT_SOURCES} and the table docblock
 * for why no column in this domain holds a contact at all.
 */
export const MERCHANT_ACQUISITION_CONTACT_SOURCE_KINDS = [
  'merchant_website_imprint',
  'merchant_website_contact_page',
  'public_feed_contact_field',
  'affiliate_network_directory',
  'public_business_registry',
] as const;

/** One of {@link MERCHANT_ACQUISITION_CONTACT_SOURCE_KINDS}. */
export type MerchantAcquisitionContactSourceKind =
  (typeof MERCHANT_ACQUISITION_CONTACT_SOURCE_KINDS)[number];

/**
 * Places a contact may NEVER be taken from, named as VALUES.
 *
 * #86 privacy 7 is "do not use payment-onboarding identity data as outreach
 * contact data", and the first member is that prohibition written down. The rest
 * are the other places a merchant's or a buyer's details sit in this codebase,
 * every one of which somebody in a hurry could reach. Disjoint from the allowed
 * kinds by a gate, so widening the allowed set can never quietly admit one.
 */
export const MERCHANT_ACQUISITION_FORBIDDEN_CONTACT_SOURCES = [
  'payment_onboarding_identity',
  'stripe_connected_account',
  'guest_checkout_contact',
  'buyer_order_contact',
  'oxy_account_profile',
  'support_thread',
  'abuse_report',
  'price_alert_subscriber',
  'store_member_directory',
] as const;

/** How an operator reached out. RECORDED after the fact; nothing here sends. */
export const MERCHANT_ACQUISITION_OUTREACH_CHANNELS = [
  'email',
  'phone',
  'postal',
  'in_person',
  'network_intermediary',
] as const;

/** One of {@link MERCHANT_ACQUISITION_OUTREACH_CHANNELS}. */
export type MerchantAcquisitionOutreachChannel =
  (typeof MERCHANT_ACQUISITION_OUTREACH_CHANNELS)[number];

/** What came of one outreach attempt. */
export const MERCHANT_ACQUISITION_OUTREACH_OUTCOMES = [
  'sent',
  'bounced',
  'replied_interested',
  'replied_declined',
  'no_response',
] as const;

/** One of {@link MERCHANT_ACQUISITION_OUTREACH_OUTCOMES}. */
export type MerchantAcquisitionOutreachOutcome =
  (typeof MERCHANT_ACQUISITION_OUTREACH_OUTCOMES)[number];

/**
 * The CLOSED set of operator writes on this surface.
 *
 * Read plus these and nothing else. There is no "set this merchant claimed", no
 * "override this score", no "set this figure" and no delete — every one of those
 * would be a way to change a FACT rather than a way to record a decision, and
 * three of them would put a second answer beside a verdict another domain owns.
 */
export const MERCHANT_ACQUISITION_ACTIONS = [
  'assign',
  'set_next_action',
  'record_outreach',
  'record_contact_source',
  'exclude',
  'clear_exclusion',
  'set_do_not_contact',
  'rescore',
] as const;

/** One of {@link MERCHANT_ACQUISITION_ACTIONS}. */
export type MerchantAcquisitionAction = (typeof MERCHANT_ACQUISITION_ACTIONS)[number];

/**
 * The signals a candidate score may read.
 *
 * Every one is a fact about how much demand Mercaria already carries for the
 * merchant, how big and how fresh its catalogue is, and how well a connector
 * would fit. Nothing about money, position or relevance.
 */
export const MERCHANT_ACQUISITION_SCORE_INPUTS = [
  'aggregate_demand',
  'catalog_size',
  'catalog_freshness',
  'source_quality',
  'connector_fit',
  'unmet_native_demand',
] as const;

/** One of {@link MERCHANT_ACQUISITION_SCORE_INPUTS}. */
export type MerchantAcquisitionScoreInput = (typeof MERCHANT_ACQUISITION_SCORE_INPUTS)[number];

/**
 * The signals a candidate score may NEVER read, named as VALUES.
 *
 * #86's "scoring cannot affect organic offer ranking" is a statement about the
 * direction of influence, and it is enforced in both directions: nothing here
 * may read a ranking fact (so a score cannot be a laundered rank), and nothing
 * in ranking or search may reach this domain (a scanned gate). Disjoint from the
 * allowed inputs, and {@link MerchantAcquisitionFacts} has a field for every
 * allowed one and none for any of these.
 */
export const MERCHANT_ACQUISITION_FORBIDDEN_SCORE_INPUTS = [
  'organic_rank_position',
  'ranking_policy_weight',
  'search_relevance_score',
  'offer_eligibility_verdict',
  'affiliate_commission_rate',
  'fee_schedule_rate',
  'retail_margin',
  'sponsored_placement',
  'payment_provider_balance',
] as const;

/**
 * Everything a score may be computed from.
 *
 * One field per allowed input and none for any forbidden one — the
 * `SourcingCandidateFacts` and `OfferRankingFacts` device. A scorer that cannot
 * READ a commission cannot score by it, whatever any weight is set to.
 *
 * Every field is a three-way {@link MerchantDemandValue}-shaped answer rather
 * than a number, because an unmeasured input must be left OUT of the score
 * rather than imputed as zero: reading "we have no freshness measurement" as a
 * freshness of nought would put every merchant whose feed Mercaria has not read
 * at the bottom of the acquisition list, which is precisely backwards.
 */
export interface MerchantAcquisitionFacts {
  /** Interactions Mercaria observed for the merchant's products, in the window. */
  readonly aggregateDemand: MerchantAcquisitionSignal;
  /** How many canonical products the merchant offers. */
  readonly catalogSize: MerchantAcquisitionSignal;
  /** The fraction of the merchant's offers #68 admits to a comparison. */
  readonly catalogFreshness: MerchantAcquisitionSignal;
  /** How well the sources behind the merchant's offers are performing. */
  readonly sourceQuality: MerchantAcquisitionSignal;
  /** Whether a connector Mercaria already ships would fit the merchant's platform. */
  readonly connectorFit: MerchantAcquisitionSignal;
  /** Products with demand and no native offer — the size of the prize. */
  readonly unmetNativeDemand: MerchantAcquisitionSignal;
}

/**
 * One score input, measured or not.
 *
 * A string discriminant, and the `unmeasured` branch has no `normalized` to
 * read, so it cannot enter the weighted mean at all.
 */
export type MerchantAcquisitionSignal =
  | { readonly outcome: 'measured'; readonly normalized: number }
  | { readonly outcome: 'unmeasured'; readonly reason: MerchantDemandUnavailableReason };

/** A computed score and the parts it was made of. */
export interface MerchantAcquisitionScore {
  /** 0–10000 basis points of the measured inputs' mean. */
  readonly scoreBps: number;
  /** Which inputs contributed. An unmeasured input is absent, never zero. */
  readonly contributingInputs: readonly MerchantAcquisitionScoreInput[];
  /** Which inputs could not be measured, and why. */
  readonly unmeasuredInputs: readonly {
    readonly input: MerchantAcquisitionScoreInput;
    readonly reason: MerchantDemandUnavailableReason;
  }[];
  /** The version of the scoring procedure, stamped on the stored row. */
  readonly scoreVersion: string;
}

/**
 * The scoring procedure's version. A code constant, for the reason
 * {@link MERCHANT_DEMAND_EVENT_POLICY_VERSION} is one.
 */
export const MERCHANT_ACQUISITION_SCORE_VERSION = '2026-08-10.1';

/** Which {@link MerchantAcquisitionFacts} field carries which allowed input. */
const SCORE_INPUT_FIELDS: readonly {
  readonly input: MerchantAcquisitionScoreInput;
  readonly read: (facts: MerchantAcquisitionFacts) => MerchantAcquisitionSignal;
}[] = [
  { input: 'aggregate_demand', read: (facts) => facts.aggregateDemand },
  { input: 'catalog_size', read: (facts) => facts.catalogSize },
  { input: 'catalog_freshness', read: (facts) => facts.catalogFreshness },
  { input: 'source_quality', read: (facts) => facts.sourceQuality },
  { input: 'connector_fit', read: (facts) => facts.connectorFit },
  { input: 'unmet_native_demand', read: (facts) => facts.unmetNativeDemand },
];

/**
 * Score a candidate — a pure function over the facts and nothing else.
 *
 * An unmeasured input is left out of BOTH halves of the mean, #58's
 * denominator rule: reading it as zero would rank a merchant Mercaria knows
 * nothing about below one it knows is small, when the only difference is
 * Mercaria's own information. With NOTHING measured the score is zero AND every
 * input is reported unmeasured, so a reader can tell "we scored it low" from
 * "we could not score it".
 */
export function scoreMerchantAcquisition(
  facts: MerchantAcquisitionFacts,
): MerchantAcquisitionScore {
  const contributingInputs: MerchantAcquisitionScoreInput[] = [];
  const unmeasuredInputs: { input: MerchantAcquisitionScoreInput; reason: MerchantDemandUnavailableReason }[] =
    [];
  let total = 0;

  for (const field of SCORE_INPUT_FIELDS) {
    const signal = field.read(facts);
    if (signal.outcome === 'measured') {
      contributingInputs.push(field.input);
      total += clampUnitInterval(signal.normalized);
      continue;
    }
    unmeasuredInputs.push({ input: field.input, reason: signal.reason });
  }

  const scoreBps =
    contributingInputs.length === 0
      ? 0
      : Math.round((total / contributingInputs.length) * 10_000);

  return {
    scoreBps,
    contributingInputs,
    unmeasuredInputs,
    scoreVersion: MERCHANT_ACQUISITION_SCORE_VERSION,
  };
}

/** Keep a normalized signal inside `[0, 1]` so no input can dominate the mean. */
function clampUnitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Where a public business contact was published. NEVER the contact itself. */
export interface MerchantAcquisitionContactSourceView {
  readonly id: string;
  readonly kind: MerchantAcquisitionContactSourceKind;
  /** The page an operator opens to read the contact for themselves. */
  readonly sourceUrl: string;
  /** Where on that page, in the operator's own words. Never a value. */
  readonly locatorNote: string;
  readonly observedAt: string;
  readonly recordedByOxyUserId: string;
}

/** One recorded outreach attempt. */
export interface MerchantAcquisitionOutreachView {
  readonly id: string;
  readonly channel: MerchantAcquisitionOutreachChannel;
  readonly outcome: MerchantAcquisitionOutreachOutcome;
  readonly occurredAt: string;
  readonly actorOxyUserId: string;
  readonly contactSourceId?: string;
}

/** A candidate, as the operator surface serves it. */
export interface MerchantAcquisitionCandidateView {
  readonly merchantId: string;
  readonly merchantName: string;
  readonly state: MerchantAcquisitionState;
  /** DERIVED from #83, #54/#84, #46 and #57 — never stored on the candidate. */
  readonly conversionStage: MerchantAcquisitionConversionStage;
  readonly scoreBps: number;
  readonly scoreVersion: string;
  readonly scoredAt?: string;
  readonly contributingInputs: readonly MerchantAcquisitionScoreInput[];
  /**
   * The inputs the last scoring run could not measure, by NAME only.
   *
   * The REASON each was unmeasurable is a property of that run and is answered
   * by the snapshot the score cites (`snapshotId` → the metric's
   * `unavailableMetrics`). Storing a reason here too would be a second copy of
   * something the evidence already explains, and it is the copy that would be
   * wrong after the next rescore.
   */
  readonly unmeasuredInputs: readonly MerchantAcquisitionScoreInput[];
  readonly assignedToOxyUserId?: string;
  readonly nextAction?: string;
  readonly nextActionDueAt?: string;
  readonly doNotContact: boolean;
  readonly exclusionReason?: MerchantAcquisitionExclusionReason;
  readonly excludedAt?: string;
  readonly contactSources: readonly MerchantAcquisitionContactSourceView[];
  readonly outreach: readonly MerchantAcquisitionOutreachView[];
  readonly snapshotId?: string;
}

/**
 * The generated, reviewable outreach context (#86 acquisition 5).
 *
 * COMPOSED on read from a stored snapshot and never stored itself: a stored
 * context is a copy of a number that can go stale, and the failure mode is an
 * operator quoting last quarter's demand at a merchant. Every line names the
 * metric it came from and carries that metric's attribution limit, so "using
 * only defensible metrics" is checkable by reading the payload rather than by
 * trusting whoever wrote the template.
 *
 * There is no free-text field, no subject line and no salutation. This is not a
 * draft message — it is the evidence an operator writes one from.
 */
export interface MerchantAcquisitionOutreachContext {
  readonly merchantId: string;
  readonly snapshotId: string;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly dataFreshAsOf: string;
  readonly lines: readonly {
    readonly metricKey: string;
    readonly title: string;
    readonly noun: MerchantDemandCountNoun;
    readonly value: MerchantDemandValue;
    readonly attributionLimit: string;
  }[];
  /** Metrics deliberately withheld from the context, and why. */
  readonly withheld: readonly {
    readonly metricKey: string;
    readonly reason: 'not_preview_safe' | 'below_floor' | 'unavailable';
  }[];
}

/** The one reason code a merchant demand read refuses with. */
export const MERCHANT_DEMAND_REFUSAL_REASON = 'merchant_demand_not_available' as const;
