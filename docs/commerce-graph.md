# The canonical commerce graph: relationships, offers and matching

> #55, #57 and #58, moved out of `AGENTS.md` unchanged. ADR 0002 is binding.

## Verified relationships and evidence (#55, ADR 0002 D10/D11/D17)

`services/commerce-graph/relationship*.ts` + `db/commerce-graph/relationshipRepository.ts`
+ `db/schema/relationships.ts` (3 tables). Schema decisions:
`db/schema/CONVENTIONS.md` §"The relationship layer". A relationship is a typed,
scoped, temporal, evidence-gated CLAIM — never a boolean and never inferable.

- **No public badge from a name, a logo or a domain.** `verification_method` has
  no `name_match` member, so it is unrepresentable; `SUFFICIENT_EVIDENCE_KINDS`
  then decides which evidence kinds can carry which relationship kind, and
  `domain_control` is deliberately NOT sufficient for `official store`,
  `authorized reseller` or brand ownership — it proves control of that hostname.
- **Verification and confidence are different fields, and confidence is
  CHECK-restricted to ingestion rows.** A 0.99 candidate is a candidate; the
  public resolver filters on `verified` and never reads confidence.
- **Three of the issue's nine types are NOT kinds** — *merchant operates
  storefront*, *brand contains product family*, *brand markets product* are
  foreign keys (D17). `STRUCTURAL_GRAPH_FACTS` names them and a test fails the
  build if a kind duplicates one.
- **`Official store` and `Authorized reseller` are separate kinds, separate
  badges and separate LISTS** on a brand page; a merchant with neither has no
  relationship row at all, which is the normal state.
- **Duplicates are impossible, not refused**: a GENERATED `endpoint_key` +
  partial unique `WHERE valid_to IS NULL`. A plain multi-column unique would let
  them through — Postgres treats NULLs as distinct.
- **Four eyes** covers exactly the badge-producing kinds, defaults ON
  (`CATALOG_FOUR_EYES_REQUIRED`), and is held by a partial unique on
  `relationship_reviews`, not by a service comparison. `review_round` advances
  on every decision so an approval cannot be reused.
- **The public read never trusts `status` alone** — it requires the validity
  window too, so a lapsed claim produces no badge whether or not a sweep ran.
  Revocation keeps the row, its verification facts, its evidence and its reviews.
- Operator surface: `/internal/commerce-graph/relationships*` behind the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54 uses. Public reads:
  `/brand-relationships/*`. Ranking isolation is a test
  (`relationship-ranking-isolation.test.ts`), the fee-domain precedent.
- **The ranking use of verification is CLOSED, not deferred** —
  `services/ranking/facts.ts` is the ONE module #74 permits to read a
  verification, through the public finder, at one moment, and every other
  ranking module sees only a three-valued standing with no id, no evidence and
  no review state attached (`relationship-ranking-isolation.test.ts`, the
  fee-domain precedent's mirror: no commercial column exists on a relationship,
  the domain imports no fee/payment/referral module, and nothing else in
  discovery reaches it — named here rather than the wall being loosened).
- Deferred: #56's product families (`product_family_id` is a DEFERRED foreign
  key), and #83's claiming — claiming a merchant grants no relationship here,
  and there is no code path that could.

## The unified offer model (#57, ADR 0002 D6/D8/D18)

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

## Deterministic matching (#58, ADR 0002 D14/D19)

`services/matching/` + `db/matching/` + `db/schema/matching.ts` (9 tables).
Turning a source observation or a native listing variant into a canonical
product and variant. Schema decisions: `db/schema/CONVENTIONS.md` §"The MATCHING
layer". The failure mode that shapes everything here is the FALSE MERGE: it
looks exactly like a correct match, contaminates every product page and price
comparison downstream, and is discovered by a customer. The rules that are
load-bearing:

- **A conflicting valid identifier can never auto-merge, and that is a CHECK.**
  `match_decisions_blockers_auto_check` refuses `automatic_match` with a
  non-empty `blockers`, so brand mismatch, bundle/multipack/accessory confusion,
  a missing required axis, an operator's rejected pair and a closed category
  gate all stop a merge through ONE mechanism no service bug walks around. Two
  companion CHECKs stop the ways around it (a recorded conflict implies its
  blocker; every blocker appears in the explanation).
- **A semantic score is never the sole authority — and neither is a title.** A
  candidate with no positive value among identifier/brand/model/attribute
  agreement carries `no_deterministic_support`, which is a blocker. Semantics
  are off in THREE independent places (no scorer is registered, which is the
  shipped state; `MATCH_SEMANTIC_ENABLED`; the policy version's own flag), and a
  test runs the whole labelled dataset with all three off and asserts the
  decisions are byte-identical.
- **A category with no recorded qualifying benchmark run cannot match
  automatically.** `match_category_gates` cites its measurement by a NOT NULL
  COMPOSITE foreign key carrying the policy version, so an uncited gate and a
  gate citing another policy's run are both unrepresentable. The precision and
  sample floors are the service's, because a CHECK may not contain a subquery.
  **The identifier stages are deliberately NOT gated** — a check digit and a
  single active owner have no error rate a benchmark could measure, and gating
  them would make a fresh deployment unable to attach a single barcode listing.
- **An unknown feature is left out of the confidence DENOMINATOR**, never read
  as zero and never as the mean of the others. That arithmetic IS #58 rule 5:
  reading unknown as zero makes every unbranded P2P listing unmatchable.
- **A blocked pair is keyed on the STABLE subject identity**, not on the
  observation — `source_records` mints a new row per content change, so a
  rejection keyed on the observation would evaporate on the next crawl.
- **`create_new` is a RECOMMENDATION.** The matcher never mints a canonical
  product, never writes an `offers` row and never resolves an identifier
  dispute; a test fails the build if any of those change.
- **This closes #57's seam.** An automatic match on a native variant writes the
  `native_listing_links` row through #57's own repository and calls
  `requestNativeOfferSync`, in ONE transaction — so a native listing becomes a
  native offer end to end. The link's `method` is the STAGE that produced it
  (`barcode_gtin` with NULL confidence for a deterministic match, `matcher` with
  a number for a heuristic one, which is what #59 reviews).
- **The benchmark is a gate, not a fixture dump.**
  `services/matching/benchmark/` holds a versioned, content-addressed labelled
  dataset covering all eight case kinds the issue names; it runs against an
  in-memory catalogue so the whole set runs in CI on every push, sharing scoring
  and the policy with production byte for byte and simplifying only RETRIEVAL.
  A scale pass is opt-in behind `MATCH_BENCHMARK_SCALE`.
- Operator surface: `/internal/matching/*` behind the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57 use — metrics (queue
  AGE and ambiguity rate), traces, the review inbox, policy versions, category
  gates, blocked pairs, and triggers for one evaluation / one drain / one sweep
  page. Env: `MATCH_PIPELINE_ENABLED` (gates the LOOP only — the queue always
  accepts), `MATCH_QUEUE_BATCH_SIZE`, `MATCH_QUEUE_POLL_INTERVAL_MS`,
  `MATCH_SWEEP_BATCH_SIZE`, `MATCH_SEMANTIC_ENABLED`.
- Deferred to their owners: the correction/merge workflow (#59 — it consumes
  `match_decisions.review_state`, the candidate rows and `match_blocked_pairs`),
  bulk external ingestion (#37), the canonical minting a `create_new` recommends
  (#60), ranking (#74). Source observations are matched by the same pipeline but
  their ATTACHMENT (`canonical_*_source_links`) belongs to the ingestion path
  that owns the observation, not to the matcher.

