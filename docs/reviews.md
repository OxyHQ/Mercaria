# Review scopes, eligibility and aggregates (#76)

The reference for Mercaria's review domain. The schema decisions are in
`packages/backend/src/db/schema/CONVENTIONS.md` §"Review scopes (#76)"; this
document is the behaviour.

## The problem, stated once

Before #76 a review named a `listing`, a `store` or a `seller`, and every one of
them fed a single star average. "The courier lost it" and "the fabric tore"
landed in the same number, so the number answered neither question. Worse, the
two are attributable to different people: a manufacturing defect is not the
seller's fault and a slow delivery is not the model's.

A rating now answers ONE question, and which question is a stored fact.

## The five scopes

| Scope | Question | Target |
|---|---|---|
| `product` | How is the product itself? | `canonical_products.id` |
| `merchant` | How was the seller's service? | `merchants.id` |
| `native_transaction` | How was this purchase? | `order_items.id` |
| `p2p_listing` | Did the item match its condition and description? | `listings.id` |
| `p2p_seller` | How was this seller to buy from? | an Oxy account id |

`p2p_listing` is the issue's own name and the `p2p_` prefix records where the
requirement came from (used-goods feedback), not a restriction on who owns the
listing: a review of a listing is feedback about THAT listing whoever sells it,
and promoting a store listing's review to `product` needs a canonical link
nobody has yet (see "What is deferred").

**`native_transaction` has no public star rating.** An order line has no rating
column, and `SCOPES_WITH_ENTITY_PROJECTION` excludes it deliberately: a
transaction review is a buyer's account of one purchase, not a public score on
somebody's order.

### Two columns, and why they are not one

`reviews.target_type` says which COLUMN holds the thing being rated;
`reviews.scope` says which QUESTION the rating answers. `target_type = 'listing'`
cannot say whether a review is about the product or the condition of one used
copy — that ambiguity is what #76 exists to resolve — so the two are separate
facts tied by `reviews_scope_target_type_check`, rendered from the same
`REVIEW_SCOPE_TARGET_TYPE` map every consumer reads.

A NULL `scope` means exactly one thing: the classification job has not decided,
or has decided it cannot. `classification_state` says which.

### A brand rating is unrepresentable

Four independent places, and none of them is a default somebody can change:

1. **The vocabulary.** `REVIEW_FORBIDDEN_SCOPES` (`brand`, `organization`,
   `product_family`, `category`, `platform`) is DISJOINT from `REVIEW_SCOPES`,
   asserted by a test.
2. **The schema.** No review, eligibility or aggregate table has a brand-shaped
   column, so the row has nowhere to be stored.
3. **The API.** `assertScopeAllowed` refuses each by NAME — "Mercaria does not
   compute a brand rating…" rather than "unrecognized value", which reads like
   a typo and teaches whoever hit it to look for one.
4. **The reach.** No module in the domain imports the brand layer, scanned with
   a vacuity floor and a mutation self-test.

## Eligibility: the right to review

`review_eligibilities` is a durable grant: *this Oxy account may write ONE
review of this scope and target, because this order line says they bought it.*
It is separate from the review so an order correction, a moderation action and a
claim audit stay explainable independently of whatever text was written.

**The evidence is an ORDER LINE and nothing else.** There is no email column, no
phone column, no payment-method column, no card-fingerprint column, no session
column and no referral column — so a matching email, a Stripe Customer, a
wallet, a saved card, an affiliate click, a conversion report, a portal token or
possession of a guest session has nowhere to be recorded as the reason a row
exists. `REVIEW_FORBIDDEN_EVIDENCE_SOURCES` names all fourteen so a refusal says
which one it refused, and the two unions are disjoint.

### What one purchase unlocks

`grantEligibilitiesForOrder` runs on the `paid` transition and, per line, grants
`native_transaction` always plus whichever of `product`, `merchant`,
`p2p_listing` and `p2p_seller` the line RESOLVES to. A scope it cannot resolve is
SKIPPED with a stated reason rather than failing the whole grant: a line whose
variant resolves to no canonical product still earns the transaction review the
buyer can definitely write.

Idempotent by `UNIQUE(order_item_id, oxy_user_id, scope)` plus
`ON CONFLICT DO NOTHING`. A `paid` transition delivered twice, a claim retry, a
migration replay and two concurrent grants all end at exactly one row.

### Spending it

`createReview` resolves the eligibility, refuses a self-review, refuses a
duplicate, then SPENDS it before writing. The spend is a CAS on `state = 'open'`,
so two concurrent submissions produce one winner; `reviews_eligibility_id_key`
is the second, independent wall.

A review with no eligibility is written `unverified` — labelled, counted
separately, never blended into the headline rating. It is not refused: that is a
weighting decision, and the aggregate is where it belongs.

### Self-review, and the honest boundary of it

Two independent layers:

1. **The purchase.** If the seller on the eligibility's order is the author, the
   review is refused whatever scope it claims — including `product`, which has
   no owner of its own. This is the layer that cannot be routed around by
   choosing a different target.
2. **Ownership of the target.** A P2P seller reviewing themselves, a store
   member reviewing their own listing, a merchant's verified claimant or its
   linked store's staff reviewing the merchant. `store_members` is the "related
   accounts" signal Mercaria has.

What is NOT detectable, stated rather than implied: a seller buying their own
product from a different seller, a friend, a second personal Oxy account with no
store membership, an agency reviewing a client. Distinguishing those would mean
reading the buyer-contact and payment data this domain spends its whole design
keeping out. Out of scope, deliberately.

The refusal message is UNIFORM across every branch: naming the relation would
tell an author which of their accounts Mercaria has associated with which store.

### The #109 guest seam

`grantEligibilitiesForClaimedGuestOrder(orderId, evidence)` is the contract #109
will call. `GuestOrderClaimEvidence` is `{claimId, checkoutGroupId,
claimedByOxyUserId, bothSidesProven}` — every field a fact #109's claim service
already establishes (ADR 0003 D14), and none of them a contact detail.

**It FAILS CLOSED today**, and every layer refuses:

- `bothSidesProven: false` → refused, naming the email match it is not;
- a missing claim id or claiming account → refused;
- an order outside the claimed checkout group → refused;
- and then unconditionally, because `orders` has no `buyer_origin` column until
  #106 and no `claimed_by_oxy_user_id` until #109, so Mercaria cannot verify
  that the order began as a guest purchase and will not guess.

At the storage layer, `review_eligibilities_claim_check` makes a
`claimed_guest_purchase` row without a claim id unrepresentable — so no code
path and no hand-written statement can invent one.

## Aggregates

`review_aggregates` (+ `review_dimension_aggregates`) is the ONE authority for a
scoped rating. `canonical_products.rating`, `merchants.rating`,
`listings.rating` and `seller_profiles.rating` are PROJECTIONS of it: written by
`review-aggregate.service` alone, in the same call, from the same derived
figures.

**Everything derives; nothing increments.** `rebuildScopedAggregate` reads the
review rows and SETs the answer, which is what makes it idempotent — and
idempotence is what lets moderation call it after hiding a review without
knowing whether the sweep already did.

**Verified and unverified never blend.** One query with two `filter (where …)`
aggregates, stored in two column pairs. There is no combined average and no
`total_count` column anywhere, so a serializer that wanted to blend them would
have to compute the blend itself, in the open.

**Guest origin is not a dimension.** There is no column for it. A claimed guest
purchase produces an ordinary verified review with ordinary weight.

### A native store's rating comes from ONE place

`resolveStoreRatingSource(storeId)` returns EITHER the merchant aggregate (when
the store resolves to a canonical merchant through an active `native_store_links`
row) OR the store's own legacy aggregate — one value, from one function, naming
which it is. That is "merchant and native-store linkage must not double-count one
review in two public aggregates" answered structurally: nothing ever holds both,
so nothing can add them.

Classification is the other half: a store review that becomes a merchant review
stops matching the legacy `store` filter in the same statement that starts it
matching the merchant one.

### The rebuild sweep and drift

`rebuildReviewAggregates` is bounded, resumable and walks TWO work lists:

- every scoped target that HAS published reviews, so a new one gets a row;
- every aggregate row not rebuilt since a cutoff, so a target whose last review
  was hidden or deleted stops claiming a rating. That row appears in no
  review-derived list precisely because it has no reviews left, which is what
  makes it the dangerous one.

Drift is REPORTED, not swallowed: the sweep converges the stored figures (it IS
the repair) and returns what it had to change, so a persistent disagreement is a
number rather than silence. Zero drift over many runs is the healthy reading.

Scheduled daily at 03:20 (`SCOPED_AGGREGATE_SWEEP_CRON`), twenty minutes after
the legacy sweep and twenty before the classification job — the three walk
disjoint sets and staggering them keeps a shared Postgres from taking all three
scans at once.

## Migration

`classifyLegacyReviews` is bounded, resumable and never guesses. Its cursor is
the `classification_state` column itself: a decided review leaves the predicate,
so a re-run cannot revisit it and a crash costs at most one batch.

| Legacy target | Becomes | When |
|---|---|---|
| `seller` | `p2p_seller` | always — the target IS an Oxy seller id |
| `listing` | `p2p_listing` | always — a listing review describes THAT listing |
| `store` | `merchant` | only with an ACTIVE `native_store_links` row |
| `store` | *(refused)* | otherwise, `store_has_no_linked_merchant` |

Two of those look like guesses and are not:

- a **listing** review is NOT promoted to `product`. Mercaria cannot know whether
  the author meant the model or the copy that arrived, and reading it as a
  product review would put "arrived scratched" on a canonical product's quality
  rating — acceptance criterion 1, failed by exactly that inference;
- a **store** review with no merchant link is LEFT where it is with the missing
  fact recorded, and the legacy read path keeps serving it unchanged.

`unclassified` and `ambiguous` are different states on purpose: "we have not
looked" and "we looked and could not tell" need different follow-up, and
collapsing them turns a decision into a backlog. Refused reviews are not
re-examined by default — they are waiting for a FACT to arrive — and an operator
re-runs with `includeAmbiguous` after landing it.

**Legacy reads keep working** through the compatibility window:
`GET /listings/:id/reviews` and `GET /stores/:handle/reviews` are unchanged, and
`recomputeAggregate` still maintains the legacy projections for
`listing`/`store`/`seller` targets. Its work list excludes every scoped row, so
a review never has two rebuild paths writing two tables from two queries.

### Merges and splits

A canonical product MERGE rehomes the loser's product reviews onto the winner
inside the merge's own transaction, appends one `review_target_migrations` row
per review, and rebuilds BOTH aggregates after the commit. A buyer who
legitimately reviewed both products keeps both: the collision is read FIRST and
excluded (the unique index would otherwise abort the whole merge), the review
stays on the tombstone — which still resolves through `merged_into_id` — and it
is reported as needing an explicit decision.

A SPLIT cannot be inferred, so `assignReviewOnSplit` takes ONE review and ONE
destination from a named operator and records who decided.

`review_target_migrations` is append-only by trigger, because `reviews.scope`
answers where a review points NOW and cannot answer where it pointed before.

## Moderation

Unchanged. `POST /reports` → the outbox → CrowdSource → a signed decision →
`enforcement-plan.ts` → `setReviewStatusIfIn(reviewId, 'hidden', ['published'])`.
The plan table, its mapping and its tests are untouched.

What #76 adds is one line on each side of that CAS: after hiding or restoring a
review, its scoped aggregate is re-derived. Best-effort and idempotent — the
enforcement has already committed, and the sweep re-derives it anyway, so a
failure here must not turn a successful takedown into a retryable one that would
re-claim its ledger row.

Review moderation stays separate from product-data correction (#56's operator
surface) and from payment disputes (#49). None of the three imports another.

## Privacy

- Authorship is public Oxy identity or nothing. The fallback label on a card
  whose profile did not resolve is "Mercaria buyer" — not "Verified buyer",
  which claimed a verification the card could not know, and not anything derived
  from an email, initials or a generated handle.
- The evidence API exposes verification STATUS: the scope, the target, the
  evidence type and the state. It exposes no contact or payment identifier
  because `ReviewEligibility` has no field for one.
- A merchant cannot learn whether a claimant's Oxy email matched a guest email,
  because nothing in this domain reads an email at all.
- Guest origin never reduces weight. There is no origin column and no weight
  column anywhere in the domain.
- Claiming an order does not auto-publish, prefill sentiment or generate text:
  the prompt's star picker and note both start empty.

## The API surface

| Route | Auth | What |
|---|---|---|
| `GET /reviews/product/:canonicalProductId` | public | product reviews + the scope's aggregate |
| `GET /reviews/merchant/:merchantId` | public | merchant reviews + the scope's aggregate |
| `GET /reviews/eligibilities` | Oxy | what this account may still review |
| `GET /reviews/eligibilities/order/:orderId` | Oxy (owner) | one order's eligibilities |
| `POST /reviews` | Oxy | write a scoped review |
| `GET /listings/:id/reviews` | public | LEGACY, unchanged |
| `GET /stores/:handle/reviews` | public | LEGACY, unchanged |

The scoped reads return the aggregate ALONGSIDE the page, so the stars a page
shows and the reviews it lists come from one read. A client that averaged the
twelve reviews it received would display a number that is not the target's
rating — which is what the product page did before #76, and what #75's
structured data must not mirror.

`createReviewSchema` is `.strict()`, and that is load-bearing rather than tidy:
every field a forbidden evidence source would arrive in is refused before any
handler sees it. `targetType` is derived server-side from the scope, so a client
cannot send a pair that disagrees.

## What is deferred, and to whom

- **#106 / #109 — guest checkout and claiming.** The seam above, failing closed.
  When both land, `grantEligibilitiesForClaimedGuestOrder` drops its final
  refusal, `review_eligibilities.claim_id` becomes a real foreign key, and
  nothing else in this domain changes.
- **#57 / #71 — `native_listing_links`.** Today a listing resolves to a canonical
  product only through the identifier collision gate: the ACTIVE owner of the
  purchased variant's barcode, and only when every barcoded variant of the
  listing agrees. When the real link lands it becomes the FIRST resolution
  attempted and this stays as the fallback. Neither guesses. Until then a listing
  with no barcode shows no product reviews on its page — which is honest, and is
  why the listing's own condition feedback is always shown beside them.
- **#75 — structured data.** The aggregate a page exposes is the one it displays,
  because they are the same object from the same read. Nothing else is needed
  from this domain.
- **Merchant responses.** #76 names them as separately authored and moderated
  content. Not built; there is no column for one, which is the right starting
  point for whoever does build it.
- **An operator surface.** The classification job and the split assignment are
  reachable from the queue and from code, not from an HTTP route. A fourth
  operator allow-list beside payments, catalog and guest-commerce is a decision
  worth making deliberately rather than as a side effect of this issue.
