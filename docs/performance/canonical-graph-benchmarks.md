# Canonical graph: index and projection decisions (#61)

The measurements are in [`plans-medium-before.md`](./plans-medium-before.md) and
[`plans-medium.md`](./plans-medium.md); how they were taken and what they cannot
tell you is in [`README.md`](./README.md). This file is the **decisions** — what
was adopted, what stays normalized, and what was deliberately left alone.

**The headline: no projection was adopted, and none is needed.** At one million
offers over a hundred thousand products every measured read is served by an
index in single-digit milliseconds, and the three reads that were not are fixed
by three indexes. #61's decision rule 1 — prefer normalized relational truth
until measured reads justify a projection — is satisfied by the measurements
rather than by preference.

## Scale measured

`medium`: 100,001 canonical products, 100,111 canonical variants, 1,000,000
offers, 50,000 match decisions, 50,000 geo listings, 4,000 verified
relationships. Zipf-skewed on three axes at once, because a uniform seed makes
every read touch the same handful of rows and reports a latency production will
never see:

| Fan-out | Median | Max |
| --- | ---: | ---: |
| Offers per variant | 10 | 609 |
| Variants per product | 1 | 40 |
| Products per brand | 19 | 17,945 |

Every shape below reads the **maximum**, not the median: the median is the
answer a typical page gets and the maximum is the answer the worst page gets,
and only the second tells you whether an index is doing its job.

## What was adopted, and what it bought

Three indexes, one migration (`0037_daily_patriot`, `pre` — all additive). Each one's
measurement lives beside its definition in `src/db/schema/`.

| Read | Before | After | Rows scanned | Index |
| --- | ---: | ---: | --- | --- |
| Q07 brand page (`listProductsForBrand`) | 4.675 ms | **0.164 ms** | 17,945 → 20 | `canonical_products_brand_page_idx` |
| Q10 trigram candidate search (`searchCanonicalProductsByNameSimilarity`) | 81.586 ms | **16.639 ms** | 31,094 → 25 | `canonical_products_normalized_name_gist_trgm_idx` |
| Q05 offer comparison (`listOffersForComparison`) | 0.975 ms | **0.477 ms** | 580 → 21 | `offers_variant_price_sort_idx` |
| Q06 market-scoped comparison | 0.687 ms | **0.411 ms** | 215 → 63 | same |

(p50 over 50 uninstrumented runs, same dataset, not re-seeded between the two.)

### 1. `canonical_products_brand_page_idx` — the worst amplification in the graph

`(brand_id, name, id) WHERE status <> 'merged'`.

`listProductsForBrand` filters on `brand_id`, excludes tombstones and orders by
`(name, id)` with a LIMIT. `canonical_products_brand_id_idx` serves only the
equality, so the ORDER BY became a top-N heapsort over **every product of that
brand** — 17,945 rows read to show 20, an amplification of 897×. A big brand is
exactly the page a person opens.

Carrying the sort columns turns it into an ordered index scan that stops at the
limit. 7.2 MB.

The partial predicate matches the reader's own, so the index does not carry
tombstones no page will ever show.

### 2. `canonical_products_normalized_name_gist_trgm_idx` — and a reader change

`USING gist (normalized_name gist_trgm_ops)`, **plus** a one-line change to
`searchCanonicalProductsByNameSimilarity`: its ordering is now spelled
`ORDER BY normalized_name <-> $1` instead of
`ORDER BY similarity(normalized_name, $1) DESC`.

This is the read #58 runs for every candidate retrieval and the one #70/#71 will
build search on, and at 81 ms it was by an order of magnitude the slowest thing
in the workload. No index can serve `similarity(...) DESC`, so Postgres fetched
every row above `pg_trgm.similarity_threshold` — 31,094 of them — and top-N
sorted. `<->` is pg_trgm's distance operator, defined as `1 - similarity(a, b)`,
so **ascending distance and descending similarity are the same ordering**, and
GiST supports it as a real index scan.

The resulting plan is one index scan carrying both
`Index Cond: normalized_name % $1` and `Order By: normalized_name <-> $1`, with
no Sort node — verified in the plan, not inferred:

```
Limit  (actual time=6.674..18.225 rows=25 loops=1)
  ->  Index Scan using …gist_trgm_idx on canonical_products (rows=25)
        Index Cond: (normalized_name % 'kabrecor dro1 blender'::text)
        Order By: (normalized_name <-> 'kabrecor dro1 blender'::text)
```

**The candidate SET is unchanged** — the `%` predicate is untouched; only the
ordering is computed differently. Ties among equally-similar rows resolve in
whatever order the access method produces, which was already true of the sort it
replaces, since neither spelling names a tiebreaker. The returned `similarity`
VALUE is still `similarity()`, not the distance: reporting `1 - x` under the same
name would be a silent unit change. The full backend suite is green across the
change (2,952 tests), including `backfill.realdb.test.ts`, which drives the real
matcher through this read.

13 MB, against the GIN index's 12 MB on a 34 MB table.

**16.6 ms is still the slowest read in the workload**, and it is not a number to
be satisfied with. What remains is heap access for 25 wide rows plus GiST's own
distance computations; the next lever is a narrower projection for candidate
retrieval (it needs an id and a name, not 26 columns) and that belongs to
whoever owns the retrieval budget — #70/#71. The measurement is here so they
start from a number.

### 3. `offers_variant_price_sort_idx` — the sort #57 deferred to #61

`(canonical_variant_id, coalesce(price_amount, <MAX_MONEY_MINOR_UNITS>), id)
WHERE status = 'active'`.

`offers.ts` already documented this gap and handed it to #61 with the authority
to fix it "WITH numbers attached rather than ahead of them" (ADR 0002 D21).
These are the numbers. `listOffersForComparison` orders by
`coalesce(price_amount, <sentinel>)` so unpriced `informational` records land
last, and a plain index on `price_amount` does not store that expression — so
the planner read all 580 active offers on the hottest variant and top-N sorted
them. Indexing the expression the reader actually sorts by removes the Sort node
entirely.

The market-scoped branch (`country = $1 or country is null`) takes the same
index. 61 MB.

**The sentinel is emitted with `sql.raw`, and that is load-bearing twice over.**
A value interpolated into a `sql` template inside a schema definition is written
into the generated migration as a bound-parameter placeholder, and DDL cannot
carry one — the migration generates cleanly and fails at apply time. And the
constant is rendered from `MAX_MONEY_MINOR_UNITS`, the same constant
`UNPRICED_SORT_KEY` in `offerRepository.ts` reads: an expression index whose
constant differs from the reader's by one is not a slightly worse index, it is
an index the planner silently cannot use.

### The write cost of all three

Measured on the same dataset, real readers, 25 runs:

| Write | Before | After |
| --- | ---: | ---: |
| `upsertExternalOffer` (new source mapping) | 2.724 ms | **3.231 ms** |
| `UPDATE offers SET price_amount` by id | 0.215 ms | **0.366 ms** |

+0.5 ms per offer insert (+19%) and +0.15 ms per price update (+70%), all of it
from `offers_variant_price_sort_idx` — the other two are on
`canonical_products`, which the offer path does not write.

**That trade is stated rather than waved past**, because it is the one place
#61's adoption makes something worse. It is accepted because the costs scale
differently: the write cost is constant per row, while the read cost it removes
grows linearly with a variant's offer count — 580 rows sorted today on a variant
carrying 609 offers, and a popular variant only accumulates sellers. A bulk
ingestion that cannot afford it has the ordinary remedy of dropping and
rebuilding indexes around the load, which is a decision for #37's ingestion path
with its own measurement.

## Reads that stay NORMALIZED — the explicit list

#61 asks for this list explicitly. Every read below is served by a join or an
existing index at 1 M offers, and **no projection, materialized view or
denormalized read-model table is adopted for any of them**.

| Read | Reader | p50 | Why it stays normalized |
| --- | --- | ---: | --- |
| Canonical product by slug | `findCanonicalProductBySlug` | 0.113 ms | Unique index, 1 row scanned for 1 returned. |
| Product by GTIN | `findActiveCanonicalOwner` | 0.253 ms | The collision gate's partial unique answers it directly. |
| Product by model alias | `findCanonicalProductIdsByNormalizedAlias` | 0.198 ms | Btree on the normalized alias. |
| Product with variants | `listVariantsForProduct` | 0.356 ms | 40 rows scanned for 40 returned. |
| Family page | `listProductsForFamily` | 0.238 ms | 34 for 34. |
| Brand resellers in a market | `findCurrentRelationships` | 0.754 ms | 600 scanned for 239 — the temporal predicate is evaluated live, and that is the point (#55): a lapsed claim stops producing a badge whether or not a sweep ran. A projection here would reintroduce exactly the staleness the live derivation exists to remove. |
| #59 review inbox | `listPendingMatchReviews` | 0.455 ms | Partial index on `review_state = 'pending'`; 50 for 50. |
| Offer freshness sweep | `retireLapsedExternalOffers` | 11.384 ms | Almost all of it is the WRITE — the scan alone (X05) is 0.480 ms for the same 500 rows. A sweep is a background job with a lease, not a page. |
| Nearby listings + text | `searchListingsPage` | 1.579 ms | The GiST geo index and the GIN tsvector AND together as ordinary predicates. |

Two reads stay normalized **with their amplification recorded**, because
"acceptable" is a judgement somebody should be able to revisit:

- **Q15, the product-level offer comparison** — 3.146 ms, 2,482 rows scanned for
  20 (124×). This is the semi-join across a product's 40 variants, and
  `offers_variant_price_sort_idx` does not fix it: an index gives each variant's
  offers in price order, but the query needs them merged across forty of them,
  so the sort survives. It is the shape to watch as fan-out grows, and it is the
  one place a "cheapest offer per product" projection would earn its keep. It
  does not earn it at 3 ms. **Owner: #74 (ranking) / #70 (product page).**
- **Q12, backfill evidence for one run** — 2.533 ms, 12,500 rows scanned for 100
  (125×). `catalog_backfill_records_run_idx` is `(run_id, outcome)` and the read
  orders by `updated_at desc`, so the sort survives. Deliberately NOT fixed: it
  is an operator surface behind an allow-list, read by a handful of people
  during a migration, and #61's own rule is not to add an index a measured read
  does not justify. Adding `updated_at` to that index is a one-line change if
  the backfill ever gets a busy operator UI.

## What a projection would have to carry, if one is ever adopted

None is adopted, so this is the contract for whoever adopts the first one rather
than documentation of something that exists. #61's decision rules 2–6 make it
short, and the repository already has a working precedent to copy: **`#57`'s
`offer_outboxes` convergence queue** — a durable row per subject, requested and
claimed revisions so a write landing mid-run is not swallowed by the completion
that follows it, leases with an owner check, and a dispatcher whose LOOP is
gated while the record never is.

A projection in this graph must have:

1. **An owner** — one module that is its only writer, the way
   `review-aggregate.service` is the only writer of the entity `rating` columns.
2. **A refresh trigger** — the write that makes it stale must enqueue its
   refresh in the SAME transaction. `syncListingFacets` is the existing
   chokepoint for the catalogue; a fourth status-only write path that forgot
   would leave the projection claiming a listing is on sale.
3. **A rebuild path** that derives the whole row from the normalized source and
   is idempotent, so it can be run against one subject or against everything
   without a delta anywhere in it. Everything derives and nothing increments —
   that is what makes a rebuild safe to re-run mid-incident.
4. **A stated staleness bound**, in the projection's own row, so a reader can
   tell "current" from "nobody has refreshed this since Tuesday".
5. **No provenance loss** (rule 4): the projection may not be the only place a
   fact exists. Source records, correction history and the relationships behind
   a badge stay where they are.
6. **No authoritative price or availability on a canonical product row**
   (rule 6). This one is not a guideline: `offers` is where a mutable price
   lives, and a canonical row carrying an authoritative copy is the specific
   thing ADR 0002 forbids. A CACHED copy that names its own staleness is a
   different object and must read as one.

## Strategies compared and NOT adopted

#61 lists nine PostgreSQL strategies to compare. What the measurements said:

- **Composite / covering indexes** — adopted twice (brand page, offer sort).
  Both were the whole fix.
- **`pg_trgm` GiST for fuzzy candidate generation** — adopted, with the reader
  change that makes it usable. GIN alone cannot serve a distance ordering.
- **LATERAL joins vs window functions for offer ranking** — measured as X02
  (`DISTINCT ON`) against X03 (`CROSS JOIN LATERAL`) on the deduplicated
  merchant page: **1.240 ms / 3,348 rows scanned** versus **1.985 ms / 6,043**.
  `DISTINCT ON` wins on this shape. Neither is adopted, because no shipped
  reader deduplicates a merchant's offers to one row per product — that is a
  ranking decision and belongs to **#74**. The numbers are recorded so #74 does
  not have to re-derive them.
- **Precomputed current-offer tables, denormalized read models, materialized
  views** — not adopted. Nothing measured needs one; see the normalized list
  above.
- **JSONB + GIN for sparse source attributes** — not adopted and not measured,
  because the register in `db/schema/CONVENTIONS.md` already decides which
  columns earned `jsonb` and why. #61 has no evidence that would change it.
- **PostgreSQL full-text search / generated `tsvector`** — already in the schema
  (`listings_search_vector_idx`, `canonical_products_search_vector_idx`) and
  exercised by Q14, which combines it with the geo predicate at 1.579 ms. No
  change.
- **Partitioning** — not adopted, and the measurement is the argument: the
  largest table is `offers` at 349 MB of heap for a million rows, every read
  against it is an index scan bounded by a LIMIT, and the freshness sweep is
  already bounded and resumable. Partitioning would add a maintenance surface to
  solve nothing measurable. Revisit when a single table's live set, not its
  history, stops fitting the buffer pool.
- **Elasticsearch / OpenSearch / Typesense / Meilisearch** — not introduced.
  #61 forbids it and nothing measured argues for it: the slowest read in the
  graph is 16.6 ms, and its remaining cost is heap width rather than anything
  PostgreSQL cannot index. #70 may revisit that only against a concrete unmet
  requirement, and now has the numbers to state one.

## Findings recorded but NOT acted on

Each of these is a real observation from the measurements that #61 deliberately
did not turn into a change, with the reason:

- **`offers_variant_comparison_idx` (103 MB) was chosen by no measured shape**,
  before OR after this work — `offers_variant_country_idx` won every time, and
  now `offers_variant_price_sort_idx` does. That makes it a candidate for
  removal worth roughly a fifth of the offer table's index bytes. It is NOT
  dropped here: "the planner did not choose it in these shapes at this scale" is
  not "no branch at any scale needs it", and the comparison read admits filter
  combinations (keyset cursor, `kind`, `availability`, condition groups) this
  workload does not enumerate. Dropping it needs its own measurement over those
  branches, and a `post` migration.
- **`offers_merchant_browse_idx` and `offers_storefront_browse_idx` had no
  reader in `services/`, and #73 is now that reader.** #57 built them for the
  issue's index 3 and #61 recorded them unread rather than dropping them; the
  merchant page's offer-level view
  (`db/merchantPages/merchantCatalogRepository.ts::listMerchantOfferIds`) issues
  exactly that shape under two scopes. **X01 was therefore PROMOTED into
  `WORKLOAD_SHAPES` as Q25** — a shape whose reader arrives stops being
  exploratory, which is `workload.ts`'s own rule — and Q26 measures the
  channel-scoped half so the second index is proven rather than assumed.
  `graph-plan-regression.realdb.test.ts` mutation-tests Q25 by dropping the
  index inside a rolled-back transaction and asserting the gate goes red naming
  the shape, and asserts Q26's plan names the STOREFRONT index and not the
  merchant one. Q27 measures the deduplicated catalogue browse, which declares
  no required index and forbids no node type on purpose: it is a `group by` over
  a seller's whole active offer set ordered by an AGGREGATE, so a Sort survives
  by construction (the Q14 situation), and what the shape is there to catch is
  the amplification growing unnoticed. The generated `plans-*.md` tables in this
  directory predate the promotion and still list X01; they are snapshots of past
  runs and are regenerated by running the benchmark, not edited.
- **`source_records.stale_at` has no index and no reader.** The column's own
  comment assigns the sweep to **#68**. An index for a query nobody runs is
  exactly what #61's rules forbid.

## Seams left to their owners

- **#70 / #71** — search and discovery, working from these limits. The number
  that matters to them is Q10 at 16.6 ms and its remaining cost being heap
  width; the narrower candidate-retrieval projection is theirs to size against a
  page budget.
- **#74** — ranking. X02/X03 give it the dedup strategy comparison; Q15 gives it
  the product-level fan-out figure that would justify a cheapest-offer
  projection.
- **#84** — native-store linkage. The merchant PAGE landed in #73, which took
  over X01 as Q25/Q26 above; what remains here is the linkage flow itself.
- **#37** — bulk ingestion, which owns whether the +19% insert cost of the offer
  sort index is worth a drop-and-rebuild around a load.
- **#61 did NOT build the `attribute_reindex_requests` drain**, which #60's and
  #94's notes hand to this issue. It is a consumer for a queue whose refresh
  semantics belong to whatever projection or index it feeds, and #61 adopted no
  projection — so building a drain now would mean inventing the thing it
  refreshes. The queue, its repository and `listPendingReindexRequests` are
  untouched and still waiting; the decision this issue contributes is that
  nothing it measured needs one.
