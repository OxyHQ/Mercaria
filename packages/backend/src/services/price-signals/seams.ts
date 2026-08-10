/**
 * The one fact #82 asks for that nothing in Mercaria measures.
 *
 * A NAMED contract that fails closed rather than a stub that lies: it answers
 * "no data", the insight that reads it is `unmeasured` with
 * `demand_measurement_unavailable`, and the merchant sees a stated gap instead of
 * a confident-looking empty list.
 *
 * Not a registry with a `register…` function, deliberately — #74's `seams.ts`
 * reasoning, which is #62's fixture-adapter reasoning: a registry is a place a
 * test-only provider can be installed in production, and this is one function
 * body its owning issue replaces.
 */

/**
 * How much Mercaria demand a canonical product carries (issue merchant
 * competitiveness 4: "products with high Mercaria demand but no native offer").
 *
 * ALWAYS unavailable today, and the reason is a fact about the measurement
 * rather than an omission here.
 *
 * **#77 defines no product-level demand metric.** Its twenty-two metric
 * definitions are search, funnel, conversion and coverage rates; none is keyed on
 * a canonical product, and `analytics_rollups` has no product dimension to add
 * one to. A metric whose definition is unstated cannot be stored or served — that
 * is #77's own rule — so there is nothing here to read.
 *
 * **The two things a later reader will reach for are both wrong.**
 * `product_save_aggregates` (#80) is a count of people who saved a product for
 * LATER, which is an intent to return and not demand; #80 additionally holds
 * that a save is not a ranking input and applies a disclosure floor of ten,
 * neither of which survives being re-exposed through a merchant dashboard.
 * `analytics_search_queries` (#77) has no actor column and a hard floor of
 * twenty-five occurrences with no bypass, and a query is a phrase rather than a
 * product.
 *
 * **What closing it needs:** a #77 metric definition keyed on a canonical
 * product, with a stated numerator, denominator, window and attribution limit,
 * plus a rollup that carries the product dimension. Then this function reads that
 * rollup and nothing else, and it still owes the disclosure floor
 * `PRICE_SIGNAL_DISTRIBUTION_DISCLOSURE_FLOOR` names — a demand figure over four
 * shoppers is four shoppers.
 */
/**
 * A STRING discriminant, not `known: true | false`.
 *
 * `@mercaria/backend` compiles without `strictNullChecks`, and TypeScript does
 * not narrow a union on the TRUTHINESS of a boolean-literal discriminant there —
 * `if (demand.known)` leaves the caller holding the whole union and reading
 * `reason` is a type error. #68 recorded this after hitting it; #110 hit it again
 * on its first typecheck, and so did this file.
 */
export type ProductDemandMeasurement =
  | { readonly outcome: 'measured'; readonly score: number; readonly windowDays: number }
  | { readonly outcome: 'unavailable'; readonly reason: 'no_product_demand_metric_defined' };

/** Answer a product's demand, or say why there is none. */
export function resolveProductDemand(): ProductDemandMeasurement {
  return { outcome: 'unavailable', reason: 'no_product_demand_metric_defined' };
}
