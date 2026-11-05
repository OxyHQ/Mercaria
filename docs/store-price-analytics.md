# Competitive price analytics (paid tool)

The `competitive_price_analytics` capability (#89, a `flag`): a NATIVE store's own
live listings against the other offers in their public comparisons, now and over
time. It is a separate tool from #82's free `/merchant-competitiveness/:merchantId`,
which is about a claimed canonical-graph merchant and stays free and unchanged.

## What it does

`GET /admin/stores/:storeId/price-analytics/listings` — for every live native listing
variant matched to a canonical product (an active native offer on an active listing of
the store), up to 200 per read with the total stated:

- the store's own price, in the listing's own currency, never converted;
- the OTHER sellers on the public comparison: how many, their lowest and their lower
  median price, and how many outliers were set aside;
- a position band — `lowest`, `near_lowest` (within 5% of the lowest), `at_or_below_median`,
  `above_median` — with both deltas in basis points;
- whether the store's own offer is shown on the public comparison right now;
- a summary by band, and `format=csv` for the same rows as a file.

`GET …/listings/:productVariantId/trend?windowDays=30|90&granularity=day|week` — the
listing's own lowest observed price per bucket against the other sellers' lowest and
median in that bucket.

Dashboard: `app/(app)/tools/price-analytics` (overview, filter by band, CSV) and
`tools/price-analytics/[productVariantId]` (trend chart and table), behind `PlanToolGate`.

## Whose rules

Nothing is re-derived here (`services/store-price-benchmark/`):

- **Current offers** come from #82's `buildPriceSignalContext`: #74's admission (stale,
  retired, suppressed, restricted and unbuyable offers are out), one identity per seller,
  other currencies converted for display once, at read time, with the rate's provider and
  date returned (`conversion`). Nothing stored is rewritten.
- **History** is #78's `derivePriceSeries`, run per seller so each contributes its own
  lowest admitted price per bucket.
- **Statistics and floors** are #82's: one price per seller, the modified-z-score outlier
  method, the lower median, and the ACTIVE price-signal policy's `minObservations`,
  `minDistinctSellers` and `minDistinctOffers`. With no active policy nothing is measured,
  which is the same honest empty state every #82 surface has — so **a price-signal policy
  must be published and activated for the tool to show figures**
  (`docs/price-signals.md` §Production-readiness).
- `minCoverageDays` is not applied to a cross-section: an instant's sample spans zero days
  and the CHECK holds the floor at ≥ 1, so applying it would refuse every comparison.
- The store itself is never its own market: its other listings and the canonical merchant
  it is verifiably linked to (`native_store_links`) are excluded.

## What it never does

- Names another seller. Rows carry counts and aggregates only;
  `STORE_PRICE_ANALYTICS_FORBIDDEN_FIELDS` is walked against a real response, and the
  realdb suite also checks no competitor id, name or URL appears as a VALUE.
- Changes a price, or suggests one. There is no recommendation, and the copy never relates a
  price to placement (a plan never buys reach) — `store-price-benchmark-isolation.test.ts`
  scans the dashboard copy, and asserts the tool writes nothing and is unreachable from the
  ranking surface (and reaches no ordering engine directly).

## Authorization and the plan

`analytics:read` ("what is the market doing around my products"; owner, admin and billing by
default), then `requireCapability`. Every route computes a new report and the tool stores
nothing, so when a plan ends the screens show the plan gate and nothing of the store's is
withheld. Its own rate-limit bucket, `rl:storePriceAnalytics:`.
