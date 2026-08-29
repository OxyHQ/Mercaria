# The unified offer model (#57, ADR 0002 D6/D8/D18)

`services/offers/` + `db/offers/` + `db/schema/offers.ts` (3 tables: `offers`,
`native_listing_links`, `offer_outboxes`). One seller/channel offering one exact
canonical variant on specific terms at a point in time — the row a comparison
surface reads, whether the seller is a Mercaria listing or a crawled retailer.
Schema decisions: `db/schema/CONVENTIONS.md` §"The OFFER layer". The rules that
are load-bearing:

- **Native checkout eligibility is a DERIVATION, never a column**, and this is
  the deliberate divergence from the `onboarding_state` one-verdict rule.
  Payment readiness is one stored verdict because its inputs sit on the row
  being verdicted; offer buyability is a conjunction over the LIVE
  `listings.status`, the LIVE variant stock and the seller's readiness — three
  tables this domain does not own. `deriveNativeCheckoutEligibility` reads them
  at PROJECTION time, so a moderation restriction stops a sale in the statement
  that applies it, with no queue in between. A realdb case pins it: the listing
  is restricted, the offer row is left ACTIVE and stale, and the read refuses.
- **An external offer cannot enter the cart, structurally.** Cart and checkout
  operate on `product_variants`, and `offers_kind_shape_check` forces
  `product_variant_id` NULL on every kind but `native` — there is no id a cart
  line could hold. `offer-isolation.test.ts` pins the other direction and four
  more walls (#58's matcher, #37's redirect, #84's linkage, #74's ranking), plus
  the ONE payment import the domain may make: the readiness seam.
- **Marketplace-ness is not storable.** The offer names its seller of record and
  its channel; the channel's operator is `storefronts.merchant_id`, one join
  away, and comparing them IS the fact (ADR D8). No `is_marketplace` column, no
  platform id copied onto the offer.
- **Unknown is stored as absence, never zero.** A nullable delivery money pair
  with a paired CHECK, a nullable `available_quantity`, and a three-member
  `pickup_state`. `deriveOfferDelivery` returns a discriminated union whose
  unknown branch has no `cost` property, so a ranking cannot read silence as
  free delivery without writing the coercion out loud.
- **Retirement is a status transition and the domain issues no DELETE.** The
  observed price history is the append-only `source_records` chain the offer
  points at — ADR D18 assigns a price-history TABLE to #78, and this one holds
  current state. `stale_at` is ONE deadline (the issue's expiry and the ADR's
  staleness are the same fact); the lapse sweep excludes NATIVE offers, whose
  deadline measures how long ago the converger ran.
- **`offer_outboxes` is one row per LISTING** — a convergence queue, not a
  delivery queue, so its enqueue is `ON CONFLICT DO UPDATE` where the moderation
  outbox's is `DO NOTHING`, and it carries no `expires_at`. The
  `requested_revision`/`claimed_revision` pair is what stops a write that lands
  mid-run being swallowed by the completion that follows it, and the enqueue
  must NOT write a flat `'pending'` over a `processing` row (that releases a live
  lease from outside the worker — measured, the realdb case fails on it).
- Three call sites request convergence: `syncListingFacets` (the existing
  catalog-write chokepoint, so every create/update/variant/stock change is
  covered), `archiveListing`, and moderation enforcement's restrict /
  request-changes / restore. A fourth status-only write path that forgot would
  leave a listing's offers claiming it is on sale.
- Public read: `GET /offers` (exactly one of `canonicalVariantId` /
  `canonicalProductId`, keyset-paginated cheapest-first). Operator surface:
  `/internal/offers/*` behind the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list
  #54/#56 use — trace, converge-now, retire (an EXTERNAL offer only; a native one
  follows its listing). Env: `OFFER_MATERIALIZATION_ENABLED` (gates the loop
  only), `OFFER_OUTBOX_BATCH_SIZE`, `OFFER_OUTBOX_POLL_INTERVAL_MS`.
- Load benchmark: `packages/backend/scripts/offer-load-benchmark.ts`, opt-in
  (`OFFER_BENCHMARK=1` plus a database whose name contains `bench`), Zipf-skewed.
  Deliberately NOT in CI.
- Deferred to their owners: the matching pipeline (#58 — `native_listing_links`
  is the seam and this domain never decides a match), the outbound/affiliate
  redirect (#37 — the routing metadata is modelled and `destination_url` stays
  the ORIGINAL), merchant→store linkage (#84), ranking (#74), the price-history
  table (#78), the `mercaria_retail` offer kind (#116).
