# The native-catalogue backfill (#60)

The staged, reversible, resumable migration of Mercaria's listing-first
catalogue into the canonical commerce graph. Bound by
[ADR 0002](./adr/0002-canonical-commerce-graph.md) D23 (the phases) and D24 (the
flags); schema decisions are in
`packages/backend/src/db/schema/CONVENTIONS.md` §"The catalogue backfill".

The thing to understand before anything else: **a migration's worst failure is a
report that says it went fine.** A traversal that read nothing, a page that
swallowed its own errors, a cohort that matched no rows and a counter written by
whichever code path last touched it all produce exactly the output of a clean
run, and the mistake is discovered when somebody trusts the number. Most of what
follows exists to make that particular lie unrepresentable rather than unlikely.

## The shape

Three tables, eight stages, one runner, one dispatcher, one operator surface.

| Thing | Where |
|---|---|
| Report tables | `db/schema/backfill.ts` (`catalog_backfill_runs`, `catalog_backfill_records`, `catalog_consistency_findings`) |
| Repositories | `db/backfill/` |
| Stages | `services/backfill/stages/` |
| Runner, dispatcher, metrics | `services/backfill/backfill.service.ts`, `backfill-dispatcher.ts`, `metrics.ts` |
| The write seam | `services/backfill/graph-writer.ts` |
| Rollout levers | `services/backfill/read-mode.ts`, `config/index.ts` `canonicalRollout` |
| Operator surface | `/internal/backfill/*` (`routes/internal-backfill.ts`) |

## The stages, in dependency order

Each is independently runnable, resumable and re-runnable. The order is a
dependency order, not a schedule: running one out of order is a smaller run, not
a broken one, because every stage converges on its own input.

1. **`store_merchants`** — every ACTIVE native store mints a canonical merchant
   and a `native_store_links` row, `verified` with method `owner_authentication`.
   The evidence is the store's own `store_members` row with role `owner`; the
   ACTOR is the operator who opened the run. A store with no owner member is
   skipped rather than linked on weaker grounds.
2. **`vendor_brand_candidates`** — drives #53's `extractVendorBrandCandidates`.
   **No brand is created, and no code path here could create one.** Refuses a
   cohort: the extraction is an aggregate, and a cohort-scoped aggregate produces
   groups that are not the real groups.
3. **`variant_matching`** — enqueues every native variant in the cohort into
   #58's matching queue. The backfill enqueues and never matches.
4. **`provisional_products`** — the stage #58 deliberately stopped short of.
   An unmatched STORE listing mints a DRAFT canonical product, one canonical
   variant per native variant, identifiers from barcodes that GTIN-validate, and
   the `native_listing_links` attachments. A P2P listing is left unattached, and
   that is a success. See "The four rules" below.
5. **`native_offers`** — enqueues #57's convergence for every active listing with
   an active attachment.
6. **`rebuild_projections`** — re-derives `canonical_products.variant_count` and
   `canonical_product_families.product_count` from their sources and records
   whether the stored value had drifted.
7. **`search_reindex`** — enqueues `attribute_reindex_requests` rows, gated by
   `CANONICAL_SEARCH_INDEXING_ENABLED`. **#61 owns the consumer**; this stage
   builds no index and adds no search dependency (ADR 0002 D21).
8. **`consistency`** — the two-way sweep. Three passes, one cursor. See below.

### The four rules `provisional_products` decides by

1. **A P2P listing is left alone** — `unmatched` / `p2p_left_unattached`.
   D23 clause 7 and #60 acceptance 3: an unmatched P2P listing keeps operating
   exactly as it does today, and minting a canonical product from one person's
   used-phone ad would put a guess at the top of a product page.
2. **A listing whose variants are all attached is `unchanged`** — whether the
   matcher, an operator or a previous run attached them.
3. **A `manual_review` verdict goes to review, not to a mint.** Minting a new
   product for a variant the matcher thought might be an existing one is the
   false-merge failure inverted: a duplicate product page, discovered by a
   customer comparing two listings of one phone that do not appear together.
4. **No matcher verdict yet ⇒ WAIT** — `skipped` / `awaiting_match_decision`.
   D23 orders identifier matching before creation because minting first
   guarantees a duplicate for every listing whose barcode would have resolved.
   A high, static count here means #58's dispatcher is not draining, which is a
   visible operational fact rather than a silent one.

The attachment records `method: 'backfill'`, `confidence: null`, and a
`match_rule` carrying the mapping version. `backfill` is its own
`NativeListingLinkMethod` member rather than `connector_declared`: no connector
declared it, and an attachment whose canonical side was created from the native
side is genuinely different provenance from a platform asserting its own product
identity — a distinction #59's review tooling has to be able to make.

## Why a dry run cannot write

Not a check, a SHAPE. Stages do not have the repositories: they have a
`CanonicalGraphWriter`, and there are two implementations —
`applyGraphWriter` calls the real services, `dryRunGraphWriter` returns the same
result shapes having called nothing. The choice is made **once**, in
`createGraphWriter`, and `backfill-isolation.test.ts` fails the build if a stage
module calls a canonical write service directly.

"A dry run writes nothing" is therefore a property of every stage, including
stages nobody has written yet. A conditional in each stage would be a property of
whichever stages remembered.

`CANONICAL_WRITE_PUBLICATION_ENABLED=false` downgrades an `apply` run to the
dry-run writer at that same one place. The run still produces its complete
report, which is what makes the lever a rollback rather than an outage.

A dry-run report row may carry `created`, `matched` or `enqueued`: in dry-run
mode an outcome is a PREDICTION, and refusing to store one would make the mode
unable to report the four counts the issue asks it for. What a dry run never
carries is a canonical id, because it created no canonical row.

## Idempotency

Three layers, and each covers something the others cannot.

- **The report row is the ledger.** `UNIQUE(mapping_version, mode, stage,
  subject_key)`, so a re-run converges onto the same row (bumping `attempts`), a
  NEW mapping version writes a new row beside the old one, and a dry run can
  never overwrite the apply it was meant to predict.
- **`provisional_products` reads its own prior record.** A mint is several
  statements across three services, each opening its own transaction, so a crash
  can leave a product with only some of its variants; a naive re-run would then
  fail on the slug and never converge. The previous record names the product, so
  the re-run reuses it.
- **Every downstream write is already idempotent** — `native_listing_links`'
  active partial unique, the match queue's `ON CONFLICT DO UPDATE`, the offer
  outbox's convergence key, `assignIdentifier`'s dispute path.

`CATALOG_BACKFILL_MAPPING_VERSION` is a code CONSTANT, not a table. The mapping
is D23 phase 1's deterministic rule set and it lives in the code that implements
it; a table would imply somebody can publish a version whose rules nobody
shipped. Bump it whenever a stage's DECISION would differ for a subject it has
already reported.

## The vacuity floor

Three independent defences, because this is the failure that looks like success.

1. **`catalog_backfill_runs_counters_total_check`** — the outcome counters must
   SUM to `scanned`. Equality, not `<=`: `<=` would admit the run that scanned a
   million rows and classified none of them. A page that swallowed a record
   cannot write a row at all.
2. **`assertCohortIsNotEmpty`** — a run over a cohort that selects no listings is
   refused when it is OPENED, naming the cohort, rather than completing instantly
   and reporting success.
3. **`summarizeBackfill().scannedFromRecords`** — the same count, taken from the
   evidence rows instead of the counters the runner maintains. The operator
   surface shows both, plus `countsAgree`. A broken runner can fake one number
   and not two.

Two triggers back them up: `mercaria_backfill_run_counters_monotonic` (a counter
may never go down, because a pass is many pages that ADD to one row) and
`mercaria_backfill_record_identity_immutable` (a record's outcome may change on a
re-run; WHICH subject it is about may not, or the dry-run and apply reports stop
being comparable).

## Per-record error isolation

Every subject goes through `examineSubject`, which catches, logs, records
`record_error` / `failed`, and lets the page continue. Nothing rethrows: a page
that aborted on the first bad listing would leave the cursor unable to advance
past it, and the migration would stop at its worst record forever.

Routing every subject through one helper is what makes the isolation, the
`failed` counter and the evidence row the SAME act — a stage cannot have one
without the others, and the counter CHECK refuses the row if it somehow did.

A PAGE-level failure is a different thing and is handled differently: the cursor
is not moved and the run is released `failed`, so the page is retried from where
it started rather than skipped.

## The consistency sweep

Three passes, one cursor (`null` → `f:<id>` → `r:` → `r:<id>` → `x:` → `x:<id>`
→ `null`), and one run row, so "was the catalogue consistent" stays a single
question with a single answer.

| Pass | Scans | Opens |
|---|---|---|
| FORWARD | active `native_listing_links` | `attached_variant_without_offer` |
| REVERSE | active native `offers` | `offer_without_active_listing`, `offer_without_active_link`, `offer_canonical_variant_mismatch` |
| RETIREMENT | OPEN reverse findings whose offer is no longer active | nothing — it RESOLVES |

A one-directional check would pass on a catalogue where every offer was wrong, as
long as every attachment also had one. The retirement pass exists because the
first two scan only what is CURRENT: the ordinary remedy for
`offer_without_active_link` is a convergence that RETIRES the offer, after which
nothing scoped to active offers would ever look at it again and its finding would
stay open forever — and `orphanedNativeOffers` is the number a rollout watches.

**The sweep repairs nothing.** Every kind has an existing idempotent remedy a
person can drive, so a repairing sweep would be a second writer racing the first;
and three of the four kinds can legitimately mean a jury restricted the listing,
where "fixing" it would mean relisting something moderation removed.

## The rollout levers

Six switches and two tunables. Six rather than one because each bounds a
different blast radius.

```
CANONICAL_GRAPH_ENABLED=false               # the backfill dispatcher LOOP
CANONICAL_WRITE_PUBLICATION_ENABLED=false   # may an `apply` run mutate the graph
CANONICAL_READS=on                          # off | shadow | on — canonical PRODUCT reads
CANONICAL_OFFER_COMPARISON=on               # off | shadow | on — the `GET /offers` comparison
CANONICAL_PUBLIC_ROUTES_ENABLED=true        # the MOUNT of all of the above
CANONICAL_SEARCH_INDEXING_ENABLED=false     # may the backfill enqueue reindex requests
CANONICAL_READ_COHORTS=                     # empty = every cohort; else `<kind>:<value>,…` or `all`
CANONICAL_BACKFILL_BATCH_SIZE=200
CANONICAL_BACKFILL_POLL_INTERVAL_MS=15000
```

**The WRITE levers default OFF, as D24 binds. The READ levers default to today's
behaviour.** ADR 0002 D24's environment block shows `CANONICAL_READS=off`, and it
was written in phase 0 when the graph had no tables and no routes; by the time
this issue lands, #53–#57 have SHIPPED `/canonical-products`,
`/product-families`, `/brand-relationships` and `/offers` with no flag at all. A
lever introduced with an `off` default would therefore not be a rollout lever —
it would silently withdraw four shipped public surfaces on the deploy that added
it, which D24 forbids in as many words ("no legacy read path is removed while any
flag exists"). #60 acceptance 5 asks that turning reads OFF restores the
listing-first experience, which says nothing about the default.

`shadow` is D24 phase 3: compute the canonical answer, serve the legacy one,
record that both were available. A shopper sees exactly what `off` shows them —
it is not a third public behaviour. On the routes this issue gates, `off` and
`shadow` both answer 404 and `shadow` additionally counts the request, so a
rollout has evidence of demand before it is turned on. **The surfaces where
`shadow` will compute BOTH answers and compare them are #70's feed and #71's
product page**, which do not exist yet; `resolveCanonicalReadMode` and
`recordCanonicalShadowRead` are the seam they will consume.

## Runbook

### A canary rollout

A canary pages by HAND. The dispatcher exists for the unattended remainder.

1. `POST /internal/backfill/runs {stage, mode: 'dry_run', cohortKind: 'store',
   cohortValue: '<storeId>'}` — the rehearsal, over one store.
2. `POST /internal/backfill/runs/:id/page` repeatedly, watching
   `page.nextCursor`. Read `GET /internal/backfill/runs/:id/records` between
   pages.
3. Compare against `GET /internal/backfill/metrics`, which returns the dry-run
   and apply summaries side by side. Check `countsAgree`.
4. Set `CANONICAL_WRITE_PUBLICATION_ENABLED=true` and repeat with
   `mode: 'apply'`. The apply's counts should match the rehearsal's.
5. Widen the cohort. Run `consistency` (cohort `all`) and confirm
   `orphanedNativeOffers` is 0.
6. Only then turn `CANONICAL_GRAPH_ENABLED=true` so the dispatcher takes the
   whole-catalogue passes.

### A rollback

Every migration in this epic is additive, so rollback is a flag flip and nothing
is deleted.

1. `CANONICAL_WRITE_PUBLICATION_ENABLED=false` — apply runs stop changing the
   graph and keep reporting.
2. `CANONICAL_GRAPH_ENABLED=false` — the dispatcher stops. Open runs keep their
   cursors and resume when it goes back on.
3. `CANONICAL_OFFER_COMPARISON=off` and/or `CANONICAL_READS=off` — the read
   surfaces withdraw, per surface.
4. `CANONICAL_PUBLIC_ROUTES_ENABLED=false` — the blunt one, all at once.

**The operator surface stays reachable through all of it**, deliberately: the
evidence has to be readable during exactly the incident that turned the levers
off. Nothing in the rollback deletes a run, a record or a finding — the
repositories offer no delete and the operator surface could not call one.

### Reading a report

- `outcome` is the bucket, `reason_code` is why, and the two cannot disagree
  (`catalog_backfill_records_reason_outcome_check`, rendered from one map).
- A subject stuck at `failed` with a climbing `attempts` is a poison record, and
  it is visible without reading a log.
- `GET /internal/backfill/subjects/:subjectKey` opens from a subject key and
  nothing else — `listing:<id>`, `store:<id>`, `product_variant:<id>`. There is
  deliberately no lookup by seller or by anything about a person.

## What is deliberately NOT here

| Deferred to | What |
|---|---|
| #61 | The consumer that drains `attribute_reindex_requests`; every indexing and projection decision, with benchmark numbers attached (ADR 0002 D21) |
| #39 | Migrating or supplementing favorites. They stay listing favorites, and no module here can reach them (a scanned gate) |
| #76 | A product-level review projection. Reviews retain their target; no module here can reach the review domain |
| #59 | Promoting a `draft` canonical product to `active`, merging duplicates, resolving an identifier dispute |
| A separate migration | Product-level collections. Existing collections keep referencing native listings |
| #70/#71 | The `shadow` read mode's both-answers comparison, on the feed and the product page |

And two things that are absent for a structural reason rather than a scheduling
one:

- **No canonical product or variant COLUMN on `listings` or `product_variants`.**
  The issue's migration step 1 offers "nullable canonical references on native
  records OR an equivalent mapping collection selected in #52", and ADR 0002 D6
  selected the mapping collection: `native_listing_links`. Adding the columns as
  well would be a second representation of one attachment, and the two would
  disagree the first time a link was superseded.
- **No repair action on the consistency surface.** See "The consistency sweep".
