/**
 * What #86 asks for that this repository cannot yet measure, stated as NAMED
 * contracts that fail closed.
 *
 * Not a registry with a `register…` function, deliberately — #74's and #82's
 * `seams.ts` reasoning, which is #62's fixture-adapter reasoning: a registry is
 * a place a test-only provider can be installed in production. Each of these is
 * ONE function body its owning issue replaces.
 *
 * The rule every one of them follows: a seam answers `unavailable` with a
 * reason and NO number. A metric reading zero and a metric that cannot be
 * measured look identical on a chart and mean opposite things, and on a
 * merchant-facing dashboard the first one says "nobody wanted your products".
 */

import type { MerchantDemandValue } from '@mercaria/shared-types';

/**
 * #86 fact 9 — CLOSED, and what closed it is worth reading.
 *
 * This was a seam while #82 was in review, and it stayed one for a day after
 * #82 merged, for a reason that was not "the issue has not shipped":
 * `readMerchantCompetitiveness(...).coverage` is scoped by
 * `(claimant credential, condition SEGMENT, comparison CURRENCY, keyset page)`
 * and a demand snapshot is scoped by `(merchant, market, window)`. Consuming it
 * directly would have made the figure present or absent depending on WHO asked,
 * and would have published a rate describing one condition segment in one
 * arbitrary currency under a label that reads as "all of them".
 *
 * What closed it was not a wiring change but a second, honestly-named function
 * in #82's OWN domain: `countMerchantComparableSubjects`. Two things make it an
 * exact aggregation rather than a rival definition — every input is a
 * `MerchantCompetitivenessRow.state` from the same `buildSubjectRows` the
 * merchant surface renders from, and neither the segment nor the currency is
 * chosen by anybody: each subject is evaluated in the condition it declares and
 * the currency the merchant listed it in. So there is nothing left here to
 * resolve, and the metric is measured.
 *
 * The one thing that must NOT happen is a coverage figure derived in
 * `services/merchant-demand`. It would be a second answer to a question #82
 * owns, and a flattering one — "how many of your products can Mercaria compare"
 * is about the depth of the market around them, not about how many you have.
 */

/**
 * Network-reported conversions, commission and external order value (#86 fact
 * 5, from #37).
 *
 * ALWAYS unavailable — but no longer because #37's redirect does not exist.
 * #67 built `/out/:token`, the click record and the commission
 * reconciliation (`affiliate_transactions`, `affiliate_transaction_observations`,
 * `affiliate_commission_postings`); nothing in `services/merchant-demand`
 * reads any of them yet. Wiring this seam is reading those tables SCOPED to
 * one merchant's own offers, not composing a second aggregation over them —
 * #67's own `/internal/affiliate/*` reports the totals Mercaria measures
 * whole, never per merchant.
 *
 * **What it must NOT become.** #77's own seam contract for #37 is binding here
 * and says it in one sentence: a network conversion may never be DERIVED from
 * an `external_outbound_click`, and the two may never be divided into a
 * "conversion rate" — network reports are revisable for weeks and a click is
 * not, so the ratio would move without either input being wrong. #86 acceptance
 * 2 ("outbound clicks are not labelled as sales") is the same instruction from
 * the other side, and this domain holds it in the TYPE as well: a click is an
 * `observed_interaction` and a conversion is an `affiliate_conversion`, so
 * nothing can add them.
 */
export function resolveNetworkReportedFigure(): MerchantDemandValue {
  return { state: 'unavailable', reason: 'awaiting_seam', seam: '#37' };
}

/**
 * Client-emitted discovery facts — search-result impressions, outbound clicks
 * and the native cart funnel (#86 facts 1, 4, 6 and 10, from #111).
 *
 * A search-result impression, an add-to-cart attributable to one merchant and a
 * checkout start attributable to one store are three different reasons for the
 * same answer, and they are worth keeping apart:
 *
 *  - `search_result_impression` is a VIEWPORT fact only a browser knows, and
 *    the storefront has no analytics client at all (#111 owes one). Deriving it
 *    from "the results page was served" would count rows nobody scrolled to,
 *    which inflates every merchant's denominator by the length of the page.
 *  - `native_add_to_cart` IS emitted, and carries a listing and a variant with
 *    no store or merchant dimension. Scoping it would mean a join on the read
 *    path of a report, and the honest fix is for the emitter to carry the
 *    dimension.
 *  - `checkout_started` is emitted per checkout GROUP, which spans several
 *    sellers. One event cannot name one store, so there is nothing to widen —
 *    the metric needs a per-order event that does not exist.
 *
 * `unavailable_click_rate` waits on #37 rather than on #111: the numerator and
 * the denominator are both outbound clicks.
 */
export function resolveClientDiscoveryFigure(): MerchantDemandValue {
  return { state: 'unavailable', reason: 'awaiting_seam', seam: '#111' };
}

/**
 * Price-alert demand (#86 fact 7's second half) — REFUSED, not deferred.
 *
 * #79 built the alert domain so that nobody can ask who is watching a product:
 * there is no route, no operator handle and no repository function that takes a
 * product, a merchant or an account, and `price_alerts_subject_idx` is
 * composite-and-partial precisely so it cannot serve one. That is a stated
 * design property of #79, not a gap in it.
 *
 * Publishing a floored aggregate of alert subscribers is therefore #79's
 * decision to make and #79's floor to choose, in #79's own domain — the same
 * reasoning #80 already applies to save counts, where the floor and the
 * disclosure function live with the data rather than with whoever wants to show
 * it. Reaching past that from here would put a second disclosure policy on a
 * count whose owner deliberately published none.
 *
 * The reason code says so rather than pretending an issue owes work:
 * `alert_subject_counts_unrepresentable`.
 */
export function resolvePriceAlertDemand(): MerchantDemandValue {
  return { state: 'unavailable', reason: 'alert_subject_counts_unrepresentable', seam: '#79' };
}

/**
 * Zero-result demand for a merchant (#86 fact 8) — REFUSED on the issue's own
 * condition.
 *
 * #86 asks for zero-result demand "for products associated with the merchant
 * ONLY WHEN THE RELATIONSHIP IS DEFENSIBLE", and for a zero-result search there
 * is no defensible relationship to establish: the search returned nothing, so it
 * names no product, and `analytics_search_queries` carries normalized tokens
 * with no product association and no actor column at all.
 *
 * The two ways to manufacture one are both wrong. Matching the query's tokens
 * against a merchant's product titles attributes a stranger's search to whoever
 * happens to sell something with a similar name — and it does so most
 * confidently for the biggest catalogues. Matching against the CATEGORY filter
 * in force is the same error with a coarser brush.
 *
 * `demand_without_native_offer` is the half of fact 8 that IS defensible and it
 * is computed: a product the merchant demonstrably offers, with measured views,
 * and no active native offer.
 */
export function resolveZeroResultDemand(): MerchantDemandValue {
  return { state: 'unavailable', reason: 'relationship_not_defensible', seam: '#70' };
}
