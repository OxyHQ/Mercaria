# Checkout conversion report (paid: `advanced_demand_analytics`)

The v1 of the `advanced_demand_analytics` plan capability (#89). A store-scoped
report of how the store's own native checkouts turn into paid orders. The free
surfaces are unchanged: #77's `GET /admin/stores/:storeId/analytics/summary` and
the sales reports at `/admin/stores/:storeId/reports/*`.

## Routes

All three are `stats:read`, then `requireCapability('advanced_demand_analytics')`
(403 `PLAN_CAPABILITY_REQUIRED` without it). `from`/`to` are UTC calendar dates,
both inclusive, at most 92 days apart; the default is the last 28 days.

| Route | Answers |
|---|---|
| `GET …/analytics/advanced/listings` | store totals; per-listing checkouts started, paid, open, abandoned, units, conversion rate (published rows, most checkouts first, max 200); the count of suppressed listings; best and worst five converters |
| `GET …/analytics/advanced/trend?interval=day\|week` | every bucket in the window (zero-filled, ISO weeks from Monday), the window's totals, the same-length previous window's totals, and the change (relative for counts, points for the rate) when both periods are published |
| `GET …/analytics/advanced/export?report=listings\|trend` | the same report as CSV; suppressed cells read `suppressed_below_10`, formula-leading cells are defused |

Router: `routes/admin/conversion-report.ts`, mounted before #77's
`/analytics` router and separate from it. Service:
`services/conversion-report.service.ts`. SQL: `db/orders/conversionReportRepository.ts`.
Dashboard: `app/(app)/tools/demand-analytics.tsx`, behind `PlanToolGate`.

## What a figure means

- **Checkout started** — an order with `source_channel = 'storefront'` and no
  connector provenance, created in the window. POS sales, converted drafts and
  connector imports are not buyer checkouts on Mercaria and are excluded in the
  statement.
- **Paid** — its `payment_status` is `paid` or `refunded` (a later refund does
  not undo a conversion). **Abandoned** — cancelled without a settled payment.
  **Open** — everything else (awaiting payment). The three partition the started
  set.
- The conversion is a COHORT rate: checkouts created in the window, paid by now.
  A very recent window reads low until its open checkouts resolve.
- An order with several listings counts once for each listing, and once in the
  store total.

## Suppression

#77's rule with #77's constant (`ANALYTICS_MERCHANT_MIN_COHORT`, 10): a figure
set whose cohort (checkouts started, the largest of its checkout counts) is
below the floor is ZERO with `aboveThreshold: false` and a null rate — never
rounded. Applied per listing, per trend bucket and per period total. Suppressed
listings are counted, not listed. Units are not a cohort and never decide
publication. No response field names a buyer, guest, contact, address, order,
checkout group or buyer origin (`conversion-report.realdb.test.ts` walks every
key against an allow-list). Differencing across reports is not defended further
because every store role holding `stats:read` also holds `orders:read` and can
already see each underlying order — the same test pins that premise.

## Not in v1, and why

- **Product views, impressions, search terms.** #77 collection is `off` in
  production (`ANALYTICS_COLLECTION_MODE` unset → `off`; the privacy review in
  `docs/reviews/2026-08-16-analytics-privacy-retention-review.md` is unsigned),
  nothing emits `search_result_impression`/`search_result_click`, `checkout_started`
  carries no store id, the conversion rollups are platform-wide, and no search is
  linked to the listing it led to. A column built on that would be a confident
  zero. When collection is turned on, the next step is a per-listing rollup
  dimension written by `rollup.ts` (aggregate before the events expire), not a
  read of raw events.

## Plan semantics

A `flag` capability: nothing is consumed or released, and the tool stores no
rows. When a store's plan stops including it, the three routes answer 403 and
the screen shows the gate; nothing is deleted, and the free summary and sales
reports keep working.
