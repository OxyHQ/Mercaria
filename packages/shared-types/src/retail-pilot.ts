/**
 * The BOUNDED RETAIL PILOT (#125 "Pilot cohort", "Stop thresholds").
 *
 * #120 decides what a `mercaria_retail` item costs, #121 whether Mercaria may
 * sell it at all, #122 what the supplier says right now and #124 how the order
 * is placed. None of them answers the question this vocabulary exists for:
 * **how much of this is Mercaria willing to do at all, today.**
 *
 * The failure mode it is shaped around is a pilot that succeeded technically
 * and expanded by default. #125 states it outright — "no automatic expansion
 * follows from technical success" — so every bound here is a stored, versioned,
 * immutable-once-active fact with a person's name on it, and there is
 * deliberately no code path that widens one.
 */

/**
 * The pilot's audience ladder (#125 pilot cohort 8).
 *
 * ORDERED, and the order is the ladder: `staff` is the narrowest and `public`
 * the widest. There is no `all` member beyond `public` and no way to express
 * "everyone plus" — a cohort is a bound, and a vocabulary that could express an
 * unbounded one would make the bound optional.
 *
 * `percentage` carries its own `audience_percentage_bps`, present EXACTLY when
 * the audience is `percentage` (a CHECK, both directions): a percentage with no
 * number admits nobody or everybody depending on who reads it, and a number
 * beside a non-percentage audience is a bound nothing applies.
 */
export type RetailPilotAudience = 'staff' | 'invited' | 'percentage' | 'public';

/** {@link RetailPilotAudience} as the tuple the columns and CHECKs read. */
export const RETAIL_PILOT_AUDIENCES: readonly RetailPilotAudience[] = [
  'staff',
  'invited',
  'percentage',
  'public',
];

/** A cohort version's lifecycle — the `fee_schedules` shape, reused deliberately. */
export type RetailPilotCohortStatus = 'draft' | 'active' | 'superseded' | 'retired';

/** {@link RetailPilotCohortStatus} as the tuple the columns and CHECKs read. */
export const RETAIL_PILOT_COHORT_STATUSES: readonly RetailPilotCohortStatus[] = [
  'draft',
  'active',
  'superseded',
  'retired',
];

/**
 * The TWELVE stop thresholds #125 names, verbatim and in its order.
 *
 * A closed tuple rather than free text, and it is what
 * `retail_pilot_stop_thresholds.metric` CHECKs against — so a threshold whose
 * meaning nobody defined cannot be stored, and the read surface cannot serve a
 * number whose definition is unstated. The `analytics_rollups.metric_key`
 * device (#77), applied to a safety bound instead of a report.
 *
 * Each is a RATE or a COUNT over a window, never a judgement:
 *
 *  - `supplier_stock_rejection` — supplier refused for stock, per order.
 *  - `checkout_cost_change` — cost or shipping moved between quote and charge.
 *  - `procurement_timeout_or_ambiguity` — #124's ambiguous submissions.
 *  - `late_dispatch` — dispatch past the promise.
 *  - `tracking_failure` — shipped with no usable tracking.
 *  - `cancellation_rejection` — the supplier refused a cancellation.
 *  - `return_or_defect_rate` — returns and defect claims, per order.
 *  - `negative_realized_margin` — absorbed variance, in minor units.
 *  - `supplier_credit_mismatch` — #128's reconciliation disagreeing.
 *  - `customer_support_volume` — contacts per order.
 *  - `payment_refund_or_dispute_rate` — refunds and disputes, per order.
 *  - `product_safety_incident` — one occurrence is the threshold.
 *
 * `non_eu_dispatch_origin` is the THIRTEENTH and is #119 §10's own, not #125's
 * list: ADR 0004 D2.9 makes a dispatch from outside the EU customs territory a
 * one-occurrence stop, and leaving it out of the tuple would mean the one bound
 * the architecture treats as absolute is the one nothing could record.
 */
export type RetailPilotStopMetric =
  | 'supplier_stock_rejection'
  | 'checkout_cost_change'
  | 'procurement_timeout_or_ambiguity'
  | 'late_dispatch'
  | 'tracking_failure'
  | 'cancellation_rejection'
  | 'return_or_defect_rate'
  | 'negative_realized_margin'
  | 'supplier_credit_mismatch'
  | 'customer_support_volume'
  | 'payment_refund_or_dispute_rate'
  | 'product_safety_incident'
  | 'non_eu_dispatch_origin';

/** {@link RetailPilotStopMetric} as the tuple the columns and CHECKs read. */
export const RETAIL_PILOT_STOP_METRICS: readonly RetailPilotStopMetric[] = [
  'supplier_stock_rejection',
  'checkout_cost_change',
  'procurement_timeout_or_ambiguity',
  'late_dispatch',
  'tracking_failure',
  'cancellation_rejection',
  'return_or_defect_rate',
  'negative_realized_margin',
  'supplier_credit_mismatch',
  'customer_support_volume',
  'payment_refund_or_dispute_rate',
  'product_safety_incident',
  'non_eu_dispatch_origin',
];

/**
 * How a threshold's value is read (#125 stop thresholds, and the reason the
 * twelve cannot share one unit).
 *
 * `rate_bps` is a share of the window's orders in basis points; `count` is an
 * absolute number of occurrences; `minor_units` is money. Storing all three as
 * one number with no unit is how "> 2% of orders" and "> €50/week" end up
 * compared against each other.
 */
export type RetailPilotThresholdUnit = 'rate_bps' | 'count' | 'minor_units';

/** {@link RetailPilotThresholdUnit} as the tuple the columns and CHECKs read. */
export const RETAIL_PILOT_THRESHOLD_UNITS: readonly RetailPilotThresholdUnit[] = [
  'rate_bps',
  'count',
  'minor_units',
];

/**
 * What a breach PAUSES (#125: "crossing a threshold pauses the relevant cohort
 * and preserves existing-order operations").
 *
 * The scope is per THRESHOLD, because the twelve are not equally broad: a
 * product-safety incident on one SKU should not stop every other, and a
 * supplier-credit mismatch is about the supplier rather than the market.
 *
 * There is deliberately NO scope that pauses fulfilment. A stop halts ENTRY —
 * new retail checkouts — and nothing else: purchase orders already placed keep
 * being submitted, polled, cancelled, refunded and reconciled, because a buyer
 * who has paid is owed their goods whatever Mercaria has decided about taking
 * more orders. That is the whole content of "preserves existing-order
 * operations", and it is held by the fact that `assertRetailPilotAdmits` is
 * called from checkout and from nowhere else.
 */
export type RetailPilotStopScope = 'pilot' | 'supplier' | 'market' | 'sku';

/** {@link RetailPilotStopScope} as the tuple the columns and CHECKs read. */
export const RETAIL_PILOT_STOP_SCOPES: readonly RetailPilotStopScope[] = [
  'pilot',
  'supplier',
  'market',
  'sku',
];

/**
 * Who raised a stop.
 *
 * `automatic` rows carry NO raiser (a CHECK), because attributing a threshold
 * evaluation to a person makes an audit trail say something false. An
 * `operator` stop carries one and is mandatory — the `payment_repairs` posture.
 */
export type RetailPilotStopOrigin = 'automatic' | 'operator';

/** {@link RetailPilotStopOrigin} as the tuple the columns and CHECKs read. */
export const RETAIL_PILOT_STOP_ORIGINS: readonly RetailPilotStopOrigin[] = [
  'automatic',
  'operator',
];

/**
 * Where a supplier-balance figure came from (#125 provider funding 2).
 *
 * `operator_entry` exists and is NOT a weakness: Printful's Wallet balance is
 * not exposed by any endpoint this integration verified
 * (`docs/suppliers/printful.md` §14), so an operator reading the dashboard and
 * recording what it said is the only honest source available today. Naming it
 * as its own source is what stops that figure being mistaken for one the
 * provider asserted.
 */
export type SupplierFundingSource = 'provider_api' | 'operator_entry' | 'statement';

/** {@link SupplierFundingSource} as the tuple the columns and CHECKs read. */
export const SUPPLIER_FUNDING_SOURCES: readonly SupplierFundingSource[] = [
  'provider_api',
  'operator_entry',
  'statement',
];

/**
 * Why the pilot refused a retail line.
 *
 * INTERNAL, exactly like `RetailCheckoutRefusal` (#123): the buyer sees one
 * sentence naming none of them, and this vocabulary reaches the log line an
 * operator traces from. Distinguishing them to a client would let somebody vary
 * one input at a time and read out the pilot's SKU list, its value ceiling and
 * its supplier's cash position.
 */
export type RetailPilotRefusal =
  | 'no_active_cohort'
  | 'market_not_in_pilot'
  | 'currency_not_in_pilot'
  | 'supplier_not_in_pilot'
  | 'sku_not_allowlisted'
  | 'quantity_above_cohort_limit'
  | 'item_value_above_cohort_limit'
  | 'order_value_above_cohort_limit'
  | 'order_value_below_cohort_minimum'
  | 'shipping_service_not_permitted'
  | 'audience_not_in_cohort'
  | 'supplier_funding_unavailable'
  | 'stop_threshold_active';

/** {@link RetailPilotRefusal} as a tuple, for exhaustive iteration. */
export const RETAIL_PILOT_REFUSALS: readonly RetailPilotRefusal[] = [
  'no_active_cohort',
  'market_not_in_pilot',
  'currency_not_in_pilot',
  'supplier_not_in_pilot',
  'sku_not_allowlisted',
  'quantity_above_cohort_limit',
  'item_value_above_cohort_limit',
  'order_value_above_cohort_limit',
  'order_value_below_cohort_minimum',
  'shipping_service_not_permitted',
  'audience_not_in_cohort',
  'supplier_funding_unavailable',
  'stop_threshold_active',
];

/**
 * The pilot's admission verdict.
 *
 * A STRING discriminant rather than a boolean, for `offer-freshness.ts`'
 * reason: the backend compiles with `strict: false`, under which TypeScript
 * does not narrow a union on the truthiness of a boolean-literal discriminant,
 * and every caller here must act on the refusal REASON.
 */
export type RetailPilotAdmission =
  | { readonly outcome: 'admitted'; readonly cohortVersion: number }
  | { readonly outcome: 'refused'; readonly reason: RetailPilotRefusal };
