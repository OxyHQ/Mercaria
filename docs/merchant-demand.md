# Merchant demand analytics and the acquisition pipeline (#86)

The full reference for the merchant demand domain. `AGENTS.md` carries the rules
that are load-bearing across domains; this document carries the mechanics, each
metric's provenance, the disclosure policy, the acquisition workflow and the
seams.

Both merchant-facing surfaces are **OFF** by default
(`MERCHANT_DEMAND_ENABLED=false`, `MERCHANT_DEMAND_PREVIEW_ENABLED=false`), and
every event-sourced figure additionally reports `collection_disabled` while
#77's `ANALYTICS_COLLECTION_MODE` is `off`, which is also its default.

---

## What this domain measures, and the one thing it must never do

It answers "how much demand does Mercaria carry for this merchant, and can the
merchant act on it". It never answers "who wanted it". There is no actor, buyer,
session, pseudonym or query column anywhere in its seven tables, and
`merchant-demand-isolation.test.ts` walks the REAL drizzle tables and fails the
build if one appears.

The failure mode that shapes the whole design is a **number that reads as a
fact and is not one**: a zero that means "we were not counting", a click
rendered as a sale, a rounded figure larger than what happened, a coverage rate
Mercaria computed about itself, and a product-level row over four shoppers.

---

## Three audiences, one registry

`MERCHANT_DEMAND_METRICS` in `@mercaria/shared-types` (`src/merchant-demand.ts`)
is nineteen definitions, each naming its numerator, denominator, source,
human-only flag, disclosure flag, **attribution limit** and — where its inputs
do not exist yet — the issue that owes them.

| Audience | Surface | What they get |
|---|---|---|
| An UNCLAIMED merchant | `GET /merchant-demand/:id/preview` | Four counts, rounded DOWN to two significant figures, above a floor of 100, in visit nouns |
| A CLAIMED merchant | `GET /merchant-demand/:id` | Every metric, product-level rows above a floor of 25, the definitions, and a CSV export |
| An operator | `/internal/merchant-demand/*` | The scored acquisition pipeline, the generated outreach context, and the audit trail |

All three read the same registry, so a figure on the preview and a figure on the
dashboard are the same measurement with different disclosure applied rather than
two computations that can disagree.

---

## The ten facts #86 names, and what each actually reads today

| # | Fact | Metric key(s) | Today |
|---|---|---|---|
| 1 | Search-result impressions | `search_result_impressions` | seam #111 — a viewport fact only a browser knows |
| 2 | Product-page views with an eligible offer | `product_page_views_with_offer` | **measured** |
| 3 | Offer impressions | `offer_impressions` | **measured** |
| 4 | Human outbound clicks | `human_outbound_clicks` | seam #37 — the redirect does not exist |
| 5 | Network conversions and commission | `network_reported_conversions`, `affiliate_commission`, `external_order_value` | seam #37 |
| 6 | Native funnel after activation | `native_offer_views` **measured**; `native_add_to_cart`, `native_checkout_starts` seam #111; `native_paid_orders`, `native_gmv` **measured from `orders`** |
| 7 | Saves and alerts as thresholded demand | `product_save_demand` **measured** through #80's own floor; `price_alert_demand` REFUSED |
| 8 | Zero-result / no-offer demand | `zero_result_demand` REFUSED; `demand_without_native_offer` **measured** |
| 9 | Price-competitiveness availability | `subjects_with_a_price_comparison` | **measured**, through #82's own `countMerchantComparableSubjects` |
| 10 | Catalogue freshness and unavailable clicks | `catalog_freshness_rate` **measured** through #68; `unavailable_click_rate` seam #37 |

### The four labels that may never be merged

`MerchantDemandMetricKind` is what #86's "keep affiliate commission, external
order value, native GMV and inferred demand as separately labelled metrics"
becomes mechanically. Two of the money kinds are amounts a NETWORK reported and
is still revising, one is money that moved through Mercaria's own ledger, and
`inferred_demand` is not money at all. There is no `total`, `sum`, `combined` or
`revenue` field anywhere in the domain and no such COLUMN in any of its tables
(a gate walks them), so an addition across kinds has nowhere to be written down.

### Outbound clicks are never labelled sales

A click is an `observed_interaction` with the noun `visits`; a conversion is an
`affiliate_conversion`. Different kinds, so nothing can add them; and
`MERCHANT_DEMAND_COUNT_NOUNS` has no sales member at all, so the copy cannot
drift into one either. #77's own #37 seam contract additionally forbids DIVIDING
the two into a conversion rate, and that still binds: a network report is
revisable for weeks and a click is not, so the ratio would move without either
input being wrong.

---

## Unknown is never zero

`MerchantDemandValue` is a three-way union:

- `measured` — carries a `count`, a `{amount, currency}` or a
  `{numerator, denominator}`, and nothing else.
- `suppressed` — carries the FLOOR and no count. A bound is a disclosure too, so
  "under 25" is not offered either.
- `unavailable` — carries a REASON and no measure at all.

The reasons are six and each is a different thing to do about it:
`awaiting_seam` (somebody else's issue), `collection_disabled` (this
deployment's own configuration), `merchant_scope_absent_on_event` (a dimension
the emitter never carried), `relationship_not_defensible` and
`alert_subject_counts_unrepresentable` (decisions that a figure must NOT be
produced), and `no_native_activation`.

**A metric that cannot be answered is still STORED**, with its reason. Omitting
the row would make "we did not measure it" and "this version has no such metric"
the same absence, and a dashboard would render neither.

### Collection off is not zero demand

Every metric sourced from `analytics_events` answers `collection_disabled` when
`ANALYTICS_COLLECTION_MODE` is `off`. Without that, the first snapshot any
deployment ever builds reports that nobody wanted anything from anybody, which
is the single most damaging false statement this domain could make.

---

## The snapshot

`merchant_demand_snapshots` + `merchant_demand_metrics` +
`merchant_demand_products`. A snapshot is a RECORDING — the
`payment_discrepancies` posture — and reproducibility is what it is for, so it
carries the event policy version, the attribution policy version, the collection
mode in force, both floors, the window and `data_fresh_as_of` (the newest
durable observation the build could see, which is a different instant from
`window_to` and is what makes "this number is two days behind" sayable).

- **A correction is a NEW snapshot that SUPERSEDES the old one.** The
  immutability trigger permits `superseded_at`/`superseded_by_id` moving NULL →
  a value exactly once and refuses every other UPDATE. When a network revises a
  report weeks later, the figure a merchant was shown in March is still on file
  beside the one that replaced it.
- **The supersede runs BEFORE the insert**, which is why the successor's id is
  minted with `uuidv7()` in the repository and why `superseded_by_id` carries no
  foreign key: the row it names does not exist yet at the moment it is written.
- **DELETE is PERMITTED**, inverting the ledger and matching `analytics_events`
  and `offer_price_snapshots`: erasure on a schedule IS the policy, and a
  trigger refusing DELETE would make the shared expiry sweep fail silently on
  every row it was obliged to remove. The two child tables CASCADE.
- **The coverage counters must ADD UP** — `products_offered =
  product_rows_disclosed + product_rows_suppressed`, a CHECK with equality. A
  report that lost a product row between counting and writing cannot be stored,
  which is #60's vacuity floor applied to a report.
- The `channel`, `storefront_id` and `source_id` dimensions exist on every
  metric row, CHECK-admitted, and are written `''` today. #86 snapshot items 6
  and 7 are therefore a WRITE away rather than a migration.

### Attribution: the merchant's CURRENT offer set

An `analytics_events` row names a canonical product, an offer, a merchant or a
storefront — never all four. A merchant's demand over PRODUCTS is therefore
measured by resolving the canonical products it currently offers and counting
events on those, which is what #86 fact 1 asks for in those words. The cost is
stated on every affected definition rather than hidden: **a product added during
the window contributes interactions from before it was added.**

Bots are excluded in the PREDICATE (`traffic_class in
ANALYTICS_HUMAN_TRAFFIC_CLASSES`), never at read — #77's rollup makes the same
choice for the same reason.

---

## Disclosure

| Floor | Value | Applies to | Why |
|---|---|---|---|
| `MERCHANT_DEMAND_AGGREGATE_MIN_COUNT` | 10 (= `ANALYTICS_MERCHANT_MIN_COHORT`) | every aggregate metric | "How many people saw my products" is the same question #77's merchant summary answers, and two floors for one question is two numbers that can be differenced |
| `MERCHANT_DEMAND_PRODUCT_MIN_COUNT` | 25 | a product-level ROW existing at all | A product row is a much finer slice of the same population; #77's query floor is the precedent |
| `MERCHANT_DEMAND_PREVIEW_MIN_COUNT` | 100 | every preview line | The reader is whoever asked, and has not proved they are the merchant |

- A product row below the floor **does not exist**, rather than existing and
  being filtered at read — a suppressed row that was stored is one query away
  from being read. The snapshot's `product_rows_suppressed` counter is how many
  were withheld.
- The product floor is applied to the LARGER of a product's two counts, not to
  each independently: suppressing per field publishes the one that cleared it
  and bounds the one that did not, which is the differencing attack the floor
  exists to stop.
- `product_save_demand` applies **#80's own** `discloseProductSaveCount` per
  product BEFORE summing. Summing first and flooring the total would publish a
  sum over products #80 withholds individually.
- `native_gmv`'s floor is applied to the ORDER COUNT, never to the amount:
  suppressing on the money would disclose that the amount was small, and a
  merchant with three large orders is exactly as identifiable as one with three
  small ones.

### ### The aggregate and the breakdown are ONE partition

The defence the first four missed. An aggregate and a product breakdown that sum
over the **same population at different grains** are a differencing attack:
publish the exact total and the rows above the floor, and every withheld row is
the subtraction. Two products, A at 30 views and B at 6 — the total says 36, the
breakdown shows A, and 36 − 30 is B's exact count, below both floors.

Every product-composed figure (`product_page_views_with_offer`,
`offer_impressions`, `native_offer_views`) is therefore built from the SAME
`ProductPartition` the rows are, as **the disclosed rows plus at most one
residual** over the withheld ones. The residual is published only when BOTH
clear:

- the **value floor** — the aggregate floor, bounding how large a published
  residual is; and
- the **contributor floor** — `MERCHANT_DEMAND_RESIDUAL_MIN_CONTRIBUTORS`,
  which is 2 and may never be 1.

The second is the one that matters. A value floor alone does not save you: with
a single sub-floor product the residual IS that product's count, so a residual
of 40 over one contributor discloses 40 exactly while clearing any floor. The
floor bounds the size of what is published; the contributor count bounds how
many things it could be about, and only the second makes a subtraction
ambiguous. Two is the smallest number that makes it ambiguous at all, and more
would be expensive — a long tail of one-view products would fold the residual
away permanently.

When the residual is folded away the figure becomes what it then is: a total
over the **disclosed rows**, and `aggregateBasis` says so on the metric row, in
the DTO and in the CSV column. Suppressing the aggregate entirely was the other
option and is worse — with a long tail something is below the floor almost
always, so the metric would be permanently withheld and the column unreadable.

One consequence worth stating: a merchant with ONE product below the product
floor now gets a suppressed aggregate rather than a number, because the number
would have been that product's count. That is the leak, not a regression — and
two pre-existing tests were asserting it, seeding a single product and expecting
its exact figure back through the aggregate. They now seed above the product
floor; neither is about the residual policy, so weakening the policy to keep
them green would have been the wrong direction.

The residual case carries a STATED UNKNOWN rather than a tidy story. It went red
once at 16 instead of 17 under full-suite load — one seeded view uncounted —
and did not reproduce in four attempts. Window arithmetic of any kind is ruled
out STRUCTURALLY: the fixture computes one shared `occurredAt` per call and
inserts the whole batch in a single bulk `values()`, so a boundary can only
include or exclude an entire batch atomically — it cannot drop one of nine
identically-timestamped rows. (The comparisons are also correct: `[from, to)`
with `gte`/`lt`, every event twelve hours inside the upper edge.) A recurrence
belongs to bulk-insert or transaction visibility, or to the harness. The case now
asserts the composition invariant against what the database actually holds and
the security property separately, so a recurrence names which claim broke
instead of conflating three.

### Windows and markets are CLOSED sets

Overlapping windows difference exactly as grains do — 30 days minus 29 days is
one day, and one day of one product's demand is where a single person lives.
With `refresh=true` a free integer lets a claimant walk the boundary a day at a
time, so `windowDays` is `MERCHANT_DEMAND_WINDOW_DAYS` (7, 30, 90) and a rules
test asserts no two members differ by one.

`market` is the same shape of problem — every-market minus ES is the rest of the
world — so it is a closed set too, `config.merchantDemand.markets`, **empty by
default**. Until a deployment names markets the only askable value is the
undimensioned bucket, so the surface cannot be sliced at all.

The preview partition is TOTAL

`MERCHANT_DEMAND_PREVIEW_METRIC_KEYS` and
`MERCHANT_DEMAND_PREVIEW_FORBIDDEN_METRIC_KEYS` are disjoint AND together cover
the registry exactly. A metric in NEITHER fails the build — a gate that skips
what a hand-maintained map omits is not a gate, and a twentieth metric added
without a decision would otherwise default into whichever behaviour the code
happened to have.

`roundPreviewCount` rounds **down** to two significant figures. Down rather than
to nearest, because a rounded figure shown to a merchant in a pitch must never
be larger than what happened. Below the floor the answer is `suppressed` at the
PREVIEW's floor, never the dashboard's — passing the lower floor through would
tell an unauthenticated reader that the count was under ten, a tighter bound
than the preview may disclose.

---

## Access

`services/merchant-demand/access.ts`. A caller is admitted if they are the
merchant's CLAIMANT (`merchants.claim_state = 'claimed'` plus
`claimed_by_oxy_user_id` — ADR 0002 D9's one stored verdict, #83's to write), or
if they are a member of the native store an ACTIVE `native_store_links` row ties
to the merchant AND hold `analytics:read`.

Both routes are needed and neither subsumes the other: an affiliate merchant
that claimed itself has no native store, and a native store has members other
than whoever completed the claim.

**Every refusal is the same 404 under the same reason code.** An unclaimed
merchant, a pending claim, a revoked one, a membership without the permission
and a caller who is simply somebody else are indistinguishable — a refusal that
varied would let anybody enumerate which merchants have been claimed, one
request at a time. Both routes read a LIVE verdict, so a revocation removes the
surface in the statement that revokes it.

The preview answers 404 for a CLAIMED merchant, and the same 404 an unknown
merchant gets. Serving both would put a rounded figure and an exact one side by
side for the same window, and the difference between them is a disclosure the
rounding exists to prevent.

### `analytics:read` is the eighteenth store permission

Deliberately not `stats:read`. `stats:read` answers "how did my shop trade" —
my orders, my products, my customers — which a shop floor needs, and staff hold
it. `analytics:read` answers "what is the market doing around my products", and
#86 privacy 3 asks for an EXPLICIT permission, which a permission every role
already holds would not be. Owner 18/18, admin 17/18 (still no `store:manage`),
staff 9/18. A store that wants a staff member to see demand grants it
explicitly, which is what the grant union is for.

---

## The operator acquisition pipeline

`/internal/merchant-demand/*`, behind **`ANALYTICS_OPERATOR_OXY_USER_IDS`** —
the fourth allow-list, not a seventh. That list already grants the broadest
reading power in the codebase ("what is demand doing across the marketplace"),
and this surface is that power applied one merchant at a time plus a workflow
for acting on it; a seventh list would be a second answer to who holds it. Empty
means the router is NOT MOUNTED (404, never 401), and it stays mounted while
both merchant-facing levers are off.

### The claim verdict is not duplicated, and the funnel is DERIVED

`merchant_acquisition_candidates` has no claim column, no `claimed_at` and no
`is_claimed` boolean. The conversion funnel (#86 acquisition 7) is derived on
every read from four verdicts four other domains own:

| Stage | Authority |
|---|---|
| `unclaimed` / `claimed` | `merchants.claim_state` (#83) |
| `store_linked` | an active `native_store_links` row (#54/#84) |
| `payment_ready` | `provider_accounts.onboarding_state` (#46) |
| `native_activated` | an active NATIVE offer (#57) |

A copy on the candidate row would be the one that goes stale the moment a claim
is revoked, and it would go stale on the operator's screen.

### Scoring

`scoreMerchantAcquisition` is a pure function over
`MerchantAcquisitionFacts` — one field per allowed input and none for any
forbidden one, so a scorer cannot READ a commission, a rank or a relevance score
whatever any weight is set to. An UNMEASURED input is left out of BOTH halves of
the mean (#58's denominator rule): reading it as zero would rank a merchant
Mercaria knows nothing about below one it knows is small, when the only
difference is Mercaria's own information. With nothing measured the score is
zero AND every input is reported unmeasured, so "we scored it low" and "we could
not score it" stay distinguishable.

The stored `score_bps` is a CACHE, and `snapshot_id` names the evidence — which
is why there is no "set the score" action: rescoring rebuilds the snapshot and
re-runs the pure function.

### Scoring cannot affect organic ranking

Asserted in BOTH directions by `merchant-demand-isolation.test.ts`, with a
vacuity floor and a mutation self-test per detector:

1. No module in this domain reaches ranking, search or a comparison.
2. **No ranking, search or offer module reaches this domain.** That is the
   direction #86 actually names, and the one a one-way scan would miss: the
   damage is done by an ORDERING reading a score, not by a score reading an
   ordering.

### Contact SOURCES, never contacts

`merchant_acquisition_contact_sources` stores a source kind, the URL of a page
an operator can open, a note saying where on it to look, and who recorded it.
There is no `email`, no `phone`, no `contact_name` and no `contact_value` column
anywhere in the domain.

That is the strongest available reading of #86 privacy 7 ("do not use
payment-onboarding identity data as outreach contact data"): a prohibition on
where a value came FROM is a rule somebody has to keep; a schema with nowhere
for a value to LAND is a fact. It also removes the whole PII surface — an
operator reads the contact off the merchant's own published page at the moment
they use it, which is also the only moment it is known to be current.
`MERCHANT_ACQUISITION_FORBIDDEN_CONTACT_SOURCES` names the prohibited origins as
VALUES beside it (payment onboarding, the Stripe connected account, guest
checkout contact, buyer order contact, the Oxy profile, support threads, abuse
reports, price-alert subscribers, the store member directory), disjoint from the
allowed kinds by a gate.

`locator_note` is bounded and shape-CHECKed against an at-sign and a five-digit
run, in the column and again in the request schema. It is the one place a note
could quietly become the value it points at.

### Nothing here sends anything

#86 acquisition 8 ("no automatic email or messaging in this issue") is held by a
scanned gate: no module in the domain may import a mailer, a transport, a
notification service or an outbound HTTP client. The outreach LOG records what a
person did outside Mercaria; the outreach CONTEXT is the evidence they wrote it
from.

`buildOutreachContext` is composed on READ from a stored snapshot and stored
nowhere — a stored context is a copy of a number, and the failure mode is an
operator quoting last quarter's demand at a merchant who then asks about it. It
has no subject line, no salutation and no free text; every line names its
metric, its noun and that metric's attribution limit, and anything not
preview-safe is WITHHELD with the withholding reported.

### The write set is CLOSED, and every attempt is audited

Eight actions (`MERCHANT_ACQUISITION_ACTIONS`), each driving an idempotent path,
each audited on BOTH outcomes into an append-only `merchant_acquisition_audits`
with a bounded refusal code. There is no "set this merchant claimed", no
"override this score", no "set this figure", no send and no delete.

Two refusals are worth naming:

- **Outreach against a do-not-contact merchant is REFUSED**, not filtered. The
  row is the record that somebody contacted a merchant, and accepting it after a
  do-not-contact request would record the thing the flag exists to prevent while
  looking like compliance.
- **Lifting an exclusion is refused while `do_not_contact` is set.** A merchant
  that asked not to be contacted has not withdrawn the request because an
  operator changed their mind about a competitor conflict, and one action that
  quietly did both is how a do-not-contact request gets lost.

`do_not_contact` is a BOOLEAN beside the state rather than a state value, so it
survives a candidate being re-queued by somebody who did not read the state.

---

## Environment

```
MERCHANT_DEMAND_ENABLED=false            # the CLAIMED merchant dashboard mount
MERCHANT_DEMAND_PREVIEW_ENABLED=false    # the UNCLAIMED merchant public preview mount
MERCHANT_DEMAND_SNAPSHOT_RETENTION_DAYS=400
MERCHANT_DEMAND_DEFAULT_WINDOW_DAYS=30    # must be one of 7 | 30 | 90, else falls back to 30
MERCHANT_DEMAND_MARKETS=                 # EMPTY ⇒ the undimensioned bucket is the only askable slice
MERCHANT_DEMAND_MAX_PRODUCT_ROWS=200
```

Neither lever gates a durable record, and the operator surface reads none of
them. There is no `MERCHANT_DEMAND_OPERATOR_OXY_USER_IDS`.

---

## Seams — what is defined and NOT measured

`services/merchant-demand/seams.ts` carries the full contract for each. Every
one is a function that answers `unavailable` with a reason and no number, and
none is a registry — a registry is a place a test-only provider can be installed
in production (#74's and #62's reasoning).

| Issue | What it owes | Metrics waiting |
|---|---|---|
| #37 | The outbound redirect and network reports | `human_outbound_clicks`, `network_reported_conversions`, `affiliate_commission`, `external_order_value`, `unavailable_click_rate` |
| #111 | A storefront analytics client, and a merchant dimension on the native funnel events | `search_result_impressions`, `native_add_to_cart`, `native_checkout_starts` |

Two are REFUSALS rather than deferrals, and the difference is deliberate:

- **`price_alert_demand`.** #79 built the alert domain so that nobody can ask
  who is watching a product — no route, no operator handle, no repository
  function takes a product, a merchant or an account, and the subject index is
  composite-and-partial so it cannot serve one. Publishing a floored aggregate
  of subscribers is #79's decision to make and #79's floor to choose, in #79's
  own domain. Reaching past that would put a second disclosure policy on a count
  whose owner deliberately published none.
- **`zero_result_demand`.** #86 asks for it "only when the relationship is
  defensible", and for a zero-result search there is none: the search returned
  nothing, so it names no product. Matching the query's tokens against a
  merchant's product titles attributes a stranger's search to whoever happens to
  sell something with a similar name — most confidently for the biggest
  catalogues.

### #82 was a seam and is now CLOSED — what closed it

`readMerchantCompetitiveness(...).coverage` is scoped by `(claimant credential,
condition SEGMENT, comparison CURRENCY, keyset page)`; a demand snapshot is
scoped by `(merchant, market, window)`. Consuming that rate directly would have
made the figure present or absent depending on **who asked** (snapshots are
built for unclaimed merchants too — that is the whole acquisition pipeline), and
would have published a rate describing one condition segment in one arbitrary
currency under a label that reads as "all of them".

What closed it is a second, honestly-named function in **#82's own domain**,
`countMerchantComparableSubjects` (`services/price-signals/competitiveness.service.ts`).
Three properties make it an exact aggregation rather than a rival definition:

- **Every input is a #82 verdict.** It calls the same `buildSubjectRows` the
  merchant surface renders from, with the same active policy. Nothing in it
  decides what "measurable" means.
- **Neither the segment nor the currency is chosen.** Each subject is evaluated
  in the condition it DECLARES and the currency the merchant LISTED it in, both
  read off the offer. There is no default to argue about, and Mercaria names no
  currency — which is the property this domain holds everywhere else.
- **It takes no credential.** Two counts disclose nothing the claim gate
  protects; it is the ROWS that carry a merchant's prices and its competitors'
  aggregates, and it returns none. That is what lets a snapshot be a function of
  the merchant and the window rather than of the caller.

**The metric is `subjects_with_a_price_comparison`, not "coverage".** The two
numbers are answers to two questions and can legitimately disagree — a
used-condition offer counts here and is invisible to a `segment: 'new'` read; an
offer listed in GBP counts here and may be unmeasurable in a EUR read whose
sample loses entries to an unresolvable pair. A reader who compares them without
knowing that concludes one is broken, so they carry different names and each
ships its own definition. The relationship is stated once, in
`countMerchantComparableSubjects`' docblock.

The rate's denominator is the subjects #82 EXAMINED over the snapshot's own
bounded page, which is why `subjectsExamined` is returned rather than implied —
and a merchant with nothing examined gets `unavailable`, never 0%.

#### Why this rate needs no floor, and cannot be differenced

It is the one figure in the domain that is deliberately NOT thresholded, and the
reason is worth stating because every other number here is. Three surfaces were
checked:

- **Against the product rows.** The rate is over the merchant's own OFFERS, and
  a merchant already knows its own catalogue, so the denominator discloses
  nothing. Subtracting the disclosed rows yields at most "how many of my offers
  on withheld products sit in a comparable market" — and comparability is
  derived from OTHER SELLERS' offers, which Mercaria already publishes on
  `/offer-comparison`. It is not a fact about a buyer.
- **Against a second window.** `countMerchantComparableSubjects` takes **no
  window**. Two reads over 7 days and over 90 return the same figure, so the
  difference is exactly zero — pinned by a realdb case rather than argued.
- **Against a second market.** Markets are a closed, opt-in set that is empty by
  default, and the quantity is still not buyer-derived.

Every other floor in this domain exists because a small count is a PERSON. This
rate has no buyer behaviour in it at all: #82 reads no order, no session, no
conversion and no click, which its own reference states. A floor here would
withhold a number that protects nobody, which is how a floor stops being read as
a signal that something is being protected.

Reading #82 is a READ and never a scoring input: `MerchantAcquisitionFacts` has
no field for a comparison figure, and `merchant-demand-isolation.test.ts` walks
a real `acquisitionFactsFrom(...)` result to keep it that way.

---

## Testing

- `merchant-demand-rules.test.ts` — the registry's own consistency, the floors,
  the rounding, the preview partition and the scorer. Pure.
- `merchant-demand-isolation.test.ts` — six scanned walls, each with a vacuity
  floor and a mutation self-test.
- `merchant-demand.realdb.test.ts` — the four cases #86 acceptance 8 names
  (tenant isolation, low-count suppression, attribution correction, claim
  transition) plus bot exclusion, the coverage CHECK and the append-only
  triggers, against a REAL PostgreSQL server.

Two defects were found by the real server and by nothing else, and both are the
reason that file exists:

- **A regex repetition count above 255 makes a CHECK fail at COMPILE time,
  which is INSERT time.** `source_url ~ '^https://[^[:space:]]{3,500}$'`
  generates cleanly, applies cleanly and then refuses every row with
  `invalid repetition count(s)` — an error about a regex, on a column whose
  value is fine. The length bound is a `length()` call now.
- **A raw `sql` aggregate over a timestamptz decodes as a STRING.**
  `sql<Date|null>\`max(occurred_at)\`` produced a string that failed several
  functions later, at INSERT time, with `value.toISOString is not a function`.
  drizzle's `max()` carries the column's own decoder and is what this reads now.
  The same shape as the `bigint`/`int8` finding in `~/Oxy/AGENTS.md`, on a
  different type.
