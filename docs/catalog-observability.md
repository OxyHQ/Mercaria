# Catalog observability and data quality (#367 Workstreams 16 and 17)

The full reference for the catalog observability domain: the metric registry, the
latency budgets, the ancestry benchmark that settled ADR 0007 D2, the
periodic integrity checks, the publication trace, the structured-log allow-list
and the operator surface that serves all of it.

`AGENTS.md` carries the rules that break silently if you get them wrong; this
document carries the mechanics, the provenance of every number, the eight metrics
this deployment cannot produce and why, and the checkbox-by-checkbox statement of
what W16 and W17 have and have not actually done.

Alerts for the numbers below have a runbook each:

| Alert | Runbook |
|---|---|
| Publication failures | [runbooks/catalog-publication-failures.md](runbooks/catalog-publication-failures.md) |
| Indexing lag | [runbooks/catalog-indexing-lag.md](runbooks/catalog-indexing-lag.md) |
| Proposal backlog | [runbooks/catalog-proposal-backlog.md](runbooks/catalog-proposal-backlog.md) |
| Translation regressions | [runbooks/catalog-translation-regressions.md](runbooks/catalog-translation-regressions.md) |
| Integrity findings | [runbooks/catalog-integrity-findings.md](runbooks/catalog-integrity-findings.md) |
| Latency budget breach | [runbooks/catalog-latency-budget-breach.md](runbooks/catalog-latency-budget-breach.md) |

Two more that are procedures rather than alerts, plus the audit of what the
rollout guarantees about existing commerce:
[runbooks/catalog-rollout-rollback.md](runbooks/catalog-rollout-rollback.md),
[runbooks/catalog-backfill-resumption.md](runbooks/catalog-backfill-resumption.md)
and [catalog-migration-operations.md](catalog-migration-operations.md).

And one that is a documented ABSENCE rather than a procedure:
[runbooks/catalog-cache-failure.md](runbooks/catalog-cache-failure.md). The
catalog path has exactly one cache, its key carries the invalidation revisions
so a stale entry cannot be looked up, and there is no Redis in front of it — so
there is nothing to flush and no queue to drain. It is written down because the
alternative is the next person inventing a remedy for an unreachable state.

---

## What this domain is, and what it is not

It measures **whether the catalog machinery is working**. It does not answer what
the catalogue contains — that is `/internal/catalog-governance`, which serves
`GET /queues` and `GET /quality` and owns the impact counts, the four-eyes
approvals, the audit trail and the review desk.

The two are separate routers on purpose. Governance answers "what does the
catalogue contain and who changed it"; this answers "is the thing that maintains
it working". Folding them together would put a metrics read behind a
change-request surface's rate limit and make either one's route set impossible to
assert exactly.

**It re-derives nothing.** Where a domain already publishes a counting reader,
the collector CALLS it:

| Consumed reader | Owner | What it supplies |
|---|---|---|
| `readCatalogQuality` | `services/catalog-governance/quality.service.ts` | the taxonomy, product-type and locale completeness cells |
| `readGovernanceQueues` | `services/catalog-governance/queue.service.ts` | `translation_missing_count`, with its own three-valued coverage |
| `scanOrphanedReferences` | `services/catalog-governance/queue.service.ts` | the three orphan cases where the pointer IS a foreign key and the target is out of SERVICE |
| `summarizeMatchQueue` | `db/matching/matchQueueRepository.ts` | queue depth, oldest pending age, dead letters |
| `sweepFacetScopes` | this domain (`facet-scope-sweep.ts`), calling `resolveFacets` | the empty-facet-generation rate |
| `resolveCategoryRedirect` | `db/taxonomy/taxonomyRepository.ts` | the verdict on a redirect chain, so `MAX_REDIRECT_HOPS` has one spelling |
| `summarizeLatency` | `services/graph-benchmark/measure.ts` | nearest-rank percentiles, shared with #61's harness |

A second spelling of a count is a number that can disagree with the surface it
came from. The one place this domain writes its own SQL is
`services/catalog-observability/queries.ts`, and only for aggregates no domain
repository has a reason to own — "how many drafts were abandoned last week" is
not a question the authoring lifecycle ever asks, and a count-everything query in
a domain repository invites the next reader to use it for a DECISION.

### The shape

| Thing | Where |
|---|---|
| The registry, the reading union, the budgets, the integrity vocabulary | `@mercaria/shared-types` `catalog-metrics.ts` |
| The collector and the producer census | `services/catalog-observability/metrics.service.ts` |
| The metric aggregates | `services/catalog-observability/queries.ts` |
| The proposal queue's depth, aging and SLA visibility | `services/catalog-observability/proposal-queue.ts` |
| The in-process route timer | `services/catalog-observability/route-observations.ts` |
| The latency budget report | `services/catalog-observability/budgets.ts` |
| The six integrity checks | `services/catalog-observability/integrity.service.ts` |
| The facet-scope sweep | `services/catalog-observability/facet-scope-sweep.ts` |
| The publication trace | `services/catalog-observability/trace.service.ts` |
| The correlation id | `services/catalog-observability/correlation.ts` |
| The structured-log allow-list and its guard | `services/catalog-observability/catalog-log.ts` |
| The ADR 0007 D2 ancestry benchmark | `services/catalog-observability/ancestry-benchmark.ts` |
| The #367 line 138 category index coverage | `services/catalog-observability/category-index-coverage.ts` |
| Per-request middleware | `middleware/catalog-observability.ts` |
| The operator surface | `routes/internal-catalog-metrics.ts` + `controllers/catalog-metrics.controller.ts` |

The gates. All under `services/catalog-observability/__tests__/` except
`routes/__tests__/internal-catalog-metrics.test.ts`, which sits with the router it
drives:

| Suite | What it holds |
|---|---|
| `contract-gates.test.ts` | the registry's completeness, the `unmeasured` biconditional against a HAND-WRITTEN expected set, the producer census in all three directions with a registry-mutating self-test, the budget/observed-route derivation, **the budget-names-a-real-route gate**, and the operator surface's exact route set |
| `metrics.realdb.test.ts` | the collector against a real server: one reading per definition in registry order, the shape biconditionals, breakdowns summing to their reading, BOTH branches of every flag-gated surface, and two positive controls (in-process and Postgres) with nothing in common |
| `proposal-queue.realdb.test.ts` | the proposal queue read: exact per-state and per-band deltas over a thirty-row fixture, the conserved partition, a row dated in the FUTURE landing in `unbandedOpenCount`, percentiles proven to be OBSERVED ages, and — through the pure derivation, because a shared database cannot be driven BELOW a floor — the below-floor refusal and both health flags |
| `middleware-wiring.integration.test.ts` | that the middleware is actually MOUNTED — real `createApp()`, a real listening server, real HTTP. Every other suite here passes with `app.use(catalogObservability)` deleted, which is the "a mechanism can be GREEN AND INERT" trap in its exact form |
| `routes/__tests__/internal-catalog-metrics.test.ts` | the operator gate and the read-only closure from OUTSIDE, over HTTP: allow-listed 200, non-operator 403, empty list 404 from the mount, the payments list refused, no write method anywhere under the prefix, and the trace's two-member handle set |
| `route-observations.test.ts` | the store: `undefined` never a zeroed bucket, 304 as its own dimension, exact counts against windowed percentiles, nearest-rank figures, the ring buffer's eviction, and unusable durations |
| `integrity.realdb.test.ts` | a positive control per check, plus one case that seeds a row into all six populations |
| `facet-scope-sweep.realdb.test.ts` | a fixture where every counter has a non-zero expected value, and the eligibility predicate has a signature in the numbers |
| `trace.realdb.test.ts` | a positive control beside every `absent` and `empty` branch, and a runtime privacy walk of a real emitted trace |
| `correlation.test.ts` | the shape gate, context isolation with a window control, and the log guard with a positive control, a per-pattern census and a mutation self-test |
| `ancestry-benchmark.realdb.test.ts` | the ADR 0007 D2 benchmark, its floors, the index-usability separation, the dropped-index mutation self-test, and a scale probe that REPORTS the planner's choice rather than asserting it — plus the #367 line 138 category index coverage gate |
| `category-index-coverage.ts` | the nine shipped category reads of #367 line 138, each CALLING its repository function: index-servability, the statement-count pins, and the registry the scoped reads resolve against |

**No new table, no migration and no new configuration variable.** Everything is
either an aggregate over rows other domains own, a module-level counter, or a
read assembled at request time.

---

## Metrics are DATA, not prose

`CATALOG_METRICS` holds **47 definitions**. `CatalogMetricDefinition` is #77's
`AnalyticsMetricDefinition` applied to the catalog graph and keeps that type's
one load-bearing property: apart from `unmeasured` there is **no optional
field**, so a number whose denominator, window, source or attribution limit
nobody stated does not compile.

| Field | What it states |
|---|---|
| `key` | stable; appears in every reading and in a dashboard's query |
| `title` | for a human |
| `kind` | `ratio` \| `count` \| `latency` \| `age_seconds` — what a consumer may DO with the number |
| `numerator` | exactly what is counted on top; never "matching rows" |
| `denominator` | exactly what is counted underneath; never "everything" |
| `window` | `instant` \| `rolling_1h` \| `rolling_24h` \| `rolling_7d` \| `since_process_start` |
| `source` | a table or a named owning reader, from `CATALOG_METRIC_SOURCES` |
| `freshnessSeconds` | how stale a reading may be before it stops meaning what it says |
| `attributionLimit` | what this metric CANNOT tell you — the field a dashboard footnote comes from |
| `unmeasured?` | present exactly when this deployment cannot produce it |

`CATALOG_METRIC_KEYS` is derived from the registry with `.map`, never written a
second time, so a key a read surface resolves against cannot drift from a key the
registry defines.

`kind` is four values rather than one because collapsing them is how a dashboard
ends up averaging a p95. `window` keeps `instant` apart from the rolling rates
because an operator reading "12%" needs to know whether that is twelve per cent
of what exists right now or of what happened last week — during an incident the
two move in opposite directions.

### The producer census is the anti-vacuity device

`collectCatalogMetrics` walks `CATALOG_METRICS` and never its own list, and which
branch a reading takes is read off the definition's `unmeasured` field and
nowhere else:

- definition carries `unmeasured` ⇒ the reading is `unmeasured`, with that
  field's reason and seam. The collector never looks for a producer.
- definition carries no `unmeasured` ⇒ a producer MUST exist in `PRODUCERS`.

`censusProducers()` checks that biconditional in three directions — a definition
with no producer, a declared seam with a producer, and a producer whose key is in
no definition — and reports the counts unconditionally, so a census that walked
NOTHING is distinguishable from one that walked everything and found it
consistent. `collectCatalogMetrics` **throws** on a missing producer rather than
reporting a zero, because a metric defined and unproduced is the exact vacuity
this domain exists to prevent.

31 producers + 7 seams = 38 definitions, and that identity is what the census
holds.

### One optional field carrying two halves

`unmeasured` is a nested `{ reason, seam }` rather than a `seam` beside an
`unmeasuredReason`, and the reason is the collector: it decides `measured` versus
`unmeasured` from exactly this field's PRESENCE. Two optional fields can disagree
— a seam with no reason, or worse a reason with no owner — and the disagreement
would land in the branch that chooses. Nested, the biconditional is
unrepresentable rather than merely unlikely.

`CATALOG_UNMEASURED_REASONS` is closed, so "we have not built it" and "the fact
does not exist to be measured" cannot be spelled two ways and counted as one:

| Reason | Means |
|---|---|
| `not_instrumented` | nothing records the fact; a column or a counter is owed |
| `client_signal_absent` | the fact is a client-side one and no client emits it |
| `no_consumer_registered` | the queue this would measure has no consumer, so throughput is undefined |
| `no_dead_letter_state` | the state this counts does not exist in the schema — NOT the same as zero |
| `dimension_absent_from_source` | the dimension asked for is not on the source table |
| `source_unavailable` | the owning reader refused or was unavailable for this read |
| `surface_not_mounted` | the route this metric observes is not mounted in this deployment |

The last TWO are the only ones no definition declares — both are substituted by
the collector at runtime, and neither is a seam. `source_unavailable` is what a producer's failure
degrades to at runtime, and it is deliberately a different fact from a designed
seam. A permanent seam is work outstanding; an unavailable source is an incident.
`recordMetricCollectionFailure()` fires at the failure site, so the operator sees
one non-zero counter rather than nine mysterious seams.

### A reader that throws degrades the METRIC, never the report

Eleven catalog domains feed this. `readShared` runs the ten shared reads under
`attempt()`, which counts a failure and answers `undefined`; every metric that
depended on it becomes `unmeasured` / `source_unavailable` with a seam text
saying the metric is NORMALLY produced. A per-metric producer that throws is
caught the same way. The other thirty-seven readings still arrive.

The shared reads are taken ONCE per collection, and not only for cost:
`readCatalogQuality` is four completeness measurements and three duplicate scans,
and calling it once per metric that needs a slice of it would let two metrics in
one report disagree because the catalogue moved between them.

---

## `0 / 0` is not 100%, and `unmeasured` is not zero

**Five readings, and no two of them are the same fact.** The three a reader
confuses most are the last three, and they lead to three different next actions —
wait, write code, set a variable:

| Reading | Shape | Means | What to do |
|---|---|---|---|
| measured, `denominator > 0` | `numerator`, `denominator`, `ratio` | the read ran and there is a rate | read it |
| measured, `denominator === 0` | `numerator`, `denominator: 0`, **no `ratio`** | the read ran and the population is genuinely EMPTY — nobody has done this thing yet | nothing; it is a fact |
| unmeasured, a REGISTRY seam | `reason`, `seam`, **no quantity** | this deployment cannot produce the metric at all. Seven of these, listed below | somebody writes the code named in the seam |
| unmeasured, `surface_not_mounted` | same shape | the ROUTE this metric observes is not mounted here, so it cannot be served | set the flag the seam names; no code is owed |
| unmeasured, `source_unavailable` | same shape | a reader THREW on this collection | an incident — see `mustStayZero.metricCollectionFailures` |

The last two are RUNTIME states the collector substitutes; neither is declared by
any definition, and they are not seams. A metric answering `surface_not_mounted`
today measures perfectly the moment somebody flips a variable.

The enforcement is the SHAPE, not the discriminant string.
`CatalogMetricReading`'s `unmeasured` branch has no `value`, no `numerator` and
no `denominator` property at all, so rendering an unmeasured metric as a number
is a type error rather than a judgement call. `ratio` is omitted rather than set
to `0` or `1` when the denominator is zero, which is
`catalog-governance/quality.service.ts`'s `cell()` decision restated at a
different grain: a consumer that wants to draw a bar has to notice there is
nothing to draw. The same rule runs one layer down in
`FacetScopeSweepResult.emptyRatio`, whose realdb test asserts the KEY is absent
rather than merely `undefined` — an `undefined` property serializes to nothing
and reads as a zero on the other side of the wire.

The discriminants are STRINGS throughout the domain (`state: 'measured'`,
`outcome`, `verdict`), never boolean literals: the backend compiles with
`strict: false`, and without `strictNullChecks` TypeScript does not narrow a
union on the truthiness of a boolean-literal discriminant, so
`if (!reading.measured)` would leave the caller holding the whole union.

Two more places where a zero would have been the easy answer and is refused:

- **`latency`** is present exactly when `numerator > 0`, where `numerator` is the
  observation count. A task that has served none of those requests reports a
  population of zero rather than a p95 of 0 ms, which would make every cold task
  the fastest one in the fleet.
- **`ageSeconds`** is present exactly when the row count is above zero. An empty
  queue reports "zero rows, no age" rather than "age zero", which reads as a
  queue that is perfectly up to date — the same shape as one that has stopped
  being fed.

### `translation_missing_count` propagates somebody else's `unmeasured`

The one to read, because it is where the rule crosses a domain boundary.
`CatalogGovernanceQueueDepth` is itself three-valued: `coverage` is `measured` or
`unmeasured`, and `total` is present exactly when it is the former.
`queueCount()` therefore carries that verdict THROUGH rather than flattening it —
a governance `unmeasured` read as a count of zero would launder the one thing
that reader went out of its way to say, and `translation_missing_count` would
report a fully translated catalogue for a locale set nobody measured.

The reason text comes from the governance reader when it supplied one, because it
knows why and this domain does not. A kind missing from the reader's output
entirely is `source_unavailable` with a seam saying the kind IS in
`CATALOG_GOVERNANCE_QUEUE_KINDS`, so its absence is a catalog-governance change
rather than a gap here.

---

## What is not measured, and why

**Six of the forty-seven metrics carry a seam.** Each is present in the
registry, readable through the surface, and answers `unmeasured` — because
absence from a registry is indistinguishable from nobody having thought of the
metric, and a zero is indistinguishable from health.

`GET /internal/catalog-metrics` reports the same list as `awaitingSeams`, so a
dashboard can render the gap as a gap. The seam text below is the registry's own,
condensed; the registry is the authority.

**The set of six is a DECISION, not a derivation.**
`contract-gates.test.ts` holds it as `EXPECTED_UNMEASURED_METRIC_KEYS`, written
out by hand and asserted in both directions, because
`CATALOG_METRICS.filter((m) => m.unmeasured)` agrees with itself whatever the
registry says — so a metric shipping `unmeasured` because nobody finished its
producer would pass, and closing a seam would pass too. **Closing one of the
seven is an edit to that list**, which is somebody stating that the gap named
below is gone. The same file also asserts
`census.definitions - census.producers === EXPECTED_UNMEASURED_METRIC_KEYS.length`,
which is the arithmetic identity that catches a producer deleted while its
definition stays measured — something three empty lists cannot express.

**`surface_not_mounted` is NOT one of the six and must not be counted with
them.** It is a deployment state, not a gap in the code, and it is explained in
§"An unmounted surface is not a seam" below. On a stock deployment the report
therefore carries **six registry seams plus up to four runtime
`surface_not_mounted` readings**, and those are different facts: a seam is work
owed to somebody, an unmounted surface is one variable away.

### 1. `authoring_schema_memo_hit_rate` — `not_instrumented`

Whether the revision-keyed in-process memo is earning its place.

`services/catalog-authoring/schema.service.ts` holds the memo (`remember` /
`memo.get`) and exposes no counter. **A 304 rate cannot substitute**: a client
with no `If-None-Match` and a warm memo is a miss on one and a hit on the other,
so `authoring_schema_client_cache_hit_rate` measures a different cache.

**What closes it:** one exported stats function beside the memo, in the
`analyticsSinkStats` shape, and one call in each of the two branches
(`memo.get` hit, and `remember` after a cold composition).

### The two that CLOSED (#367 W17 lines 768 and 771)

`draft_validation_failure_rate` and `translation_fallback_use_rate` were items 2
and 3 here, both `not_instrumented`, and both are now produced. Recorded rather
than deleted, because "this was never built" and "this was built in August" lead
a reader to different questions about a number they are looking at.

Each closed the way its own seam said it would — a counter at the site the seam
named, not a table:

- **768** counts at `publish.service.ts`'s ONE call to `validateDraftRow` from
  the publish path. `draft.service.ts` calls the same function for the standalone
  validate a form runs on every keystroke, and counting those would make the
  refusal rate a measure of typing.
- **771** counts in the SERVING path and never in `resolve.ts`, whose header
  opens with **PURE** and argues it. `resolveObservedLocalizedField` is the one
  thing a serving module may import, and
  `localized-read-observation.test.ts` fails the build if one reaches past it —
  because a serving path that resolves without recording makes the RATE wrong
  rather than merely incomplete.

768 arrived as TWO metrics, and the split is the interesting part: a refusal
carries any number of findings, so a validation CODE partitions findings exactly
and attempts not at all. `draft_validation_failure_rate` therefore carries no
breakdown, and `draft_validation_failure_code_share` answers "which codes" over
the population where they do partition. One metric with a `by` would have counted
one refusal in three buckets while claiming they summed to its denominator.

Both are bucketed on CLOSED tuples — `AUTHORING_VALIDATION_CODES` and
`LOCALIZATION_FALLBACK_STEPS`. Bucketing 768 on `attributeKey` was considered and
refused: its cardinality grows with the registry, which is an unbounded metric
dimension arriving as a breakdown key instead of a column.

### 2. `search_zero_result_rate_by_locale` — `dimension_absent_from_source`

A market is not a locale: one market serves several languages, and a zero-result
rate that is fine in one and terrible in another is exactly what the market split
hides.

`analytics_search_queries` has a `market` column and no `locale` column, and #77
owns that table.

**What closes it:** one nullable text column plus the emit site in
`search-instrumentation.ts`.

### 3. `facet_usage_rate` — `client_signal_absent`

Whether generated facets are worth generating — distinct from
`facet_scope_empty_rate`, which says whether they EXIST.

#77 defines no facet event and the storefront has no analytics client (#111 owns
it). Nothing here fabricates a substitute: a category that generates facets says
nothing about whether a shopper touched one.

**What closes it:** a `facet_applied` client event type plus its emitter.

### 4. `backfill_dead_letter_count` — `no_dead_letter_state`

Would count runs that gave up after EXHAUSTING their retries.

**The missing half is the RETRY, not the terminal state — and this section said
the opposite until it was measured.** `failed` IS terminal and unclaimable:
`RESUMABLE` is `['pending', 'paused']`
(`db/backfill/backfillRunRepository.ts:38`) and the claim predicate admits only
those or a `running` row whose lease expired (`:159`). So a run that has given
up is **exactly** distinguishable from one still going, by claimability — the
earlier text here ("indistinguishable from one still retrying") described an
absence that is not there.

What is genuinely absent is an **automatic, bounded** retry. There is **no
`max_attempts` anywhere in the catalog backfill domain**, so a run terminates on
its FIRST page-level error while still holding a good cursor, and waits for a
person. **The catalog failure mode is give-up-instantly, not retry-forever** —
the opposite of what a reader would assume from the five outbox implementations
elsewhere in this repository.

`catalog_backfill_records.attempts` is not a counter-example, and it is worth
saying so because it is the first thing a reader finds: it counts how many times
a subject has been **re-examined across runs an operator started**
(`db/schema/backfill.ts:341`, incremented by the record upsert), and
`backfill_retry_count` measures records above one. That is a poison-record
signal, not a retry loop — and having no bound is precisely why nothing can
exhaust one.

So "zero dead letters" is still a category error, for a sharper reason: nothing
can exhaust retries it never makes. And the tempting fix is worse than the gap
— a metric named for exhaustion, over a state reached on the first error, would
carry REAL NUMBERS under a false meaning, which is harder to catch than a green
zero because the numbers look like evidence.

**It is deliberately not renamed either.** "Runs an operator must restart" is a
real operational question with a real answer today, and
`backfill_failed_run_count` already answers it — `count(*) where status =
'failed'`. A second metric over one predicate is two names for one number.

**That neighbouring metric's own attribution limit was WRONG and is corrected
in the same change**: it read *"a failed run keeps its cursor and is resumable,
so this is work outstanding rather than work lost."* A failed run keeps its
cursor and is **not** resumable. It was telling an operator that stopped work
would resume — a live, measured number under a false reassurance, which is
worse than the unmeasured one beside it.

**What closes it:** a BOUNDED RETRY on those tables, keeping `failed` as the
terminal state it already behaves like. The exhaustion reading becomes true the
moment there is something to exhaust. This is also W16's "add
dead-letter/retry handling for asynchronous jobs", which is therefore NOT done
for this epic's own queues — and the reason is now known to be the retry rather
than the state.

### 5. `reindex_throughput` — `no_consumer_registered`

Would be the indexing-lag signal W17 asks for.

`attribute_reindex_requests` has several producers (enumerated and gated in
`services/catalog-event-contracts.ts`; this paragraph named three of them until
that register was written), a deterministic caller-supplied id, a
lease-shaped schema, a pending index and an `attempts` counter — and **no
consumer**. `listPendingReindexRequests` has exactly one caller and it is a
read-only operator listing; `processed_at` is written by no code path in the
repository, so the column appears in exactly one place, as an `is null` predicate
in that listing's own `where`. #61 declined to build the drain because the
refresh semantics belong to a projection nobody has adopted.

Until a consumer exists, a throughput of zero would be indistinguishable from a
stalled one. `reindex_pending_count` beside it IS produced, and its attribution
limit says the number only grows — see
[runbooks/catalog-indexing-lag.md](runbooks/catalog-indexing-lag.md), which is
mostly about not sending somebody to restart a worker that does not exist.

**What closes it:** that consumer.

### 6. `proposal_sla_breach_count` — `policy_target_undefined`

**The one seam here whose gap is not code.** Every input it would need is
measured and served: `readProposalQueueAging` publishes the queue's depth and
oldest age per lifecycle state, a five-band waiting-age partition over the open
rows and nearest-rank percentiles, and `GET
/internal/catalog-metrics/proposal-queue` renders all of it. What does not exist
is a **review-time target** — how long a catalogue proposal may wait before
somebody should be told — and nothing anywhere in this repository defines one.

`policy_target_undefined` exists as its own reason for exactly that reason.
`not_instrumented` would say a column or a counter is owed, which sends a reader
to write code; this says the number is already there and somebody has to decide
what an acceptable value is, which sends them to write a policy. Reporting the
metric as `0` would say "nothing has breached a target that does not exist",
which is true, reads as healthy, and hardens the first time somebody quotes it.

The type says the same thing: `CatalogProposalSlaVisibility` is a union with ONE
member, `undefined_target`, and there is no `targetSeconds` field, no deadline
and no breach count anywhere in the domain — the `GuestP2PAuthorization` device,
so "we are within SLA" is unrepresentable rather than merely unwritten. A
`contract-gates.test.ts` scan over the two owning modules (comment-stripped AND
string-literal-stripped, because both of them name the gap in prose on purpose)
fails the build if a threshold-shaped identifier appears in either.

**What closes it:** a decision recorded on #367 Workstream 6 naming a target per
open state — a proposal awaiting an operator and one awaiting a submitter are
different waits and the second is not Mercaria's to answer — plus the second
member on `CatalogProposalSlaVisibility` that carries it and the producer that
compares against it. The number arrives in the same commit as the decision that
justifies it, which is the only way it is accountable to anybody.

### Two more figures that are unmeasured below the metric layer

- **`FacetScopeSweepResult.invalid`** is always `{ state: 'unmeasured', reason:
  'dimension_absent_from_source', seam }` and has **no `count` property in any
  branch**, because there is no branch. W17 asks for "empty/invalid facet
  generation" and the facets domain publishes no invalid verdict:
  `FacetSuppressionReason` has eight members and every one says a facet was
  WITHHELD, which is the rail declining to render rather than a broken facet.
  Closing it is a verdict in `services/facets`, not a derivation here — at which
  point the type grows a `measured` branch and the sweep fills it from the same
  verdicts it already collects.
- **`resolveProductDemand`-style substitutes are not reached for.** `emptyReasons`
  reports the facets domain's own suppression reasons over the empty scopes, is
  diagnostic and is NOT a partition (a scope withholding three facets appears in
  three buckets) — which is why it is not a `CatalogMetricBucket[]` and must not
  be passed as a metric's `by`.

---

## An unmounted surface is not a seam

Three of the four route-observation metrics hang off the authoring schema route
and one off facets, and **both of those routes sit behind a rollout flag that
defaults to false** — `CATALOG_AUTHORING_ENABLED` and `FACETS_ENABLED`. With a
flag off the route is not mounted at all, so the surface cannot be served.

Reporting that as `measured, numerator: 0` would assert **that this task served
none of those requests** — a fact about TRAFFIC — when the truth is a fact about
the DEPLOYMENT. That is the phantom-template defect one layer over: a quiet,
healthy-looking tile for a feature nobody switched on. So the four producers
answer `unmeasured` with reason `surface_not_mounted` and a seam that **names the
variable to set**, and says in as many words that no code change is owed.

| Metric | Route | Flag |
|---|---|---|
| `authoring_schema_fetch_latency` | `GET /catalog-authoring/schemas/:productTypeKey` | `CATALOG_AUTHORING_ENABLED` |
| `authoring_schema_error_rate` | same | same |
| `authoring_schema_client_cache_hit_rate` | same | same |
| `facet_generation_latency` | `POST /facets` | `FACETS_ENABLED` |

Two mechanics worth knowing:

- **The mount facts are resolved ONCE per collection**, in
  `collectCatalogMetrics`, into a `MountedSurfaces` value that every producer
  reads — never `config` inside each producer. Three metrics hang off one flag,
  and three producers reading it independently is three chances for one of them to
  read a different answer. It is the reason every shared read here is taken once.
- **`CollectCatalogMetricsOptions.mounted` overrides it**, which is what lets
  `metrics.realdb.test.ts` drive BOTH branches: `config` is frozen at module load,
  so without the override the suite could assert the refusal and nothing beyond
  it — the arithmetic on the other side of the flag would be the branch nobody
  exercises.

`GET /categories` and `GET /search` are mounted unconditionally, so their metrics
never take this reading. `CANONICAL_SEARCH` does not change that: it lives in the
handler, not in the mount, so with it off `/search` is still mounted, still
observed, and answers 404 — a `clientErrors` increment with a real duration.

**The latency report cannot make this distinction, and that is worth knowing at
3am.** `readCatalogLatencyReport` omits `observed` and `withinBudget` whenever
there is no sample, so an unmounted surface and a cold task look identical there.
The discriminator is the metrics report: a `surface_not_mounted` reading against
that route says the surface cannot be served, where a `measured, numerator: 0`
says it can and nobody has.

---

## The must-stay-zero counters

`CatalogMetricsReport.mustStayZero` carries three integers. The
`ledgerImbalanceAttempts` precedent: a number nobody expects to be non-zero, put
where somebody will see it.

| Counter | Non-zero means |
|---|---|
| `unobservedRouteReports` | a caller composed a route observation key by hand. Impossible through `middleware/catalog-observability.ts`, which resolves the template from the same closed list the store is keyed on and DROPS an unresolvable path before calling. |
| `metricCollectionFailures` | a domain reader threw during a collection, or the middleware's finish handler threw. Read it beside the `unmeasured` / `source_unavailable` readings, which are the same event's other half. |
| `undefinedMetricEmissions` | the collector produced a reading for a key the registry does not define. Structurally impossible — the census refuses it — so a non-zero value means two lists have drifted, which is the failure the derivation exists to prevent. |

They are **process-local, per ECS task, and reset by every deploy**, and that is
stated rather than hidden because it decides how they may be read. A non-zero
value is unambiguous anyway: the conditions are impossible in normal operation,
so one is as alarming as a thousand. There is deliberately **no endpoint that
clears one** — a clearable counter is a counter that means nothing, and an
endpoint that zeroed it would be a way to close an incident without fixing it.
`resetCatalogRouteObservations()` exists and is called by nothing in production.

**The set is asserted as EXACTLY these three**, not by containment
(`route-observations.test.ts`), and the reasoning is stated there: a fourth
counter is a fourth thing somebody decided must never happen, and it belongs on
the report with a docblock rather than arriving unannounced.

**There IS a fourth counter, in a different module, and it does not reach the
report.** `catalogLogValueRefusals()` in `catalog-log.ts` counts string values
the redaction guard refused, is incremented through one private function so it
cannot drift from the condition it measures, and is read today only by
`correlation.test.ts`. So **a refusal is visible in production only as the
`logValueRefusals` field on the line that carried it** — `CATALOG_LOG_EVENTS`
defines a `log_value_refused` event and nothing emits it, so there is no line to
alert on by event name either. Whether the counter joins `mustStayZero` is the decision
the exact-three assertion exists to force; it has not been made, and the
production-readiness checklist carries it as an open item rather than this
document quietly claiming either answer.

---

## W16 — performance

### The four latency budgets

`CATALOG_LATENCY_BUDGETS` in shared-types, each carrying a `rationale` for the
same reason every metric carries an `attributionLimit`: a number with no
reasoning beside it is a number the next person on call raises until it stops
firing.

| Route | p95 budget | Rationale, in short |
|---|---|---|
| `GET /categories` | 150 ms | one statement over the materialized ancestry path on a tree of thousands of nodes, measured at 1.1–2.6 ms p50 by the ancestry benchmark; anything approaching this is a plan change, not load |
| `GET /catalog-authoring/schemas/:productTypeKey` | 400 ms | the COLD composition — a category, a product-type version, its field groups, every referenced attribute definition and their localizations. The memo serves the repeat and the ETag serves a returning client |
| `GET /search` | 600 ms | #61 measured every canonical read in single-digit milliseconds at a million offers; the headroom is #70's staged retrieval and the per-page offer hydration |
| `POST /facets` | 500 ms | several bucket aggregations over one category scope, measured at ten statements per scope by the facet sweep. A **POST** because the facet request carries a filter set too large for a query string — not a mutation |

**There is deliberately no autocomplete entry**, though W16's wording names one.
W1's "APIs for localized category search/autocomplete" is an open checkbox and no
such route exists; `GET /catalog-authoring/categories` is a localized BROWSE
(`parentId`, `roots`, `locale`, `limit`) with no text parameter, so budgeting it
as autocomplete would put a UX floor on a different operation. The budget is owed
by whoever ships the route.

They are **incident thresholds, not performance targets**, and deliberately
generous. A budget set at the current p95 turns green into "unchanged" and fires
on ordinary fluctuation, which is how a latency alert gets muted in week two.

The verdict is on **p95 alone**, in one place. p50 and p99 travel beside it so
the shape is visible, but a mean would hide the tail that is the entire reason a
budget exists.

### A budget with no observation is NOT "within budget"

The whole content of `budgets.ts`. The natural implementation compares an
observed p95 against a threshold and answers a boolean; on a task that has served
none of those requests the observed value is zero, zero is below every threshold,
and the surface reports four green ticks for four surfaces nobody has called.

`CatalogLatencyReport` therefore omits **both** `observed` and `withinBudget`
when there is no sample, so a consumer cannot render a verdict it was not given.
`breachedCatalogLatencyBudgets()` excludes an unobserved budget for the same
reason: it is neither breached nor clear, and including it would page somebody
about a task that has served no traffic.

That matters most where it is most misleading — a freshly rolled task, in the
minutes after a deploy, which is exactly when somebody is watching.

### Every budget names a route that is really mounted, and that is gated

`contract-gates.test.ts` §"#367 W16 — a budget names a route the API actually
serves" resolves every observed template against the routers that would serve it,
reading the mount prefixes back off `app.ts` so a remounted router FAILS rather
than being skipped, and holds the unserved set as `UNSERVED_TEMPLATES` —
**asserted EXACTLY, both directions**, on the `WOOCOMMERCE_OPEN_DEFECTS` rule. It
is now **empty**: a wrong template is a build failure, and so is a stale entry in
that list, because a list of known-broken things that only grows is a warning
about problems somebody already solved. Its `sameShape` matcher has its own
mutation self-test, since a matcher answering `true` for everything would report
zero unserved templates and read green forever.

| Budget | Shipped route | Observed on a STOCK deployment? |
|---|---|---|
| `GET /categories` | `routes/categories.ts` `router.get('/')`, mounted unconditionally | **yes** |
| `GET /search` | `routes/search.ts` `router.get('/')`, mounted unconditionally | **yes** (see the note below) |
| `GET /catalog-authoring/schemas/:productTypeKey` | `routes/catalog-authoring.ts`, behind `CATALOG_AUTHORING_ENABLED` (default **false**) | no — the metrics say `surface_not_mounted` |
| `POST /facets` | `routes/facets.ts` `router.post('/')`, behind `FACETS_ENABLED` (default **false**) | no — same |

**So on a default deployment only `GET /categories` and `GET /search` are
mounted**, and the authoring and facet budgets observe nothing until those flags
are on. The metrics report now SAYS that in words —
`unmeasured` / `surface_not_mounted`, with the variable named — rather than
showing a zero; §"An unmounted surface is not a seam" has the mechanics. The
LATENCY report does not distinguish it from a cold task, because it omits the
verdict either way.

`CATALOG_OBSERVED_ROUTES` is derived from `CATALOG_LATENCY_BUDGETS` element for
element, and `resolveObservedRouteTemplate(method, path)` matches a request's
`originalUrl` against those templates by METHOD and by SEGMENT COUNT, so a
`:param` segment matches exactly one non-empty segment and never spans a `/`.

### The three templates that named nothing, and why the gate exists

The first draft of the budget list was written from W16's own wording — "category
tree, authoring schema, autocomplete, search and facet APIs" — and **three of its
five entries named nothing the API serves**: the authoring schema is
`/catalog-authoring/schemas/:productTypeKey` and not `/catalog-authoring/schema`,
facets is a **POST**, and `/categories/autocomplete` does not exist at all. Two
were repointed and the third was REMOVED rather than repointed onto a browse
route that answers a different question. The record is kept because the failure
mode is the interesting part:

**An unservable budget is not merely inert, it is invisible — and invisible
through exactly the machinery this domain built to prevent invisible gaps.** The
latency report omits `observed` and `withinBudget`, which is correct and makes it
look like a cold task. The latency metric reports `measured, numerator 0`, which is
correct and makes it look like a task that has served none of those requests. And
`unobservedRouteReports` cannot see it either, because the middleware resolves the
template FIRST and drops an unresolvable path before calling the store —
deliberately, so that counter is not a traffic meter for the whole API. **So the
one counter that could have caught a bad template is bypassed precisely for bad
templates**, and only a gate that compares the budget list against the router
stack closes it. That gate is what now stands where the three defects were.

`GET /search` observes with a caveat worth knowing: the `CANONICAL_SEARCH` lever
lives in the HANDLER, so with it `off` or `shadow` the route is mounted, answers
404, and IS observed — as a `clientErrors` increment with a real duration. It is
not a 5xx and does not enter an error rate.

### The reservoir, and the two clocks

`route-observations.ts` is the `ledgerImbalanceAttempts` decision applied to
timings: module-scope numbers beside the code that records them, per ECS task,
reset on restart. The alternative was a table written on every catalog read,
which is a write in the hot path of exactly the surfaces whose latency is under
budget.

- **Counts are exact.** `requests`, `serverErrors`, `clientErrors` and
  `notModified` cover every request since the process started.
- **Percentiles cannot be.** `LATENCY_RESERVOIR_CAPACITY` is 4,096 — large enough
  that a p99 rests on about 41 samples rather than on one, small enough that the
  whole store is a few hundred kilobytes across every observed route.
  `observations` reports how many samples the percentiles were computed over, and
  it is a SEPARATE field from `requests` precisely so a reader cannot mistake one
  for the other.
- A **ring buffer of the most recent N**, not a uniform reservoir: for an
  incident signal "the last few thousand requests" is the question being asked,
  and a uniform sample over all time would dilute a live regression with
  yesterday's healthy traffic.
- **Nearest-rank percentiles**, reusing #61's `summarizeLatency`, so every figure
  reported is a latency some request actually took. An interpolated p95 is a
  number no request ever took, and the first thing anybody does with a latency
  figure is go looking for the request that produced it.
- A **negative or non-finite duration** is dropped from the reservoir while the
  request still counts. It cannot arise from a monotonic clock; the alternative
  is a p50 of `NaN` for the whole route.
- `304` is its own dimension — not an error and not a miss — which is what makes
  the client-visible cache hit rate a real number.

The route is a TEMPLATE, never a path. A concrete path would give one bucket per
category, each with a handful of samples and no usable percentile, and would put
shopper-visible slugs into a metrics surface.

### The middleware, and why it is mounted where it is

`app.use(catalogObservability)` sits above every router and above
`express.json()`, and there are two independent reasons:

1. A middleware appended AFTER the routers never runs for a request a router
   already answered, so it would observe exactly the traffic that matched no
   route — the opposite population, reporting a confident zero.
2. The correlation id is set as a RESPONSE HEADER, which is only possible before
   a handler writes. Mounted late, `res.setHeader` would throw
   `ERR_HTTP_HEADERS_SENT` on every request it touched.

It reads no body and parses nothing, so it is safe above the raw-body webhook
mounts.

The route is resolved from the path CAPTURED SYNCHRONOUSLY at the top, not from
`req.route` inside the `finish` listener. Express saves and restores `req.url`
and `req.baseUrl` around a mounted router's stack, and `finish` fires when the
response is flushed to the socket, which is not ordered against the stack
unwinding — so the template would be right most of the time and silently become
`/` or `''` some of the time, which is a bucket that reads as a healthy,
low-latency route. `originalUrl` is the one property Express never rewrites.

An unresolvable path is dropped HERE rather than handed to the store. This
middleware sees every request to the whole API — health probes, webhooks, orders,
admin — and handing each of them to `observeCatalogRoute` would make
`unobservedRouteReports` a traffic meter and destroy its one signal. The store's
own refusal stays as a real backstop for a caller that bypasses this file.

It cannot fail a request: everything on the finish path is inside one `try` whose
`catch` body is a single counter increment, and the catch deliberately does not
log — it runs inside a `res.on('finish')` listener, where a second throw has
nowhere to go.

### N+1 prevention, and what it does and does not cover

Inside this domain the N+1 is prevented by shape: `readShared` takes the ten
domain reads ONCE per collection under `Promise.all`, and every producer that
needs a slice of `readCatalogQuality`, `readGovernanceQueues`,
`summarizeMatchQueue` or the localization tally reads it out of that one result.
Every aggregate in `queries.ts` is `count(*) filter (where <enum> = …)` over a
closed value set, so the result is bounded by the number of distinct states
rather than by how much catalogue exists. The two exceptions are stated where
they occur: `tallyBackfillRetries` grows with `catalog_backfill_records`, and
`tallyExternalMappingCoverage` groups over every observed token.

W16's "prevent N+1 localization/attribute/value reads" is about the READ PATH,
not about this collector, and belongs to the authoring and localization
workstreams. Nothing here can claim it.

### Caching: what exists, and what does not

State accurately, because this is the checkbox most likely to be read as done:

**What exists** (owned by `services/catalog-authoring/schema.service.ts`, not by
this domain):

- A **process-local memo** holding ONLY compositions over a FROZEN product-type
  version — `published` or `deprecated`. A `draft` or `review` version is never
  memoized at all, because its fields, requirements and value policies can still
  move, so the memo holds exactly what somebody else's trigger has frozen.
- The cache key carries **every semantic dimension**: product type, category,
  flow, locale, market and a permission fingerprint, PLUS the invalidation
  REVISIONS of the subjects the composition read.
- **`catalog_authoring_schema_invalidations`** is the transactional register
  those revisions come from, with a partial-unique key per `(subject,
  subject_id)` and a `revision >= 1` CHECK. An entry composed under revision 4 is
  unreachable the instant the revision is 5, in every ECS task at once — which is
  W16's "invalidate through versioned events, not ad hoc process-local
  assumptions", and it is why the memo needs no eviction message.
- A **deterministic ETag** (`authoringEtag`) and a `304` answered when
  `If-None-Match` matches, which is what
  `authoring_schema_client_cache_hit_rate` counts.
- The memo is **bounded and drops the OLDEST**.

**What does not exist:**

- **No shared cache.** No Redis, no CDN rule, no cross-task store. Each ECS task
  composes cold once per key.
- **No hit-rate counter on the memo.** That is seam 1 above, and it is why "is
  the cache earning its place" is currently unanswerable — the 304 rate answers a
  different question about a different cache.

---

## The ancestry benchmark, and the part of ADR 0007 D2 that did not survive it

ADR 0007 D2 adopted a **materialized path of ids** (`categories.ancestor_ids
text[]` plus the GIN index `categories_ancestor_ids_idx`) over a closure table
and over a bare recursive CTE, and said in as many words: *"The choice is
provisional on a benchmark … if the materialized path loses to a recursive CTE at
a realistic scale, the ADR is amended before the alternative is adopted, never
after."* It was also the first entry under the ADR's own "Open items".

**Both are now settled.** The benchmark ran, it confirms the materialized path,
D2 carries the numbers and the one shape whose result is conditional, and the
open item is struck through and marked CLOSED. Read the rest of this section as
the record of a decision that was made rather than one that is pending.

`services/catalog-observability/ancestry-benchmark.ts` is that benchmark, and
`__tests__/ancestry-benchmark.realdb.test.ts` runs it against a real PostgreSQL
server on its OWN throwaway database.

### How it is measured

- **It seeds its own tree.** #61's `services/graph-benchmark/dataset.ts` seeds
  twenty-four categories, sets no `parent_id` and never writes `ancestor_ids`, so
  every ancestry read over it returns zero rows — the measurement of nothing
  #61's own floors exist to refuse. `SHAPE_OF_THE_TREE` is D2's own description
  as numbers: ten roots, a branching factor of `[4, 4, 3, 3, 2]`, six levels,
  **5,010 categories**, and two canonical products per leaf — **5,760 products**
  on 2,880 leaves. Only the deepest level is `selectable`, which is D2's
  structural-node rule and is also what
  `mercaria_category_assignment_selectable` enforces.
- **The tree is built by the REAL writer.** Every category goes through
  `insertCategory`, so `ancestor_ids` is the derivation production performs rather
  than this file's opinion of it.
- **Both sides run through one handle.** The materialized-path side CALLS
  `findCategoryDescendants` / `findCategoryAncestors`; the recursive CTE has no
  shipped reader (that is the point) and is composed here and issued through the
  SAME recording handle, so the two differ in their SQL and in nothing else.
- **Two clocks, never averaged.** Plan facts come from one
  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`; p50/p95/p99 come from
  **200 uninstrumented executions** per side per shape.
- **A comparison that measured nothing is REFUSED.** `deriveAncestryVerdict`
  refuses a shape whose either side produced zero rows, whose two sides disagree
  about how many rows they produced, or which came in under the tree's own
  arithmetic floor. Its `adrD2` verdict is then `inconclusive`, never a small
  number printed as if it meant something.
- **A win needs BOTH a relative and an absolute margin** —
  `ANCESTRY_TIE_BAND` (1.1×) AND `ANCESTRY_TIE_FLOOR_MS` (0.25 ms). The absolute
  floor was added because it was needed: early runs of the breadcrumb shape put
  the materialized path ahead by 1.15× and then behind by 1.11×, flipping the
  overall verdict on a difference of about fifty microseconds. A percentage of a
  very small number is a very small number, and an ADR amended on one is an ADR
  amended on which container had the CPU. It is what now holds T3 as a tie rather
  than as a loss.

### The four shapes and the result, over SEVEN runs

PostgreSQL 17.5, 5,010 categories over six levels, 5,760 canonical products, 200
uninstrumented executions per side per shape, over **seven runs — because one run
is not an answer, and this finding proves it**.

| Shape | Question | Result over seven runs |
|---|---|---|
| T1 | descendants of a ROOT (500 descendants) | **materialized path wins, every run** |
| T2 | descendants of a MID-DEPTH node (30 descendants) | **materialized path wins, every run** |
| T3 | ancestors of a deep LEAF — the breadcrumb (5 ancestors) | **TIE every run**, with the recursive CTE consistently the marginally faster side (0.115–0.226 ms), held under the tie band rather than counted as a loss |
| T4 | canonical products filed anywhere under a ROOT (576 products) | **conditional** — see below |

T1 and T2 are what carry the decision: won on every run without exception, by
**1.56× to 6.59×**. **D2's materialized path STANDS and the ADR should not be
amended to replace it.**

**T4 is conditional on the planner choosing `categories_ancestor_ids_idx`, and at
this scale that choice is not stable.** With the index it scans 6,261 rows and
the materialized path wins by 2.32×; without it, 10,771 rows, and the result is a
tie or a marginal CTE win (1.18×).

**So the harness's own headline verdict is unstable, and that is the most
important sentence here:** over seven runs `adrD2` came out **`agrees` five times
and `disagrees` twice**, and **every `disagrees` was T4 losing on a run where the
index was not chosen.** That is why the harness REPORTS the verdict and nothing
asserts it.

### `categories_ancestor_ids_idx` does real work, and SELECTIVITY decides

The stable, repeatable finding — and the textbook answer, which vindicates D2's
index rather than questioning it:

| Shape | Rows returned | Planner's choice |
|---|---|---|
| T2 | 30 of 5,010 (0.6%) | Bitmap Index Scan on `categories_ancestor_ids_idx` — 30 rows scanned, not 5,010 |
| T1 | 500 of 5,010 (10%) | sequential scan, **correctly**: an index is the wrong tool for a tenth of a small table |

So D2's *"the shape is already in the schema and already indexed"* is **right** —
with the caveat that on a table this size the planner sits near its own cost
boundary on the less selective shapes, and its choice there moves with `analyze`
and with concurrent load.

**There is no crossover figure worth quoting, and no row count is the threshold.**
A probe grows the table by 30,000 filler rows — to 35,010 — inside a rolled-back
transaction, re-runs `ANALYZE` and re-plans the same recorded statement, and it is
a **REPORTING probe with no assertion on the plan**, because its reported answer
has been seen both ways: a run with no index use at 35,010 rows, while T2 uses the
index at 5,010. It asserts only what is deterministic: that the filler was really
inserted — without which it would report the planner's choice at 5,010 rows while
naming 35,010 — and that the rollback really restored the table.

### Two drafts of this finding were confidently wrong, in OPPOSITE directions

The transferable lesson, and the reason the gates are shaped the way they are.

The first draft, from measurements taken **before `analyze` had settled** on the
freshly seeded tree, said the index is never chosen at this scale and only starts
paying between 20,000 and 30,000 categories — and quoted plan costs to prove it.
The second, from **two consecutive settled runs**, said the index is simply chosen
and D2 is vindicated outright. Both were **single-condition readings of a
cost-model decision**, and both were written with numbers attached, which is what
made them credible.

Nothing in the harness therefore asserts a planner choice or a verdict. What it
asserts is the pair that **cannot flip on statistics**, because neither asks the
planner to prefer anything:

- with `set local enable_seqscan = off`, the descendants predicate **CAN** be
  served from `categories_ancestor_ids_idx`, with no `Seq Scan` and exactly 30
  rows scanned. That separates an unusable index — a schema defect: the wrong
  operator class, a dropped index, a predicate respelt so no index can serve it —
  from a planner preference, which is a fact about the data.
- a **mutation self-test** drops the index inside a rolled-back transaction,
  re-plans the same recorded statement, and asserts the gate goes red AND names
  the index — then asserts the index is back, because a rollback that silently
  failed would leave every later measurement taken against a different schema.
  Without the index the whole table is read to answer a question about thirty
  rows, asserted as a ratio rather than assumed.

If you are about to quote a number from this section: it took seven runs to get
here, and the two figures that held across all seven are T1/T2's win and the
selectivity split.

### The breadcrumb tie has a cause, and it is a repository property

The CTE being consistently the faster side of that tie is **not** the strategy
losing. `findCategoryAncestors` answers in **two round trips** (read the row, then
read its ancestors by id) where the recursive CTE takes one. That is a property of
the REPOSITORY rather than of the hierarchy strategy — **a single statement
joining the row to its own `ancestor_ids` removes it** — and it is the shape most
likely to get worse on a deployment whose database is a network hop away rather
than a socket away, since the second round trip is then the dominant cost.
Recorded, not acted on: `statementCount` is a first-class part of every
measurement for exactly this reason, and it is the number that names the cause.

### What the benchmark does NOT cover

W16 asks for "taxonomy ancestry strategy **and high-cardinality attribute
queries**". Only the ancestry half is here.

T4's statement is still hand-written, because the comparison needs BOTH
strategies over one predicate and no shipped reader offers the recursive side.
Its provenance note used to say something stronger and no longer true — that *no
shipped path resolves a canonical-product subtree* — which was correct when it
was written and was overtaken by `countCategoryBuckets`
(`db/facets/facetRepository.ts`), live on `POST /facets`, resolving one
correlated subtree per child bucket. The shipped reader is now measured directly
as **C9** below. The caveat that survives is narrower and still worth holding
when reading T4's verdict: it is the one shape whose result is conditional on a
planner choice, and the one that swung the headline twice.

---

## Category index coverage (epic #367 line 138)

Line 138 asks to *"add indexes for ancestry, descendants, breadcrumb reads and
category-scoped schema resolution"*. **Measurement says no index is missing.**
`services/catalog-observability/category-index-coverage.ts` is that measurement
and the gate that keeps the existing coverage from regressing silently — which is
the part that was actually absent, because an index is the one thing a functional
test can never detect the absence of.

Nine shapes, each CALLING the repository function its HTTP surface calls, run in
`ancestry-benchmark.realdb.test.ts` against the same 5,010-category tree, with a
registry of 1,500 published product types and 4,000 active attribute definitions
seeded on top. Measured on PostgreSQL 17.5.

**Which of these are live matters and is measured, not assumed.** Only
`/catalog-attributes` (C6) is mounted unconditionally. `/facets` (C1, C5, C9) is
behind `FACETS_ENABLED`, `/taxonomy` (C2, C3, C4) behind
`CATALOG_TAXONOMY_V2_ENABLED`, and `/catalog-authoring` (C7, C8) behind
`CATALOG_AUTHORING_ENABLED` — **all three default to false**. So eight of the
nine shapes are measurements of what those flags would switch on, which is the
moment the numbers are worth having.

**Read the two halves of this table differently.** `stmts` and `rows out` are
functions of the readers and the seeded tree and are stable run to run. `rows
scanned` is a function of the plan the planner CHOSE, and on this schema at this
scale that choice is not stable — the right-hand column therefore reports what
was observed, with a range where more than one plan was seen across runs.

| shape | read | reader | stmts | rows out | rows scanned (chosen plan) |
|---|---|---|---:|---:|---|
| C1 | descendants | `findFacetCategoryScope` | 1 | 31 | 31 **or 5 010** |
| C2 | descendants | `findCategoryDescendants` | 1 | 30 | 30 **or 5 010** |
| C3 | ancestry | `findCategoryAncestors` | 2 | 5 | 6 |
| C4 | breadcrumb | `readTaxonomyBreadcrumb` | 6 | 6 | 13 |
| C5 | scoped schema | `findProductTypeForCategory` | 1 | 1 | 13 |
| C6 | scoped schema | `listActiveDefinitionsForCategory` | 2 | 1 007 | 7 026 – 10 019 |
| C7 | scoped schema | `listPublishedProductTypesForCategory` | 2 | 4 | ~1 530 |
| C8 | scoped schema | `productTypeIsScopedToCategory` | 1 | 1 | 12 |
| C9 | descendants | `countCategoryBuckets` | 1 | 4 | 286 276 **or 9 967 684** |

With the sequential scan taken away — the plan the gate asserts, and the only
one that is reproducible — the four shapes that name an index give:

| shape | index the forced plan uses | rows scanned | exec ms |
|---|---|---:|---:|
| C1 | `categories_ancestor_ids_idx`, `categories_pkey` | 31 | 0.11 |
| C2 | `categories_ancestor_ids_idx` | 30 | 0.06 |
| C5 | `product_type_category_scopes_category_idx`, + 2 pkeys | 13 | 0.12 |
| C9 | `categories_ancestor_ids_idx`, `canonical_products_category_id_idx`, `categories_pkey` | 286 276 | 88.58 |

### The four reads, answered

- **Ancestry** and the **breadcrumb** are not index-bound at all. Every statement
  they send is an `Index Scan` on `categories_pkey` over single-digit row counts;
  what they cost is **round trips** — two and six — and in each the subject row is
  read TWICE, because the service reads it to decide it is addressable and
  `findCategoryAncestors` reads it again. No index can improve that. The gate
  therefore pins the STATEMENT COUNT, which is the only number here that can
  regress. It earned its place immediately: C4's pin was first written at four
  from reading the call graph, and the gate failed on it at six.

  **The GIN on `ancestor_ids` is the wrong instrument for these two, and would be
  even if they were slow.** A GIN index answers CONTAINMENT — `@>`, `&&` — and
  cannot serve ordering or prefix work. Ancestry does not ask a containment
  question at all: it reads the subject's `ancestor_ids` array as a VALUE and then
  fetches those rows by primary key, ordering them in JavaScript from the array's
  own root-first order. There is no predicate for a GIN to serve, which is why
  the answer to "add an index for ancestry" is that the primary key is already
  the right one and is already chosen.
- **Descendants** is served by `categories_ancestor_ids_idx`, which reads 30 of
  5,010 rows when it is used. Whether the planner USES it is not stable even at
  0.6% selectivity — both C1 and C2 were observed taking the index on one run and
  sequentially scanning all 5,010 rows on the next, on one schema and one seed.
  So the choice is reported and NOT asserted; see the section above for the two
  opposite confident readings that preceded that decision. What IS asserted is
  that the index CAN serve the predicate when the sequential scan is taken away,
  and that it buys real narrowness when it does — under a tenth of the table.
- **Category-scoped schema resolution** has FIVE readers, not one, and the two in
  `schemaSourceRepository.ts` walk `parent_id` as a recursive CTE rather than
  reading `ancestor_ids` — deliberately, because `include_descendants` decides
  whether a hop counts and a GIN'd array cannot express "only if that particular
  ancestor said so". Its scope tables carry indexes on both columns already, and
  **the planner's use of them is scale-dependent**: at 60 product types it
  sequentially scans `product_type_category_scopes`, at 1,500 it switches to
  `product_type_category_scopes_category_idx`. Both plans are correct. The
  registry fixture is sized at 1,500 for exactly that reason — a smaller one
  would gate a decision the planner never makes.

### Two findings recorded and NOT acted on

**`categories_ancestor_slugs_idx` has no reader.** Every use of `ancestor_slugs`
in the backend is a projection or a write; not one is a containment predicate, so
the GIN serves nothing. Measured cost of keeping it: **1,048 kB** at 5,010
categories, and **3.3%** on the subtree re-splice `moveCategory` performs (p50
17.096 ms with, 16.558 ms without, over 60 rolled-back runs of a 500-row UPDATE).
Not dropped, on #61's precedent for the two indexes it records with no reader: the
cost is small, the drop is a `post` migration, and `ancestor_slugs` is the v1 read
contract ADR 0007 D13 retains — it is due to retire with the column, not before it.

**`countCategoryBuckets` is the most expensive category read measured, and the
one whose plan swings hardest.** Its cost is a QUERY SHAPE rather than a missing
index: each bucket resolves its own subtree through a correlated
`ancestor_ids @> array[c.id]` subquery, so the work multiplies by bucket count.
Every index its plan could want is present.

What the gate exposed is the swing. Across runs on one schema and one seed, the
CHOSEN plan was observed both ways — **286,276 rows scanned (95.17 ms) when it
takes `categories_ancestor_ids_idx`, and 9,967,684 when it does not**, a 34.8×
difference. The forced plan is the cheaper of the two, so the index is not merely
usable, it is worth using, and the planner is not reliably choosing it at this
scale.

`POST /facets` is behind `FACETS_ENABLED`, **default off**, so this is not a
live shopper cost today — which is the reason to record it now rather than the
reason not to. It is the read that turning that flag on would switch into the
shopper path, and this is what it would cost.

That is recorded and NOT acted on here, because the available actions are all
worse than the finding. No index is missing, so there is none to add. Asserting
the plan would be the gate `ancestry-benchmark.ts` argues at length against, and
would fail on a healthy change. Rewriting the query is a facet-rail change with
its own latency budget and its own owner. C9 exists so the shape and both of its
plans are visible to whoever picks that up.

---

## The periodic integrity checks

Six questions a CHECK constraint cannot answer, because every one of them spans
rows or spans tables.

| Kind | What it finds |
|---|---|
| `orphaned_reference` | a row pointing at a category, product type or attribute definition that is gone or out of service |
| `invalid_redirect` | a redirect whose target is missing, whose subject IS its target, or whose chain the resolver can no longer walk |
| `category_cycle` | a category reachable from itself through `parent_id` |
| `schema_version_unavailable` | a published row pinning a product-type version that can no longer be retrieved |
| `ancestry_path_drift` | `ancestor_ids` is not the path `parent_id` describes — a SILENT wrong answer |
| `stalled_queue_lease` | a queue row still holding a claim whose lease has expired |

W17's checkbox names four of these. `ancestry_path_drift` and
`stalled_queue_lease` were added because they are the two failures in this schema
that produce no error anywhere.

### Nothing repairs, and that is the design

The module issues no `INSERT`, no `UPDATE` and no `DELETE`, and there is no `fix`
parameter for one to hide behind — the `payment_discrepancies` posture, for a
sharper reason than tidiness. **Every one of these findings can be something an
operator did on purpose, mid-migration**: a category suppressed while its subtree
is rebuilt, a redirect staged ahead of a cutover, a product type pulled back to
`review` because its fields were wrong, a lease held by a task somebody is about
to restart. A sweep that "corrected" any of them would undo a decision, silently,
at whatever hour it happened to run.

### `population` is the vacuity floor and it is mandatory

A check that scanned nothing and a check that scanned a clean catalogue both
report `findings: 0`. `population` — the number of rows the check ACTUALLY
examined, counted with `countExamined` over the SAME bounded subject fragment the
finding query ran over, never a constant and never the finding count — is the
only thing that tells them apart. `population === 0` with a result present says
the table is empty, not that it is healthy.

It is also how a reader sees a TRUNCATED scan. Every scan is bounded by
`INTEGRITY_SCAN_LIMIT` (5,000) — an unbounded sweep over the whole catalogue is
one somebody switches off after the first incident it makes worse — so a
`population` equal to the limit means the check saw the first page and no more.
The number is the disclosure.

Ordering is `id desc` throughout, which on uuid v7 ids is "most recently created
first" — the order an operator wants when something has just started going wrong,
and the reason a truncated scan shows the newest breakage rather than the oldest.

### The sample takes a turn from each sub-scan

`orphaned_reference`, `schema_version_unavailable` and `stalled_queue_lease` are
each two or three independent scans over different tables. The sample used to be
the head of their CONCATENATION, which samples the earlier scans only: once they
reached `INTEGRITY_SAMPLE_LIMIT` (20) handles between them, a later scan's
findings were counted in `findings` and could never be named in `sample`. Reading
`orphaned_reference 35 / 32` beside twenty `catalog_governance_change_requests`
handles, an operator had no way to learn a dangling `catalog_proposals` row was
among the thirty-two — and the handle is the only thing in a result they can open.

The sample now takes a turn from each sub-scan, so every sub-scan that found
anything is represented, newest first within each. The cost is stated rather than
hidden: where several sub-scans report at once, a busy one shows fewer of its own
handles than it did. `findings` is unaffected — it counts everything found and is
never the size of the sample.

### `complete` is what makes a clean report readable

`CatalogIntegrityResult` has no failed state and must not grow one: a result
present in `results` is a scan that HAPPENED. A check that threw is omitted and
logged, and `complete: false` says so. A partial sweep reporting zero findings
across five checks is not a clean catalogue, and `complete` is the only thing
standing between those two readings.

The six run **sequentially**, which is not an oversight: `db` may be a
TRANSACTION handle (the realdb suite passes one, so a deliberately broken row can
be created, detected and rolled back without ever committing into a database
parallel test files share), and postgres.js pipelines onto a single connection —
running them in parallel would be correct against the pool and wrong against a
transaction.

### The three checks whose reasoning is easy to get wrong

- **`invalid_redirect` does not flag a chain.** The documented correction for a
  redirect pointing at the wrong category is to add a redirect FROM that wrong
  target onward, so chains are DELIBERATE and the resolver follows them. What is
  a fault is a chain the resolver can no longer walk, and rather than restate
  `MAX_REDIRECT_HOPS` (8, module-private to the taxonomy repository) each chain
  candidate is resolved through `resolveCategoryRedirect` and the finding is its
  VERDICT (`chain_exhausted` or `unresolved`). A LOOP needs no separate walk:
  every member of a loop has a redirecting target, so every member is a chain
  candidate. The EXAMINED set is date-filtered (`effective_from <= now()`,
  because there is no closing column) while the next-hop sub-read is NOT —
  measured: the resolver's own `findRedirectForSubject` reads no
  `effective_from`, so narrowing the sub-read below what the resolver walks would
  produce FALSE NEGATIVES. A check that disagrees with the reader it is checking
  has to disagree in the over-reporting direction.
- **`category_cycle` exists because a trigger already refuses one.**
  `mercaria_category_hierarchy_guard` refuses a cycle at write time, so a cycle
  cannot arrive through this application at all — which is the whole reason to
  look for one. What a trigger cannot stop is a restore from a dump taken before
  the guard existed, a bulk load under `session_replication_role = replica`, a
  `psql` session that stood the trigger down, or a logical replication stream.
  The walk is bounded at `CATEGORY_WALK_DEPTH_CAP` (64) in the recursive term, so
  a real cycle cannot hang the sweep — an unbounded `WITH RECURSIVE` over a
  cyclic graph runs until the connection dies, which is the failure this check
  would otherwise INTRODUCE.
- **`stalled_queue_lease`'s population is the CLAIMED rows, not the tables.** A
  claimed row is a tiny indexed subset, so the scan stays bounded without
  truncation — whereas paging the whole table would examine the NEWEST rows, and
  a stalled lease is by definition old, so the bound would systematically hide
  the thing being looked for. The three tables' spellings are not
  interchangeable: `lease_owner`/`lease_until` while `status = 'running'`;
  `claimed_at`/`claimed_by`/`claim_expires_at` while `finished_at is null`;
  `reprocess_claimed_at`/`reprocess_claim_expires_at` while `reprocessed_at is
  null`. A finished run keeps its claim columns as HISTORY, and reading the expiry
  without the completion is how a finished queue reports a permanent stall.

`catalog_governance_audit_events` is deliberately **not** scanned for orphans,
though its `(subject_kind, subject_id)` pair has the same shape and no foreign
key either: the audit outlives what it describes, an audit event naming a
category somebody removed is the record working, and reporting it would be a
false positive that grows without bound — the shape of a check somebody
eventually mutes.

### Every check has a positive control

`integrity.realdb.test.ts` inserts a genuinely broken row for each of the six,
asserts the check FINDS it, and — where the distinction is available — asserts a
correct row beside it is NOT found. The assertion is a DELTA inside one
`repeatable read` transaction that is rolled back, never an absolute: the test
database is shared with parallel files, siblings legitimately hold findings of
their own, and at `read committed` a parallel file's commit between two readings
lands in the delta (measured — the first full-suite run failed on exactly that,
from two different siblings, in one run). One case seeds a row for every check at
once and asserts every `population` moved, so a `countExamined` that silently
counted the wrong set fails there rather than reading as a clean catalogue
forever.

---

## The facet-scope sweep

One question: **which category scopes would render a bare filter rail if a
shopper visited them.** It is the numerator of `facet_scope_empty_rate` and it is
a property of the CATALOGUE, not of traffic — nothing here knows or could know
whether anybody visits the categories it reports.

- **The real rail is measured, not a re-derivation of it.** `examineFacetScope`
  calls `resolveFacets` on the same scope shape and the same defaults the
  `/facets` route hands a shopper who has expressed no preference, and reads
  `response.facets.length`. The cheaper `planFacets`-only reading was considered
  and REJECTED because it is wrong in BOTH directions: a plan entry that survives
  planning can still be suppressed at COUNT time (`no_values`, `single_value`,
  `degenerate_range`), and the taxonomy refinement plus the five commerce
  dimensions appear in no plan at all — so a scope with no faceted attributes
  would report a bare rail while a shopper sees six facets.
- **Sampled, deterministically.** The whole rail costs ten statements per scope at
  the measured floor and more where a category scopes in attributes, so the draw
  is capped (`FACET_SCOPE_SWEEP_DEFAULT_SAMPLE_SIZE` 200,
  `FACET_SCOPE_SWEEP_MAX_SAMPLE_SIZE` 2,000, and
  `METRICS_FACET_SAMPLE_SIZE` 60 when a metrics collection drives it). The draw
  is `order by md5(<seed> || id)`: deterministic, so two runs over an unchanged
  catalogue draw the same scopes and a moved number is a moved catalogue; and
  UNIFORM, which `order by id limit n` is not — ids are uuid v7, so ordering by
  id is ordering by creation time and the sweep would re-examine the oldest
  corner of the taxonomy forever and publish it as a fact about all of it.
- **Three counters and none absorbs another.** `sampled === empty + populated`
  and `drawn === sampled + failed`. A scope whose generation RAISED has no
  verdict: folding it into `populated` dilutes the rate that matters and folding
  it into `empty` inflates it, so it is counted on its own and excluded from the
  denominator — which is why the metric's denominator is `sampled` and not
  `drawn`. `population` is NOT the denominator either: it is the population the
  sample was drawn from, and dividing by it would spread the empties over rows
  nothing examined.
- **The frame is echoed** — locale, display currency (`FAIR`, because that is
  what the facets controller gives a shopper who has chosen none) and
  `includeDescendants: true` (because the `/facets` route defaults it true, and
  sweeping with it false would report every grouping root in the taxonomy as a
  bare rail: a large, confident, entirely wrong number). A facet count is not
  frame-independent, so a number that does not name its frame cannot be compared
  with another one.
- **Per-scope failure isolation.** A scope whose generation throws is logged at
  `warn` (not `error`: one malformed category would otherwise page somebody once
  per hour for as long as that row exists), counted in `failed`, and the sweep
  continues.

---

## The proposal review queue (#367 W6)

`GET /internal/catalog-metrics/proposal-queue` — the fifth GET on this surface,
and the distribution behind the registry's six proposal metrics.

Those six are single integers: how many were created and decided in the last
week, how many are open, how many sit in each of the three open states, and how
old the oldest open one is. That is the right shape for a dashboard tile and the
wrong shape for the question an operator actually has, which is **where the
waiting is**. A backlog of forty is a different situation depending on whether it
is forty things submitted this morning or four things nobody has looked at since
March.

Both come out of `tallyProposals` — ONE statement, one snapshot, one clock — so
the tile and the page behind it cannot disagree. `proposal-queue.ts` derives and
reads nothing; #70 extracted `summariseProjectedOffers` for the same reason and
the reasoning is unchanged.

### What it carries

| Field | What it is |
|---|---|
| `depthByState` | every one of the eight lifecycle states, empty ones included, each with its own `oldestAgeSeconds` (`null` when the state is empty, never zero) and an `open` flag derived from `CATALOG_PROPOSAL_OPEN_STATES` |
| `openDepth` / `totalDepth` | the backlog, and every row — the second counted as `count(*)` and NOT summed from the states above |
| `countsAgree` | whether the per-state counts account for every row |
| `agingBands` | five contiguous bands from zero, open-ended at the top, over the OPEN rows |
| `unbandedOpenCount` | open rows that fell in no band |
| `oldestOpenAgeSeconds` | `null` when nothing is open |
| `deferredAheadCount` | `deferred` rows whose `deferred_until` has NOT passed |
| `waitAge` | nearest-rank p50/p90/p95 and the maximum, **or an explicit refusal** |
| `sla` | that there is no target |

There is deliberately **no proposal id, store, submitter, label or convergence
key** anywhere in the response, and no parameter of any kind on the route. Which
proposal is oldest is a question `/internal/catalog-proposals?state=submitted`
already answers, ordered by the index built for it; narrowing an aggregate by
store is how "what is this merchant asking for" becomes answerable from a metrics
surface. A realdb test walks a REAL emitted reading for each of those field
names, with a positive control so a response of `{}` cannot pass it.

### The two health flags, and what each can notice

Both exist because a queue metric that reports a comfortable number while
measuring nothing is the failure this whole read is written against.

**`countsAgree`** compares a `count(*)` against the SUM of the eight per-state
filters. Those disagree exactly when a row carries a state this build's
`CATALOG_PROPOSAL_STATES` does not contain — and the reachable cause is not
exotic: a `pre` migration widening `catalog_proposals_state_check` ahead of the
image that reads it is how this repository ships a vocabulary change. Without the
flag the symptom is a backlog that is quietly short.

**`unbandedOpenCount`** is `openDepth` minus the banded total — a SUBTRACTION,
not an `age < 0` filter, and the difference is the point. It catches a row whose
`created_at` is in the FUTURE (a clock fault: the failure that produced
`observed_at > now` on every ingested record in #63 and #65 and hid as a
per-record parse failure) AND a gap opened between two bands, which is the edit a
later reader makes and which a negative-age filter is blind to. The realdb suite
inserts a future-dated proposal on purpose, because a health flag nobody has ever
seen fire is one nobody trusts.

### Why the percentiles can be withheld

`CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION` is **twenty, and it is derived rather
than chosen**. The percentiles are nearest-rank (`percentile_disc`), so p95 over
`n` samples is the element at rank `ceil(0.95n)` — which equals `n`, the maximum
itself, for every `n < 20`, and stops equalling it at exactly 20. Below the floor
a "p95" is the largest observed age wearing a more authoritative name, which is
the shape of a number that gets quoted. `contract-gates.test.ts` re-derives the
crossover from the rank formula in both directions, so changing the percentile
set moves the floor or fails the build.

Below it, `waitAge` is `{ state: 'unmeasured', population, reason:
'population_below_floor', floor }` — **with no percentile property of any kind**,
so a caller cannot render one. The population survives on the refusal because
"the queue is empty" and "the queue is too small to summarise" lead an operator
to opposite conclusions and both land there. The age BANDS remain, and they are
exact at any population because they count rather than estimate.

Nearest-rank also means every published figure is the age of a proposal that
really is waiting. A realdb assertion checks each one for MEMBERSHIP in the set
of open ages read as plain rows; mutating `percentile_disc(0.9)` to
`percentile_cont(0.9)` turns it red naming the interpolated value.

### And there is no SLA

`sla` is always `{ state: 'undefined_target', statement, seam }`. See §"What is
not measured, and why" item 8 — the aging is measured, the target is a policy
decision nobody has made, and `CatalogProposalSlaVisibility` has no member that
could say otherwise.

---

## The publication trace

`GET /internal/catalog-metrics/trace/:handleKind/:handle` answers "what happened
to this publication" from the durable rows the chain left behind.

| Hop | Row | Notes |
|---|---|---|
| 1 draft | `catalog_authoring_drafts` | status, version, schema hash, product type, category, locale, market, whether a schema snapshot was captured |
| 2 listing | `listings` | status, owner type, variant count, `published_at` (FIRST activation, #261) |
| 3 canonical links | `native_listing_links` | the attachments the AUTHOR declared, `method` and `confidence` |
| 4 offer convergence | `offer_outboxes` | status plus a DERIVED `convergence` reading of the revision pair |
| 5 variant matching | `match_queue` | one row per variant, plus `variantsWithoutQueueRow` |
| 6 attribute reindex | `attribute_reindex_requests` | **always `unreachable`** — see below |

### Why a ROW trace and not a distributed trace

W17 asks for "distributed traces". This repository has **no tracing backend** —
no OpenTelemetry, no `traceparent`, no span exporter — and the epic's own posture
on measurement is a JSON endpoint plus structured logs, with scraping and
alerting belonging to `oxy-infra`. A span tree would need a collector nobody has
provisioned, and the spans would be gone by the time anybody asked the question,
because the hops are MINUTES apart: publish commits, the offer outbox converges
on a later dispatcher tick, the match queue on a later one still.

So the trace is `tracePayment`'s shape: every hop is a durable row and the trace
is a read over them, which survives a restart, a deploy and a week. The
correlation id is what joins the LOG LINES to it — the half a row trace genuinely
cannot supply. **This is a deliberate divergence from the checkbox's wording and
is recorded as one**, not claimed as done.

### A closed two-member handle set

`CatalogPublicationTraceHandle` is `{ by: 'draft_id' }` or
`{ by: 'listing_id' }` and nothing else. There is no way to ask by email, by
seller name, by store handle or by free text, because no such parameter exists —
the `tracePayment` rule, held by the SIGNATURE rather than by a validation
schema, so an HTTP surface layered on top cannot widen it. The controller checks
the handle kind against those two literals before any read.

A handle that names nothing answers `undefined`, which the controller turns into
a 404 — a typo and a publication that never happened lead an operator to
different next steps, so six absent hops would be the wrong answer.

### Every hop distinguishes "did not happen" from "happened and found nothing"

Three-way, not two: `present` | `empty` | `absent`, with a reason on the last
two. A draft that was never published has NO listing (`absent`,
`draft_not_published`); a published listing whose author declared no canonical
selection has an EMPTY set of links (`empty`, `no_canonical_attachment`). Those
must not be one value — the first is a publication that has not happened and the
second is a completed one whose next hop will legitimately never fire.

The reasons that are findings rather than shrugs:

- **`no_outbox_row`** on a present listing. `publishDraft` calls
  `enqueueOfferConvergence` inside its own transaction and the row CASCADEs only
  with the listing, so this means the enqueue did not happen — a listing whose
  offers may claim it is on sale when it is not.
- **`no_queue_row_for_any_variant`**, and `variantsWithoutQueueRow` above zero.
  `syncListingFacets` enqueues one per variant, so a listing with six variants
  and one queue row is a partial enqueue, and a hop reporting only what it found
  would read as a working enqueue. The variants are COUNTED from
  `product_variants` rather than trusted from `listings.variant_count`, which is
  a maintained projection — a trace that read the column would be comparing a
  count against itself if it ever drifted (pinned by a case where the projection
  says 9 and there are 2).
- **`superseded`** on the convergence reading. A request that arrived DURING a
  run leaves `claimed_revision < requested_revision`, and a trace that collapsed
  it into `pending` would hide exactly the race the revision pair exists to
  survive.

`listing_has_no_draft` is NOT an error: a listing created by the connector import
path, the P2P path or a pre-#367 write has no authoring draft behind it, and
reporting that as a broken chain would make most of the catalogue look broken.

### The reindex hop is structurally unreachable, and that is the finding

`CatalogTraceReindexHop` has one state, `unreachable`, with
`consumer: 'absent'`, `producerOnPublicationPath: 'absent'` and an `evidence`
array of the four modules a reader should check before believing it is still
true. Two independent reasons:

1. **No consumer exists.** Nothing writes `processed_at`, anywhere.
2. **No publication path reaches it, and none could name this listing.**
   `publishDraft` is not among the queue's producers, and
   `ATTRIBUTE_ENTITY_KINDS` is `['product', 'variant']` meaning CANONICAL product
   and variant — so there is no `entity_id` a native listing could occupy. The
   join does not exist.

`queueWideUndrainedRequests` is labelled that way because it is the count over
the WHOLE table: no scoping to one publication is possible, and a field called
`pendingRequests` would be misread as this listing's backlog. Reporting the hop
as `pending` — what a naive count of unprocessed rows would say — is the failure
this branch exists to prevent: "queued, waiting" and "queued, and nothing will
ever read it" look identical in a depth metric and lead an operator to opposite
conclusions.

---

## Correlation ids

There was no request id anywhere in this backend before #367 — no
`AsyncLocalStorage`, no `cls` — so `correlation.ts` is the whole of it.

- **`AsyncLocalStorage`, not a threaded parameter.** The chain crosses three
  transactions and two queues; a parameter would have to be added to every
  repository signature on the path, and the first function that forgot would
  silently break the join with no test able to see it. The store is read by ONE
  consumer (`catalog-log.ts`) and is never a function's input, so nothing here
  can become a hidden argument to business logic.
- **An inbound id is a security decision.** Accepting
  `X-Mercaria-Correlation-Id` verbatim gives an unauthenticated caller two
  things: log injection (the value is written into structured lines an operator
  reads and a pipeline parses), and a cross-request correlation primitive —
  anybody who can choose the id can make two unrelated requests from two
  unrelated people share one trace handle, which is the linkage every guest and
  analytics decision in this repository is shaped to prevent (ADR 0003 I11).
- **The gate MINTS rather than refusing.** `CORRELATION_ID_PATTERN` is
  `/^[A-Za-z0-9_-]{8,64}$/` — a character set with no newline, no quote and no
  separator any log format treats specially, anchored at both ends. A malformed
  header, a repeated header (which Express hands back as an array) and an absent
  one all produce a freshly minted `mco_`-prefixed id. A 400 would be worse than
  useless: a header a client got wrong would fail the request it was only trying
  to label.
- **It is a REGEX LITERAL with its bounds written out**, not assembled from a
  template string. A pattern built with `new RegExp(\`…\`)` silently loses every
  backslash the template swallowed, and the failure direction is the dangerous
  one — a class that matches MORE than intended, here admitting the very newline
  the gate exists to keep out, with every test green. The test asserts the
  literal's `source` against the two exported bounds so the duplication cannot
  drift, and additionally that the source contains no backslash at all.
- **The id passing the gate is not TRUSTED, merely harmless.**
  `CorrelationIdResolution.origin` reports `client_supplied` or `minted` with a
  reason, so a reader of the trace knows which it is.
- **`CorrelationId` is branded with a module-private `unique symbol`**, so
  `runWithCorrelationId` cannot be handed an unvalidated string at all — the
  guarantee "everything in the store passed the gate" is a property of the type
  rather than of a runtime check somebody has to remember (the
  `BuyerRequestActor` device).
- **Nothing about a person is in the store.** One field, and
  `CatalogCorrelationContext` is deliberately not exported so no other module can
  widen it. The moment an identity rides in the same ambient store, every log
  line in the process acquires one by default and the allow-list below is
  worthless.
- **`currentCorrelationId()` answers `undefined` outside a request**, rather than
  a placeholder: a dispatcher tick, a migration and a script legitimately have no
  request behind them, and inventing an id for them would put lines that belong
  to no request into a trace that claims one. In the middleware's
  `res.on('finish')` listener the id is passed through `runWithCorrelationId`
  EXPLICITLY, because an `EventEmitter` listener runs in the emitter's async
  context rather than the one it was registered in — the id would otherwise be
  silently absent on exactly the line that ties a request to its trace.

---

## Privacy

**No id belonging to a person appears anywhere on this surface.** Not in a
metric, not in an integrity sample, not in a trace hop, not in a log line.

- **Metrics are integers and closed-set dimension keys.** Breakdown keys are
  locales, markets, source ids and states — never a category NAME, which is
  localized presentation, and never a merchant or a person. The cheapest way to
  guarantee a metrics surface leaks nothing is one whose values are all integers
  and whose dimensions are all closed enum sets (`services/payments/`'s metrics
  module set the precedent).
- **Integrity samples carry subject keys only** — `<table>:<id>`, bounded to
  `INTEGRITY_SAMPLE_LIMIT` (20). No name, no slug, no locale string, no free
  text. These tables carry no buyer, but an operator id and a merchant handle
  both live one join away and neither belongs in a health report.
- **The facet sweep's samples are category IDS**, never a localized name.
- **The trace names its columns explicitly** — the `provider_accounts` #46
  precedent — rather than using `db.select().from(...)`, which enumerates every
  column and is how a protected one reaches a response. No
  `created_by_oxy_user_id`, no `decided_by_oxy_user_id`, no
  `revoked_by_oxy_user_id`, no title, description or handle. An outbox row's
  `last_error` is reported as `hasLastError: 'yes' | 'no'` and the text never
  travels. `trace.realdb.test.ts` walks a REAL emitted trace as a serialized
  string and asserts the sentinel values written into those columns are absent —
  a runtime walk, not only a type-level claim (#92's two-gate rule).
- **`storeId` IS returned, deliberately.** A store is a TENANT, not a person: it
  is the id an operator needs in order to know whose catalogue this is, every
  merchant surface in the repository already prints it, and the alternative is a
  trace that cannot answer the first question anybody asks of it.

### The structured-log field set is a type-level allow-list

`CatalogLogFields` is a CLOSED interface. There is no `Record<string, unknown>`,
no `meta`, no `context`, no `extra` and none may be added — `services/analytics/`'s
rule applied to a log line, and the same argument: an analytics property and a
log field are both composed by our OWN code, so an open bag is not a defence, it
is the one mechanism by which a buyer's address, a seller's email or a bearer
token reaches production logs. A caller who wants to log an email finds there is
no property to put it in.

`CATALOG_LOG_FORBIDDEN_FIELDS` states the prohibition as a VALUE beside it — the
`RETAIL_FORBIDDEN_COMPONENT_KINDS` device — naming 33 field names across contact
details, credentials, query text, display labels, people and device fingerprints,
against 30 permitted ones. `correlation.test.ts` asserts the two lists are DISJOINT with a
floor above 20 on each (two empty lists are trivially disjoint), so a plausible
future addition (`sellerEmail`, `rawQuery`, `displayName`) fails the build rather
than passing review. `CATALOG_LOG_PERMITTED_FIELDS` is tied to the interface in
BOTH directions by two type-level `Exclude` checks, so a field added to one and
not the other fails `tsc`.

### And then a runtime guard, because three fields are free text

The type cannot help with `reasonCode`, `outcome` and `hop`: they are strings the
caller chooses, and "an operator-friendly reason" is exactly the slot somebody
eventually interpolates a listing title or an exception message into. So every
string value is inspected before it is emitted and a value that looks like a
credential or a contact detail is **REFUSED** — replaced by
`CATALOG_LOG_REFUSED_VALUE` (`[refused]`), never truncated. Truncation ships a
prefix of the secret and reads like success; a sentinel ships nothing, the
refusal is reported on the line as `logValueRefusals` and counted.

It **refuses** where #107's metadata gate **throws**, and the divergence is
stated rather than left to look like an inconsistency: that gate sits in a
composition that can fail safely, this one sits inside a request path and inside
a `res.on('finish')` listener, where a throw fails the request the line was only
describing.

Eight patterns, every one a regex LITERAL (a template swallows backslashes, and
here the failure direction is doubly bad — a broken pattern matches nothing and
the guard reports clean): email, bearer credential, JWT, `mgs_` guest cart token,
`mgx_`/`mgp_` portal token, `mercaria_sk_` developer key, Stripe secret key, and
an international phone number. Plus an over-length rule at
`CATALOG_LOG_MAX_VALUE_LENGTH` (256), checked FIRST, deliberately NOT
pattern-driven so emptying the pattern list cannot disable it.

The guard is mutation-tested: `inspectCatalogLogValue` takes its pattern list as
a defaulted parameter so the same forbidden corpus can be run with the list
EMPTIED, asserting every sample then PASSES — and `composeCatalogLogLine` is
driven the same way, with the raw value appearing on the line. Without that, a
corpus refused for some unrelated reason would read as a working guard. There is
a positive control of ordinary values too, a per-pattern sample census asserted
by NAME with a count equality, and an exact boundary pair on the length rule.

**The phone pattern's documented gap is worth reading before anybody tightens
it.** The `+` prefix is MANDATORY, which is #77's lesson at its strongest: a bare
digit run turns `iphone 15 128 256` into a phone number. The `00` international
form is DELIBERATELY NOT DETECTED, on two measured false positives — a real
`schema_hash` containing a `00` digit run, which put `[refused]` exactly where
W17 asks for a schema version, and a uuid. Tightening the rule to demand a
separator after the country code did not help: a hyphenated digit-heavy
identifier is indistinguishable from a dialled number with separators, which is
what this field set is mostly made of. The cost is stated: a phone number written
`0034600123456` in a `reasonCode` passes. That is the right way round — the
allow-list is what keeps contact details out, this is defence in depth behind it,
and a defence in depth that eats the primary field it sits in front of is a net
loss. A regression sample for each of those values now lives in the permitted
corpus, because the original corpus used `'a'.repeat(64)` as its hash sample —
all letters, no digit run — which is exactly why the positive control missed it.

---

## Operations

### Four read-only routes

`/internal/catalog-metrics`, behind `authenticateToken` then
`requireCatalogOperator`, in that order.

| Route | Answers |
|---|---|
| `GET /internal/catalog-metrics` | `CatalogMetricsReport` — every defined metric, `awaitingSeams`, `mustStayZero` |
| `GET /internal/catalog-metrics/integrity` | `CatalogIntegrityReport` — the six checks and `complete` |
| `GET /internal/catalog-metrics/latency` | `CatalogLatencyReport` — the four budgets against what THIS task observed |
| `GET /internal/catalog-metrics/trace/:handleKind/:handle` | one publication, hop by hop; `handleKind` is `draft` or `listing` |

Every response is the ordinary `{ success: true, data: … }` envelope, so a `jq`
path starts `.data`.

**The route set is CLOSED and read-only.** There is deliberately no "recompute",
no "clear this counter", no "resolve this finding" and no repair of any kind —
every integrity check is a DETECTION whose subject can legitimately be
mid-migration, so a write here would be a way to make the catalogue agree with a
dashboard. **The closure is asserted twice, from both sides.**
`contract-gates.test.ts` enumerates the registered set off the router's own stack
and asserts it EXACTLY against those four, with a mutation self-test on the
enumerator; `routes/__tests__/internal-catalog-metrics.test.ts` asserts the same
closure from OUTSIDE, over HTTP on the mounted app and BY METHOD — so a write
handler added under this prefix by any other router fails there too. That file
also pins the gate itself: allow-listed passes, a non-operator gets 403, an empty
list is a 404 from the MOUNT, and the PAYMENTS allow-list does not open it (a
payment operator tracing money has no business reading which of a merchant's
drafts were abandoned).

### The SAME allow-list, not a seventh

`CATALOG_OPERATOR_OXY_USER_IDS`, which #54/#55/#56/#57/#58/#60/#62/#68/#70/#78
and the eleven #367 domains already use. Reading how much of the catalogue is
translated is not a different power from publishing a taxonomy change, and a new
list would have to be granted to the same people, drift from it, and become the
one somebody forgets when an operator leaves.

**Empty list ⇒ NOT MOUNTED (404, never 401).** The mount is inside
`if (config.catalog.graphOperatorSurfaceEnabled)`, which is
`resolveCatalogOperatorIds().length > 0`, and `requireCatalogOperator` re-checks
the same flag as defence in depth because the mount and the gate live in
different files — exactly the pair that drifts.

**No rate limiter**, matching every sibling on this allow-list
(`/internal/catalog-governance`, `/internal/matching`, `/internal/search`,
`/internal/catalog-attributes` — none of them mounts one). The bound is the
allow-list: the caller set is a handful of named Oxy accounts, so a per-IP bucket
would be one bucket for the whole operator team, and the first real incident —
when several of them are refreshing these reads at once — is exactly when it
would trip. `/internal/payments` mounts one because its surface can MOVE MONEY.

### No prometheus, no sweep loop, no configuration

- **No metrics infrastructure.** No registry, no exporter, no scrape format.
  Scraping, alerting and dashboards belong to `oxy-infra`. This repository emits
  the numbers and does not route them.
- **No loop of any kind.** The integrity checks are a route a scheduled probe
  calls, and the probe's cadence is infrastructure configuration rather than a
  constant compiled into the image. The facet sweep runs inside a metrics
  collection and nowhere else.
- **No migration and no new environment variable.** Nothing in this domain is
  gated by a lever of its own; the levers that matter to it belong to the domains
  it reads (`CATALOG_AUTHORING_ENABLED`, `CATALOG_PROPOSALS_ENABLED`,
  `FACETS_ENABLED`, `CANONICAL_SEARCH`, `CANONICAL_GRAPH_ENABLED`,
  `MATCH_PIPELINE_ENABLED`, `OFFER_MATERIALIZATION_ENABLED`,
  `CANONICAL_SEARCH_INDEXING_ENABLED`).

  **TWO of ADR 0007 D12's six levers do not exist in the code and must not be
  quoted at anybody:** `CATALOG_LOCALIZATION_ENABLED` and — the one this note
  missed — `PRODUCT_TYPES_ENABLED` appear nowhere in `config/index.ts` or
  anywhere else in `packages/backend/src`. **D12 has since been corrected** and
  now names the four that exist, `FACETS_ENABLED` included, with the reason each
  absent one is absent; the reasons are different. Localized reads are not
  lever-gated but ARE transitively contained behind the two mounts whose surfaces
  consume them, and `/product-types` is mounted unconditionally on purpose.
  **The third absence, `CATALOG_AUTHORING_COHORTS`, has since been CLOSED** as
  `CATALOG_ROLLOUT_COHORTS`, so authoring rollout is no longer all-or-nothing and
  D12's staged rollout order is executable — see
  [catalog-rollout-cohorts.md](catalog-rollout-cohorts.md). Nothing in this
  domain reads it: a cohort narrows a MOUNTED surface per request, and the two
  metrics reads here still turn on the four booleans alone, so a metric reports
  `surface_not_mounted` for a lever that is off and a figure for one that is on
  however narrow the cohort. Recorded because a runbook step naming a variable
  that does not exist is worse than no step. Full inventory:
  [catalog-migration-operations.md](catalog-migration-operations.md).

### A metrics read is not free

`GET /internal/catalog-metrics` runs ten shared reads plus per-metric aggregates
**and a facet sweep of `METRICS_FACET_SAMPLE_SIZE` (60) scopes**, each of which
is the whole `/facets` rail — of the order of six hundred statements per call at
the measured floor. It is bounded, it is sequential, and it is not something to
poll every ten seconds. The declared `freshnessSeconds` on the facet metric is
3,600 for that reason; a probe should read this at minutes, not seconds.

`GET /internal/catalog-metrics/latency` reads no database at all — every input is
in module scope — so it is the cheap one, and it answers about the ONE ECS task
that served the request.

---

## What has NOT been done, checkbox by checkbox

The honest statement, because "observability landed" is the kind of claim that
stops anybody looking.

### Workstream 16

| Checkbox | State |
|---|---|
| Establish latency budgets for category tree, authoring schema, autocomplete, search and facet APIs | **Four of the five surfaces: done. Autocomplete: not possible yet.** Each of the four names a route that is really mounted, verified against the router stack by `contract-gates.test.ts`, whose `UNSERVED_TEMPLATES` is now empty and asserted empty. Autocomplete has no route to budget — W1's checkbox — and was removed rather than pointed at a browse endpoint. |
| Benchmark taxonomy ancestry strategy and high-cardinality attribute queries | **Partial.** The ancestry half is measured over four shapes with a verdict; high-cardinality attribute queries are not benchmarked here. |
| Add correct PostgreSQL indexes and inspect query plans using representative data volumes | **Partial.** Plans inspected at 5,010 categories / 5,760 products for the ancestry shapes, over seven runs. No index added and none needed — the finding is that `categories_ancestor_ids_idx` is used where it pays and skipped where it does not. Nothing here inspects the attribute, facet or authoring read plans. |
| Prevent N+1 localization/attribute/value reads | **Not this domain.** The collector takes its shared reads once, which is not the same claim. |
| Cache immutable published schema versions safely | **Done, elsewhere** — `schema.service.ts` memoizes only `published`/`deprecated` versions. |
| Key caches by all semantic dimensions | **Done, elsewhere** — the key carries product type, category, flow, locale, market, permission fingerprint and the invalidation revisions. |
| Invalidate through versioned events/outbox | **Done, elsewhere** — `catalog_authoring_schema_invalidations`. |
| Make backfills, reindexing and mapping reprocessing resumable and idempotent | **Partial, and narrower than this row said before.** `catalog_backfill_runs` is genuinely leased, cursored and drained — it is the ONE job here that resumes. **Mapping runs are NOT leased**: `catalog_external_mapping_runs.claimed_at`/`claimed_by`/`claim_expires_at` are written by no production code and `RUN_COLUMNS` omits them, and `openReprocessRun`/`runReprocessPage` have zero callers outside their own module — no route, no CLI, no dispatcher — so there is nothing to resume and nothing to start. Reindex requests have deterministic ids and NO consumer, so "resumable reindexing" is vacuous. Also untested where it matters: no test calls `claimBackfillRun`, so the expired-lease reclaim branch is unexercised. Detail and the operator steps: [`runbooks/catalog-backfill-resumption.md`](runbooks/catalog-backfill-resumption.md). |
| Add dead-letter/retry handling for asynchronous jobs | **Not done** for this epic's own queues — that is seam 6, `no_dead_letter_state`. #58's `match_queue` has one. |
| Define consistency behavior between DB publication and search index visibility | **Not done.** There is no index and no consumer; the trace's reindex hop says so. |
| Add load tests for large variant matrices, deep category trees and popular facets | **Partial.** The ancestry benchmark is a deep-tree load test at 5,010 nodes. Variant matrices and popular facets are not covered. |
| Add safeguards/limits against pathological schemas or combinatorial variant explosions | **Not this domain.** |
| Document operational recovery for partial indexing or cache failures | **Done** for the part that exists — see the indexing-lag runbook, whose honest content is that there is no indexer to recover. |

### Workstream 17

| Checkbox | State |
|---|---|
| Metrics for authoring schema fetch latency / error / cache hit rate | **Done, with one seam, and silent until a flag is on.** All three observe `GET /catalog-authoring/schemas/:productTypeKey` and are proven to move when the store is fed (`metrics.realdb.test.ts`' in-process control); with `CATALOG_AUTHORING_ENABLED` off — the default — they answer `surface_not_mounted` rather than zero. The item's fourth number, the SERVER memo hit rate, remains seam 1: the 304 rate is a different cache. |
| Metrics for draft completion, abandonment and validation failures by field code | **Partial.** Completion, abandonment and open count are produced; failures by field code is seam 2. |
| Metrics for direct canonical selection, automated matching, unresolved records and proposal creation | **Done** — eight metrics. |
| Metrics for taxonomy/product-type/attribute completeness | **Done** — three, consumed from `readCatalogQuality`. |
| Metrics for translation coverage, fallback use, stale/missing, machine-vs-reviewed | **Partial.** Coverage, machine share, stale and missing are produced; fallback use is seam 3. |
| Metrics for search zero-result rate by locale/market | **Partial.** `search_zero_result_rate_by_market` is produced, bucketed by market, narrowed to `traffic_class = 'human'` and excluding NULL-market rows from BOTH halves; `search_zero_result_rate_by_locale` is seam 4. Analytics collection is off by default, so an empty population means "not collecting". |
| Metrics for facet usage, latency and empty/invalid facet generation | **Partial.** Empty generation is produced; latency is produced on `POST /facets`, and answers `surface_not_mounted` while `FACETS_ENABLED` is off (the default); usage is seam 5; `invalid` is unmeasured below the metric layer, because the facets domain publishes no invalid verdict. |
| Metrics for mapping coverage and ambiguity by external source | **Done** — three. |
| Metrics for backfill/reindex progress, retries and dead letters | **Partial.** Progress, retries, failed runs and pending reindex are produced; throughput is seam 7 and dead letters are seam 6. |
| Structured logs with entity ids, schema versions and correlation ids without leaking | **Done** — a closed field set, a disjoint prohibition list, a mutation-tested guard. |
| Distributed traces across publish → outbox → matching/indexing | **Deliberately diverged.** A durable ROW trace, because there is no tracing backend; the indexing hop is structurally unreachable and says so. |
| Alerts and dashboards for publication failures, indexing lag, proposal backlog and translation regressions | **Numbers and endpoints exist; alerts and dashboards do not.** Wiring is `oxy-infra`'s, and each of the four has a runbook. |
| Periodic integrity checks for orphaned references, invalid redirects, category cycles and schema-version availability | **Done** — six checks, all four named plus ancestry drift and stalled leases. "Periodic" is a probe's cadence, configured outside this repository. |
| Runbooks for the above alerts | **Done** — six, linked at the top of this file. |

### What has not been rehearsed

- **No alert has ever fired.** Every threshold in the six runbooks is a proposal,
  not something observed to be actionable at production volume.
- **No budget has been observed against real traffic.** All four name a route the
  API serves and are proven to move when the store is fed by hand, but nobody has
  yet read an authoring-schema p95, a 304 rate or a facet p95 off a process that
  served shoppers — and on a stock deployment two of those four routes are not
  even mounted.
- **The integrity sweep has never run against a catalogue larger than
  `INTEGRITY_SCAN_LIMIT`**, so nobody has read a truncated `population` in
  anger.
- **The facet sweep has never run at `FACET_SCOPE_SWEEP_MAX_SAMPLE_SIZE`** against
  a real taxonomy, and the ten-statements-per-scope floor was measured on a scope
  with no faceted attribute.
- **`mustStayZero` has never been non-zero** outside a test.
- **The ancestry benchmark's numbers are from one machine, and its own headline
  verdict is not stable there.** Seven runs: T1 and T2 won every time, T3 was a
  tie every time, and `adrD2` came out `agrees` five times and `disagrees` twice —
  every `disagrees` being T4 on a run where the planner did not choose the index.
  Two earlier drafts of the finding were confidently wrong in opposite directions
  before that. Nobody has run it anywhere else, and the note about a network hop
  worsening T3 is reasoning rather than a measurement.

---

## Production-readiness checklist

Every line is a thing to CHECK, not a thing to have intended.

**Access**

- [ ] `CATALOG_OPERATOR_OXY_USER_IDS` names real people, and the list has been
      read by somebody other than whoever wrote it.
- [ ] `GET /internal/catalog-metrics` answers 200 for an operator and **404** for
      everybody else. A 401 means `authenticateToken` refused first; a 403 means
      the caller is authenticated and not on the list; a 404 with an operator's
      token means the list is empty.

**Before trusting a number**

- [ ] For each of the four budgets, EITHER `observations` is above zero on
      `GET /internal/catalog-metrics/latency`, OR the metrics report says
      `surface_not_mounted` for its route and that is the intended state. A budget
      with neither is a surface nobody has exercised.
- [ ] The dashboard renders `surface_not_mounted` as "not switched on here" and
      NOT as a seam or a zero — it is the one unmeasured reading that a variable
      fixes.
- [ ] Every `unmeasured` reading is rendered as a GAP, never as zero, and
      `awaitingSeams` is on the dashboard so the six are visible without
      reading this file.
- [ ] `proposal_sla_breach_count` is rendered as "no target defined", not as
      "0 breaches". It is the one seam whose gap is a POLICY decision rather than
      missing code, and a green tile there is a claim nobody has earned —
      `GET /internal/catalog-metrics/proposal-queue` carries the same statement
      in `sla.statement` for a surface to render verbatim.
- [ ] A ratio with `denominator: 0` renders as "no population", not as 0% or
      100%.
- [ ] `complete: false` on the integrity report is treated as louder than any
      finding count on it.

**Monitoring (wired in `oxy-infra`)**

- [ ] `mustStayZero.*` alerts at **any** non-zero value, all three of them.
- [ ] `GET /internal/catalog-metrics/integrity` is probed on a schedule, and the
      alert is on `complete === false` OR a `findings` above zero for
      `ancestry_path_drift`, `category_cycle` or `schema_version_unavailable`.
- [ ] The metrics probe runs at minutes, not seconds — a collection includes a
      60-scope facet sweep.
- [ ] `GET /internal/catalog-metrics/latency` is read per TASK, or its verdicts
      are aggregated in the knowledge that each answers about one task since its
      last deploy.
- [ ] A log-based alert exists on the presence of a `logValueRefusals` field on
      any `domain: "catalog"` line. It cannot be an alert on
      `catalog.log_value_refused`: that event is DEFINED and nothing emits it.
- [ ] A log-based alert exists for `catalog integrity check failed` at `error`
      level — the message an omitted check logs, and the only place
      `complete: false` explains itself.
- [ ] Every alert routes to a runbook in `docs/runbooks/catalog-*.md`.

**Data quality**

- [ ] A deliberate integrity finding has been created and observed end to end, so
      the check, the surface and the runbook are known to work before an incident
      needs them.
- [ ] `reindex_pending_count` is EXCLUDED from any "queue depth" alert, or the
      alert names the fact that the queue has no consumer.
- [ ] Somebody has decided whether `catalogLogValueRefusals()` belongs on
      `mustStayZero`.
