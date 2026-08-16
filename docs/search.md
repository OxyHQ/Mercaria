# Canonical multi-entity product discovery (#70)

`GET /search` answers with **canonical entities** — a product, a brand, a
family, a merchant, a storefront — rather than with the listings that happen to
carry them. Twenty sellers of one phone are one row here, and that is the whole
point of the issue: the listing-first search it replaces returned twenty.

This file is the reference for what the rules are and **why**. The wire contract
is `@mercaria/shared-types` `search.ts`; the code is
`packages/backend/src/services/search/` (eight modules) and
`packages/backend/src/db/search/` (two repositories).

**No new tables. No new indexes. No migration.** That is a finding rather than
an omission — see [What was NOT built](#what-was-not-built-and-why).

---

## The pipeline

```text
query
  -> normalization           normalize.ts, pure: no database, no clock, no config
  -> exact identifiers       findIdentifierOwners, several schemes in one round trip
  -> lexical / fuzzy         seven stages, five entity kinds, every one bounded
  -> catalogue filters       category, brand, #94 attributes — before scoring
  -> entity relevance        relevance.ts, pure, and it reads NO offer
  -> offer context           one batched read per PAGE, freshness-derived
  -> offer filters           market, price, condition, availability, kind, merchant, channel
  -> deterministic composition + keyset cursor
```

**Relevance is computed before any offer is read**, and that ordering is the
mechanism rather than an optimisation. It is what makes the offer read bounded
(candidates are sorted first, and only the top slice has its offers examined)
and it is what makes #70's separation of concerns structural: by the time any
price exists in memory, the ordering already exists. An offer could not
influence whether a product matches the query even if somebody wanted it to.

---

## The rules that are load-bearing

### A commercial payment cannot influence organic relevance

#70 names seven signals that may never rank: affiliate commission, marketplace
fee, referral reward, merchant Pro plan, FAIR acceptance, Mercaria-retail cost
variance, sponsored payment. Three independent mechanisms hold it:

1. **The vocabulary.** `SEARCH_RELEVANCE_SIGNALS` (9) and
   `SEARCH_FORBIDDEN_RELEVANCE_SIGNALS` (7) are DISJOINT unions, gated by a
   test — the `RETAIL_FORBIDDEN_COMPONENT_KINDS` device.
2. **The signature.** `EntityRelevanceInput` has a field for every permitted
   signal and none for any forbidden one, so there is no parameter through which
   one could arrive (`SourcingCandidateFacts`, #122, applied to ranking).
3. **The scan.** `search-relevance-isolation.test.ts` walks
   `services/search/` and `db/search/` WHOLE — so it covers modules nobody has
   written yet — plus the controller and route, with a vacuity floor on the file
   count, a mutation self-test per detector, and comment-stripping (every module
   here documents what it refuses to do, in the same vocabulary the detectors
   look for).

The behavioural half is in the realdb suite: two products with identical text
evidence and opposite offer economics score **identically**.

`SEARCH_RELEVANCE_SIGNALS` deliberately has **no popularity member**. #70's
ranking boundary 5 admits "product popularity/quality signals only when
explicitly defined and resistant to manipulation", and nothing in this issue
defines such a measure. #77 measures popularity and its own isolation gate
forbids a discovery module reading a rollup, so adding one is a decision with a
mechanism, not an omission to fill in quietly.

### There is no `variant` result kind

#70 lists `CanonicalVariant` as a search ENTITY and not as a result kind, and
the two are different questions. A variant is retrieved and scored, and then
reported as `SearchProductResult.matchedVariant` — the matched configuration of
its product. Giving it its own kind would put forty rows of one phone on one
page, which is precisely the duplication acceptance 1 exists to remove.

Two things produce a matched variant, and the stronger one wins: a **barcode**,
which names one exact configuration, and an **option-value match** (`256gb`
against `canonical_variant_attributes.normalized_value`, the same string the
variant SIGNATURE is computed over). The option match is resolved for the PAGE
rather than the candidate set — one statement either way, and running it over
every near-miss would read the variants of products nobody will see.

### The stage bands do not overlap

`relevance.ts` gives each match stage a floor and a headroom such that
`floor(n) + headroom(n) < floor(n-1)` for every adjacent pair. A perfect match
at one stage still scores below the WORST match at the stage above it. Three
consequences, and none of them would hold by luck:

- **#70 acceptance 2 becomes arithmetic.** An exact identifier can never be
  overtaken by a very good fuzzy match, whatever the similarity.
- **The signals become tiebreakers WITHIN a stage**, which is the only role a
  `ts_rank` and a trigram distance can honestly play against each other, since
  neither is calibrated against the other.
- **The ordering is explicable**: the stage decides the band, the signal decides
  the position in it.

`relevance.test.ts` asserts the non-overlap over every adjacent pair, derived
from the tuple rather than listed by hand, so a stage added in the middle is
covered the moment it exists.

The relevance policy is versioned by a **code constant**
(`SEARCH_RELEVANCE_POLICY_VERSION = 'sr-1'`), not a table — the
`CATALOG_BACKFILL_MAPPING_VERSION` reasoning: the policy is a procedure, and a
table would let somebody publish a version whose weights nobody shipped. It
travels on every analytics event, so a ranking change is separable from a
seasonal demand change in the metrics.

### A bare identifier answers alone

When the query is nothing but a valid identifier (`identifierOnly`), the fuzzy
stage does not run and no other entity kind is searched. The most precise input
a shopper can give must not produce the least precise page — an unconditional
fuzzy stage would drag in every product whose name shares three digits with the
barcode.

`mpn` and `brand_model` are EXCLUDED from identifier recognition. Both accept
essentially any string, so including them would classify every single word as an
identifier candidate and switch fuzzy retrieval off for ordinary prose. They are
reached through the exact-name and alias stages, which is what they are: names.

A **mistyped** barcode is not an identifier at all and falls through to the
lexical stages. A search is not an identifier assertion.

Only `status = 'active'` assertions are read. A `disputed` one is two entities
claiming one barcode, and #56 routes it to review; answering a search from one
of them would pick a winner the catalogue deliberately has not.

### Freshness: #68's derivation is the authority, plus one predicate #70 adds

Every offer a search page reads goes through `projectOffer` — the same
projection `GET /offers` uses — so the freshness verdict comes from the SOURCE's
own contract and nothing here caches it. `stale_at > now` in the ranking
statement is a **pre-filter** on the indexed stored deadline and nothing more;
mutation-testing it away leaves the lapsed-offer case GREEN, which is the
positive control that claim needed.

**#70 adds one predicate #68 does not have**, and it caught a real bug on the
realdb suite's first run. `nativeOfferFreshness` measures how long ago the
CONVERGER ran, so a native offer whose listing was restricted five minutes ago is
still perfectly `current`: the projection marks it `checkout.eligible: false` and
`listOffersForComparison` still returns it — correctly, because `GET /offers`
shows an ineligible row with its reasons. A SEARCH SUMMARY is a different claim
("this product starts at 100 €") and a price nobody can act on has no business
being that number. So `contributesToSummary` additionally excludes a native
offer blocked by `listing_restricted` or `listing_not_active`.

**Two reasons and not the whole set**, deliberately: `out_of_stock` and
`seller_not_payment_ready` also block checkout and are NOT removals. An
out-of-stock listing is still the product's price, and a seller who has not
finished Stripe onboarding has not withdrawn anything.

A product whose every offer has lapsed **keeps its result and carries NO
summary** — #70 freshness rule 1 (the product is still a useful answer) and rule
3 (its price is not) in one shape. Absence, never a price of zero.

### Filters: two families, applied at two moments

**Catalogue-side** (category, brand, #94 attributes) narrow the candidate set
BEFORE scoring — properties of the entity, cheap to test.

**Offer-side** (market, price, condition segment, availability, native/external,
merchant, official channel) are applied AFTER scoring over the projected offers,
because every one depends on freshness and none can be answered from a canonical
row. A product that survives the catalogue gates and has no CURRENT offer
satisfying the offer gates is dropped: a filter is a request to narrow, and
freshness rule 1's "a product with no offer is still useful" governs an
UNFILTERED search.

An attribute filter reads **only `selection_state = 'selected'`**
`canonical_attribute_values`. A `conflicting` value is two sources disagreeing
and #94 selects neither; filtering on one of them would answer with whichever
source was written first — a coin-flip wearing the appearance of a fact. Both
grains are unioned (product and variant), because an attribute may be recorded
on either and a shopper filtering on storage means "a product that comes in that
storage".

The official-channel filter reads #55's **temporal** relationships live, so an
authorization that lapsed a minute ago stops qualifying with no sweep having run.

### Money is never compared across currencies without saying so

`SearchPriceFilter.currency` is REQUIRED. A bound with no currency is not a
weaker filter, it is an incoherent one, and the shape is what enforces it.

`evaluatePriceBound` has THREE answers, not two. `unconvertible` covers an
unpriced offer, a currency outside Mercaria's presentment set, and a pair the
rate map could not serve — all of which mean "Mercaria cannot say", and none of
which may be reported as "too expensive". Those currencies are named in
`SearchFxContext.unconvertibleCurrencies`, so the exclusion is visible rather
than silent. A same-currency comparison needs no rate at all and stays
answerable on a page where FX is unavailable entirely.

One `getRates` call per REQUEST, never per product: the lookup is cached and
cheap, but a per-product call would make the page's FX behaviour depend on how
many products it happened to return.

### Pagination is a keyset over a merged, scored set

A search page is not one SQL ordering — five entity kinds retrieved by seven
stages, scored and merged — so there is no index whose order a SQL cursor could
resume from. What makes it a keyset is the property that matters: the cursor
carries the **ordering tuple** `(score, kind, id)` and the next page is
everything strictly after it in that total order. The tuple is TOTAL, which is
why `id` is in it and not decoration: scores tie constantly (twenty brands all
matched by exact name) and a cursor on score alone would loop forever.

Three details each fix a specific quiet bug:

- **The score travels as an integer of micro-units.** A float round-tripped
  through a decimal string is not guaranteed to compare identically to the one
  the scorer produced, and a boundary off by a hair repeats or drops exactly one
  row per page.
- **The boundary is the last candidate CONSIDERED, not the last one SERVED.** An
  offer-side filter can drop a candidate after it has been scored, and a cursor
  pointing at the last served row would re-consider and re-drop everything
  between the two on every subsequent page, forever.
- **The cursor is bound to a fingerprint of the query, its filters and its
  kinds.** A cursor from another query is UNREADABLE — `decodeSearchCursor`
  answers `null` and the caller serves the first page — because resuming from a
  boundary that means nothing in another result set silently drops its first
  page. Unreadable beats misinterpretable, the `utils/pagination.ts` rule.

Retrieval is bounded per stage and widens with depth up to `SEARCH_MAX_DEPTH`
(500). Past the ceiling the response says `truncated: true` rather than
presenting a shorter tail as the end of the results. Offer examination has its
own independent cap, because retrieving another hundred ids is a bounded index
scan and summarising another hundred products' offers is a hundred more
partitions to sort.

### Offer selection is #74's, and the seam FAILS CLOSED

`selected-offer.port.ts` registers nothing. Until #74 registers a selector,
every product result carries NO `selectedOffer` — not the cheapest one under
another name, not the first row of the summary, not a native offer preferred by
default. Each of those is a ranking decision made under a name that does not say
so, and the one thing worse than a missing feature is a ranking nobody agreed to
that looks like one somebody did.

What a result DOES carry is `offerSummary`, and the distinction is not cosmetic:
the summary reports the LOWEST PRICE, a fact about the offers, and it names no
offer. A shopper sees "from 1,199 €" and a link to the comparison; nothing
claims one seller is the right one.

A registered selector receives PROJECTED offers — already freshness-assessed,
already narrowed to what a comparison would show — so it cannot select something
a search page may not display and cannot reach the raw rows to find out what a
seller pays. A selector that throws costs a lead offer, never a search.

---

## Performance

### The N+1 #70 forbids, and how it is made unrepresentable

`readProductOfferSummary` reads ONE product's offers. Calling it per result
would be forty round trips for a twenty-row page, inside the very latency #77
measures. `db/search/searchOfferRepository.ts` replaces it with two statements
for the whole page:

1. `rankProductOfferIds` — `row_number() over (partition by product_id order by
   coalesce(price_amount, MAX_MONEY_MINOR_UNITS), id)`, filtered to
   `position <= limitPerProduct`. A two-column projection, so the pass that has
   to scan and sort a product's whole active offer set reads ids rather than
   fifty-column heap rows.
2. `loadOffersWithChannel` — the typed select over exactly those ids, bounded by
   construction.

Then ONE `buildOfferProjectionContext` for the page and `projectOffer` per row,
so the search summary and the public offer read cannot disagree about which
offers are current. `graph-plan-regression.realdb.test.ts` asserts the ranking
pass is **one statement** for a twenty-product page, on what the reader SENT
rather than on a latency.

The summary derivation itself was extracted from #68's
`readProductOfferSummary` into `summariseProjectedOffers`, so the two fetch
paths share ONE derivation. The depth is the SAME constant
(`SUMMARY_OFFER_LIMIT`), imported rather than chosen: two depths would make one
product's `currentOfferCount` differ between a search page and its own product
page, with nothing in either response saying why.

### Which index serves which stage

| Stage | Read | Index |
|---|---|---|
| exact name | `normalized_name = $1` | `canonical_products_normalized_name_idx` **or** the GiST trigram — see below |
| exact alias | `normalized_alias = $1` | `canonical_product_aliases_alias_idx` and its brand/family/merchant/storefront twins |
| prefix | `normalized_name like $1` | the `gin_trgm_ops` GIN — `pg_trgm` serves `LIKE` |
| lexical | `search_vector @@ websearch_to_tsquery` | `*_search_vector_idx` |
| token | `search_tokens && $1::text[]` | `canonical_products_search_tokens_idx` |
| fuzzy (product) | `normalized_name <-> $1` | `canonical_products_normalized_name_gist_trgm_idx` |
| identifier | scheme/value OR canonical GTIN | BitmapOr over `product_identifiers_scheme_value_idx` and `_canonical_value_idx` |
| fuzzy (merchant) | `lower(name) % $1` | **none, deliberately** |

Two of those are measurements rather than assumptions, and both surfaced when
the plan-regression gate went red on its first run with the new shapes:

- **Exact name is served by the GiST trigram index at the `ci` scale**, not by
  the plain btree. `pg_trgm` supports `=` on PostgreSQL 17, so two indexes
  legitimately serve the equality and which one wins is a statistics decision.
  The gate therefore forbids `Seq Scan` and pins no name — pinning either answer
  would fail the build on the scale that disagrees.
- **The identifier read is a BitmapOr, not the collision gate's partial unique.**
  It is a DISJUNCTION (several `(scheme, value)` pairs OR a set of canonical
  GTINs, because one query can be several identifiers at once), so the planner
  uses the two plain indexes rather than the partial unique
  `findActiveCanonicalOwner` uses for its single-value form. Both are indexed.

### The measured numbers

`docs/performance/plans-search-small.md` is the generated report — the `small`
scale (10,001 canonical products, 50,000 offers, 150 merchants, 200
storefronts), produced by the same harness #61 built, driving the same
`WORKLOAD_SHAPES` table. The six query classes #70 asks for a budget on:

| #70 class | Shape | p50 | scanned/returned | index |
| --- | --- | ---: | ---: | --- |
| 1 exact identifier | Q22 | **0.200 ms** | 2/1 | BitmapOr over two btrees |
| 2 brand + model | Q20 (token overlap) | **0.201 ms** | 5/1 | `canonical_products_search_tokens_idx` |
| 3 general lexical | Q19 | **0.117 ms** | 1/1 | `canonical_products_search_vector_idx` |
| 4 filtered category | applied over the bounded candidate set, not a retrieval | — | — | — |
| 5 merchant search | Q23 | **0.230 ms** | 150/1 | none — see below |
| 6 typo / fuzzy | Q21 | **1.981 ms** | 25/25 | `…normalized_name_gist_trgm_idx` |

Plus the two shapes #70 adds that are not query classes:

| Shape | What | p50 | scanned/returned |
| --- | --- | ---: | ---: |
| Q24 | the PAGE offer ranking — twenty products' cheapest offers, ONE statement | **1.128 ms** | 975/488 (2.0×) |
| Q18 | name prefix | **1.239 ms** | 2,129/60 (35.5×) |

Three things in that table are findings rather than confirmations:

- **The narrow candidate projection is NOT faster at this scale.** Q21 (id +
  score) measures 1.981 ms against Q10's (26 columns) 2.007 ms — indistinguishable.
  #61 attributed Q10's remaining 16.6 ms to heap width at the `medium` scale
  (100,000 products, 25 wide rows returned); at 10,000 products the heap access
  it removes is not the cost. The projection is kept because it is strictly less
  work and because #61 handed it here, and the honest statement is that **its
  benefit has not been demonstrated at `small` and remains to be measured at
  `medium`** — not that it was measured and won.
- **Q23 scans the whole `merchants` table** — 150 rows for 1 returned — in
  0.230 ms, which is the number behind "a dimension table needs no trigram
  index". At `large` (2,000 merchants) the same scan is roughly thirteen times
  the rows and still well inside a page budget. Revisit at roughly 100,000.
- **Q18's 35.5× amplification is the prefix stage's worst case, deliberately
  seeded.** The fixture's eight-character prefix is a BRAND word shared by 2,129
  products (the largest brand at this scale), so the trigram GIN returns
  everything under that brand and the limit cuts to 60. A prefix that identifies
  a product rather than a brand does not behave this way — but the worst case is
  the one worth publishing, and it is 1.2 ms.

**Caveats carry over from `docs/performance/README.md` unchanged**: measured on
one x86-64 host against `postgis/postgis:17-3.5` with default settings, warm
cache, so the RATIOS transfer and the absolute milliseconds do not. The
`medium` scale was NOT re-run for #70.

### The prefix stage's minimum length is not a nicety

`pg_trgm`'s index cannot help a pattern shorter than one trigram, so a
two-character prefix is a sequential scan of the whole product table on the
hottest read path. Below `SEARCH_PREFIX_MIN_LENGTH` (3) the stage does not run
and the lexical and fuzzy stages answer instead.

### `ORDER BY x <-> $1`, never `ORDER BY similarity(x, $1) DESC`

They are the same ordering and only the first can be served by an index; #61
measured the difference at 6.6×. `searchProductIdsByNameSimilarity` is Q10's
twin with a two-column projection — #61 attributed Q10's remaining 16.6 ms to
"heap access for 25 wide rows" and handed the narrower projection to #70, and
this is it. A realdb test asserts the statement still contains `<->`, because
"tidying" it back compiles, returns the same rows, and passes every other check.

---

## What was NOT built, and why

**No new table, no new index, no migration**, and each is a decision:

- **No search projection, materialized view or denormalized read model.** #61
  measured the alternative at one million offers and adopted none; every read
  this pipeline issues is an indexed bounded scan over an existing index.
  Adopting one here would mean owning a refresh trigger, a rebuild path and a
  staleness bound (`docs/performance/canonical-graph-benchmarks.md` states the
  six things a projection in this graph must carry) for a cost nothing measured.
- **No trigram index on `merchants` or `storefronts`.** They are DIMENSION
  tables — 120 rows at the `ci` scale, 600 at `medium`, 2,000 at `large` — and
  #61's own rule is not to add an index a measured read does not justify. A
  trigram index on a two-thousand-row table buys nothing a scan does not already
  give and costs write amplification on every merchant a source mints. Q23
  measures the scan so the claim carries a number; **revisit at roughly 100,000
  merchants**, or sooner if the shape appears in a latency budget.
- **No fuzzy stage for storefronts.** A storefront is almost always reached FROM
  its merchant (which has one) or from a domain, and #84 owns the storefront
  page. Adding a typo-tolerant scan of a second dimension table to every search
  would cost every query for a case nobody has reported.
- **No autocomplete / suggestion route.** A different latency budget and a
  different privacy posture — it emits a query event per KEYSTROKE, and #77's
  retention rules were written for submitted searches. Its own issue, with its
  own numbers.
- **No external search engine.** #70 forbids introducing one until measured
  PostgreSQL limits justify it, and nothing measured here does. If one is ever
  needed it arrives under its own ADR with the migration and operational cost
  stated, per #70's own instruction.

---

## Rollout

`CANONICAL_SEARCH` is a SEVENTH canonical read lever (`off | shadow | on`),
beside `CANONICAL_READS`, `CANONICAL_OFFER_COMPARISON`,
`CANONICAL_PUBLIC_ROUTES_ENABLED`, `CANONICAL_READ_COHORTS` and the two write
levers. It is the **one that defaults `off`**, and that is the read levers' rule
rather than an exception to it: they default to TODAY'S BEHAVIOUR, and today's
behaviour for `GET /search` is that it does not exist.

| Value | A shopper sees | Behind it |
|---|---|---|
| `off` | 404 | nothing runs |
| `shadow` | 404 | the canonical answer AND the listing-first answer are computed and compared |
| `on` | the canonical answer | — |

**The rollback in #70 acceptance 8 is one environment variable**, and it costs
nothing: `GET /listings?q=` is the listing-first search this issue replaces, it
is UNTOUCHED, and it keeps serving whatever this lever says. Nothing was
deleted.

`GET /search` is the ONE canonical surface whose lever lives in the HANDLER
rather than in `requireCanonicalReads`. That middleware returns before the
handler runs, and `shadow` has to compute an answer — so a middleware gate would
make `shadow` and `off` the same thing, which is the confusion the mode exists
to avoid. The visible behaviour is identical either way.

### What the shadow comparison measures, and what it deliberately does not

Result COUNTS and ZERO-RESULT agreement, per query, in four classes:
`both_returned`, `canonical_only`, `listing_only` (the direction a rollout must
not regress in), `both_empty`.

**Result OVERLAP is not measured**, for the reason
`analytics/search-instrumentation.ts` already documents about the same join: a
listing reaches a canonical product by two routes that are not the same set
(`product_identifiers` through its variants, and `native_listing_links`),
NEITHER is batched, and resolving a twenty-row page would cost tens of queries
inside the request being measured. A number computed the cheap way — matching
titles — would be worse than none, because a rollout decision would then rest on
it.

The counters are PROCESS-LOCAL (`ledgerImbalanceAttempts`' reasoning): several
ECS tasks each observe their own traffic, a durable row per shadowed search
would be an analytics table this domain has no business owning, and aggregation
across tasks belongs to `oxy-infra` scraping the operator endpoint.

---

## Analytics

ONE call to #77's `instrumentSearch`, which mints the `queryEventId` a client
echoes on the impressions and clicks that follow, redacts the term before
anything is stored, and emits `search_submitted` plus either
`search_results_returned` or `search_zero_results`. It returns the id or
`undefined` when collection is off — so a client has nothing to send and no
branch to write. Nothing is awaited.

The canonical product id of each product row is passed, in order, which is what
#77's duplicate-result-rate metric needs and what the listing search could not
supply. The CATEGORY filter is passed only when the request named exactly one,
matching `analytics_search_queries.category_id` — a single column that cannot
express a set, and reporting one of several would attribute a query to a
category the shopper did not narrow to.

**Filter USE beyond the category is a NAMED SEAM owed to #77**, not something
#70 builds unilaterally. Recording WHICH filters a search carried needs a typed
column in `analytics_events`, and #77's domain is an ALLOW-LIST of typed columns
with no property bag by explicit design — adding one is a migration in a domain
this issue does not own. Category filter use is measured today; the rest is not,
and saying so is better than a chart that reads "no filters were used".

The operator surface emits NOTHING: a diagnostic query is not a search somebody
performed, and counting it would put staff traffic into `zero_result_rate`, the
metric a rollout is judged on.

---

## Surfaces

| Route | Who | What |
|---|---|---|
| `GET /search` | public, `rl:listings:` | the canonical answer; 404 unless `CANONICAL_SEARCH=on` |
| `GET /internal/search/shadow` | `CATALOG_OPERATOR_OXY_USER_IDS` | the shadow counters and the lever they were taken under |
| `POST /internal/search/explain` | same | what one query returns RIGHT NOW, with its full trace |

The operator surface is on the SAME catalog allow-list #54/#55/#56/#57/#58/#60/
#62/#68 use — reading what a query returns is the same power over the same graph
as reshaping the catalogue — and it stays mounted while the public lever is off,
the `/internal/backfill` rule: the rollout evidence has to be readable during
the incident that turned the surface off.

The explain trace IS the response: `applied` carries the normalization, the
tokens and how the query was read as an identifier, and every result carries the
STAGES that found it and the score it was ordered on. An operator diagnosing
"why is this product not showing" looks at exactly the object the public surface
would have produced, rather than at a second rendering that could disagree.

**The set of operator actions is CLOSED and read-only-plus-explain.** There is
no "boost this product", no "pin this result", no "suppress this entity from
search" and no "set the relevance weights": every one would be a ranking control
living outside the versioned policy, which is what a code constant exists to
prevent. An operator who needs a different ordering ships a policy version.

---

## Request contract

`GET /search?q=…`, `.strict()`. The fields the schema does NOT have are the
enforcement:

- **No `boost`, `pin`, `promote`, `sponsored` or `sort`.** A request able to name
  a weight would be a ranking surface a caller controls.
- **No `includeStale`.** `GET /offers` has one because an operator investigating
  a lapsed offer needs to see it; a discovery surface has no such caller, and a
  parameter that could put an expired price on a search page is exactly what
  freshness rule 3 forbids.
- **No amount without a currency**, held by the shape rather than by a check.

Filters on the wire: `kinds`, `categories`, `brandIds`, `market`,
`priceCurrency` + `priceMin`/`priceMax`, `conditionGroups`, `availability`,
`offerKinds`, `officialChannelOnly`, `merchantIds`, `attributes`
(`key:value` or `key:min..max`), `nearLatitude`/`nearLongitude`/`nearRadiusMetres`,
`limit`, `cursor`. **The `near*` fields ARE present** — #93 closed the seam
below: it gave #70 a real nearby-collection-point membership filter
(`SearchFilters.nearby`), paired-presence refined so a latitude cannot arrive
without its longitude. It narrows the candidate set to products with a nearby
collection point and carries NO relevance weight — `SEARCH_RELEVANCE_SIGNALS`
has no distance member, so proximity filters and never ranks.

---

## Seams left to their owners

Each is a named contract that fails closed, never a stub that lies.

- **#74 — offer selection.** `registerSearchOfferSelector`; the default returns
  `undefined` and every product result carries no lead offer. #74 has shipped
  and does NOT register one (#230), because the two cannot be composed as they
  stand: a selector here is synchronous and is handed its offers, while
  `rankOfferComparison` is `async`, fetches the offers it ranks, and resolves its
  policy by a read keyed on each comparison subject — so
  `SearchSelectedOffer.rankingPolicyVersion` cannot be filled without one, and
  stamping the built-in version instead would attribute an ordering to weights
  the rollout never consulted. Filling the seam is a change to the port's SHAPE
  plus a product decision search has not made. A census in
  `selected-offer-port.test.ts` fails the build if a registration appears
  without this text changing with it.
- **#71 — the canonical product page.** A result carries the slug and the
  matched variant; the page itself is #71's.
- **#93 — nearby and pickup: CLOSED.** `nearLatitude`/`nearLongitude`/
  `nearRadiusMetres` narrow to products with a nearby collection point. Still
  absent: a distance-based relevance BOOST, which #70's own signal vocabulary
  deliberately has no member for.
- **#77 — filter-use measurement.** Needs a typed column in a domain #70 does
  not own; stated above rather than approximated.
- **#37 — the outbound redirect.** A search result carries no destination URL at
  all; an external offer's destination stays where #57 put it.
- **#95 — natural-language intent.** #70's own instruction: no LLM is the
  primary retrieval system here, and deterministic search exists first.
- **Autocomplete.** Its own issue, for the reasons above.
