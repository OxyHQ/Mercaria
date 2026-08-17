# Runbook — resuming an interrupted catalog backfill or reindex (#367)

A catalogue backfill, a reprocess run or a CLI migration pass stopped part-way —
a task was replaced, a deploy rolled, a page threw, somebody pressed Ctrl-C.
Reference: [`../catalog-migration-operations.md`](../catalog-migration-operations.md)
and [`../catalog-backfill.md`](../catalog-backfill.md).

**Read the next two paragraphs before touching anything, because three of the six
things an operator would reach for here cannot be resumed and two of them cannot
even be started.**

**One job in this epic is genuinely leased, cursored and drained: the catalogue
backfill runs (`catalog_backfill_runs`).** Everything below about leases, cursors
and reclaiming applies to that one. `attribute_reindex_requests`,
`catalog_external_mapping_runs` and the `catalog_external_token_observations`
reprocess stamps all carry lease-shaped columns that **no production code
writes**, and none of the three has a consumer. For those, "resume" is not a
degraded operation — it is an operation with nothing to resume, and a step telling
you to wait for one is a step that never completes.

**Never do any of these**, because each names an event that cannot occur:

- "Wait for the reindex queue to drain." It has no consumer and only grows.
- "Wait for the mapping run to be picked up." It has no dispatcher, no route and
  no CLI — nothing can start one.
- "Clear the stalled mapping-run lease." Nothing takes that lease, so there is
  never one to clear.
- "Retry the failed backfill page." The endpoint answers **409 "Another task is
  running this backfill page"** on a `failed` run, and that message is false. See
  §2.

**Owner:** the on-call engineer for the Mercaria API. A proposal backfill that has
not finished is the catalogue review desk's.

---

## 1. Which job is this? The inventory, with the honest column

| Job | Job row | Loop lever | Lease | Durable cursor | Deterministic id | Dead letter | Consumer |
|---|---|---|---|---|---|---|---|
| **A. Catalogue backfill runs** (#60; includes the `search_reindex` stage that ENQUEUES for D) | `catalog_backfill_runs` | `CANONICAL_GRAPH_ENABLED` (default false) | **yes** | **yes** | yes | **no** | **yes** — `startCatalogBackfillDispatcher`, `src/index.ts:164` |
| **B. External-mapping reprocess runs** (W11) | `catalog_external_mapping_runs` | none | **no** (vestigial columns) | yes | yes | no | **NO — and no producer path either** |
| **C. Token-observation reprocess** (W11) | `catalog_external_token_observations` | none | **no** (vestigial) | n/a | yes | no | **NO** |
| **D. Attribute reindex requests** (#94 table, #61's owed drain) | `attribute_reindex_requests` | none | **no** (vestigial) | n/a | yes | no | **NO** |
| **E. Proposal approval backfill** (step 6) | none — the population is `catalog_proposal_references.backfilled_at` | none | CAS, not a lease | per reference, **no cursor and no loop** | yes | no | operator / best-effort on approval |
| **F. Variant-axis legacy backfill** (step 4) | none, deliberately | none — CLI, `--apply` | no | **cursor is NOT durable** | yes | no | operator |
| **G. `catalog-backfill` classify / paths / reconcile** (W13) | none | none — CLI | no | **cursor is NOT durable** | yes (pure re-derivation) | no | operator |

Two things that look like jobs and are not: the **facet-scope sweep** runs
synchronously inside a metrics read
(`services/catalog-observability/metrics.service.ts:276`), and
`catalog_authoring_schema_invalidations` is a revision register read into a cache
key, not a queue — "no dispatcher and no listener, deliberately"
(`db/catalogAuthoring/schemaInvalidationRepository.ts:1-21`).

---

## 2. Job A — the one real resumption, and its one hole

### How it resumes on its own

`claimBackfillRun` (`db/backfill/backfillRunRepository.ts:145-200`) is
`SELECT … FOR UPDATE SKIP LOCKED` (`:169`) admitting a run whose status is in
`RESUMABLE = ['pending','paused']` (`:38`) **or** a `running` row whose
`lease_until` has passed (`:161-166`) — that second branch is the dead task's
lease being reclaimed. The owner is a per-process UUID
(`services/backfill/backfill.service.ts:110`) and the release is owner-checked
(`backfillRunRepository.ts:319-324`). The cursor (`db/schema/backfill.ts:161`) is
advanced only after the page's writes commit (`backfill.service.ts:224`, then
released at `:239`), and **a page that throws does not move the cursor**
(`:197-219`). Per-record identity keys with `ON CONFLICT` make a replayed page
converge.

So: **a task killed mid-page needs no operator action.** Wait for the lease to
expire and the dispatcher picks the run up from the same cursor. Confirm with
`GET /internal/catalog-metrics/integrity` — `stalled_queue_lease` reports a run
holding an expired lease, and it repairs nothing by design.

### The hole: a page-level FAILURE strands the run permanently

A page throw calls `releaseBackfillRun({outcome:'failed'})`
(`services/backfill/backfill.service.ts:210-217`), which sets `status='failed'`
and NULLs the lease (`backfillRunRepository.ts:311-318`). `failed` is in neither
`RESUMABLE` nor the expired-lease branch, and
`listResumableBackfillRuns` (`:336-352`) excludes it. **The dispatcher will never
touch that run again.** There is no `attempts` column on the run, no
`available_at` and no backoff.

And the operator endpoint misreports it: `POST /internal/backfill/runs/:id/page`
gets `page === undefined` and answers **409 "Another task is running this backfill
page"** (`controllers/backfill-operator.controller.ts:135-138`). Nothing is
running it. Verified.

**What to do.** Do **not** retry the page endpoint.

1. Read the run: `GET /internal/backfill/runs/:id`. If `status` is `failed`, note
   its `cursor`, `stage`, `mode`, `mapping_version` and cohort, and read
   `last_error`.
2. Fix the cause. `backfill_retry_count` and the outcome breakdown on
   `GET /internal/catalog-metrics` tell you whether records were failing
   individually (per-record isolation, expected) or the page itself aborted (this
   case).
3. Open a **new** run with the same `(stage, mode, mappingVersion, cohort)`:
   `POST /internal/backfill/runs`. `failed` sits outside the partial open-key
   predicate (`db/schema/backfill.ts:263-265`,
   `backfillRunRepository.ts:78-84`), so this succeeds and gives you a run whose
   cursor is NULL.
4. **Accept that it re-scans the cohort from zero.** Record idempotency
   (`ON CONFLICT DO UPDATE` on the identity key) makes that converge and write
   nothing twice; the cost is the full re-scan. The old run's cursor is preserved
   in the row and is unreachable by any code path.
5. Sanity-check the vacuity floor afterwards:
   `catalog_backfill_runs_counters_total_check` forces the outcome counters to
   SUM to `scanned`, and the metrics surface reports `scannedFromRecords` beside
   the runner's own counter with `countsAgree`. A run that reports a clean pass
   with `countsAgree: false` is the finding, not the pass.

### What is untested, and it is the mechanism box 4 rests on

No test calls `claimBackfillRun` directly — its four references are all
production. So **the expired-lease reclaim branch
(`backfillRunRepository.ts:158-166`) and the mid-page reclaim guard
(`backfill.service.ts:230-237`) are unexercised.**
`services/__tests__/backfill.realdb.test.ts`'s helper `runToCompletion`
(`:285-313`) pages to `nextCursor === null` and treats a lost lease as a test
failure (`:301`) — it is a runs-to-completion-once test.
`services/catalog-observability/__tests__/integrity.realdb.test.ts:761` tests the
stalled-lease **detector** against synthetic rows, not a reclaim. Treat a
production reclaim as first-time behaviour and watch it.

---

## 3. Jobs B, C and D — nothing to resume

### D. `attribute_reindex_requests`

Writers: `db/attributes/attributeOpsRepository.ts:203-214`,
`services/backfill/stages/projections.ts:153-161`, plus the definition-registry
and attribute-observation services. Readers: `listPendingReindexRequests`
(`attributeOpsRepository.ts:225-227`), whose one caller is a read-only operator
listing (`controllers/internal-catalog-attributes.controller.ts:285`), and a
`count(*)` in `services/catalog-observability/trace.service.ts:778`.
`grep "update(attributeReindexRequests"` exits 1 — nothing ever writes
`processed_at`, and `attempts` (`db/schema/attributeRegistry.ts:560`) is never
incremented. The code already says so: the publication trace's reindex hop is
hard-coded `state: 'unreachable'`, `consumer: 'absent'`
(`trace.service.ts:296-352`, evidence list at `:346-352`).

**A rising `reindex_pending_count` is the expected reading and is not an
incident.** Full treatment:
[`catalog-indexing-lag.md`](catalog-indexing-lag.md). On today's defaults not even
the producer runs — the #60 stage-7 enqueue is gated by
`CANONICAL_SEARCH_INDEXING_ENABLED`, default false.

> **Docblock that overclaims:** `db/schema/attributeRegistry.ts:544-548` says
> "claims are leases with an owner check". No claim function exists.

### B. `catalog_external_mapping_runs`

`openReprocessRun`, `runReprocessPage` and `readRunMetrics` have **zero callers
outside `services/catalog-external-mappings/reprocess.service.ts` itself** —
verified, with the positive control that the same grep shape returns three
production call sites for `claimBackfillRun`. There is no controller, no route,
no CLI script and no dispatcher. `claimed_at` / `claimed_by` /
`claim_expires_at` (`db/schema/catalogExternalMappings.ts:792-794`, with a CHECK
at `:826-828`) are written by nothing, and `RUN_COLUMNS`
(`db/catalogExternalMappings/externalMappingRepository.ts:824-842`) deliberately
omits them.

**So there is no external-mapping reprocess to resume, and none to start.** If a
mapping needs reprocessing today it is a code change, not an operator action.

> **Two overclaims to fix before anything cites them:**
> `reprocess.service.ts:13-17` says "the next claim re-reads that page" — there is
> no claim and no caller. And
> [`../catalog-observability.md`](../catalog-observability.md) previously said
> mapping runs are "leased and resumable"; that row is corrected in this branch,
> because a runbook citing it would send somebody looking for a lease that no
> code takes.

### C. `catalog_external_token_observations` reprocess stamps

`reprocessed_at` is written exactly once in the repository, as `null`
(`externalMappingRepository.ts:816`), and its only producer
`applyObservationResolution` (`:799`) is called only from the unreachable
`reprocess.service.ts:259`. The schema docblock admits it —
"Nothing drains the queue today" (`externalMappingRepository.ts:791-798`).

### What the stalled-lease detector can and cannot see

`checkStalledQueueLeases`
(`services/catalog-observability/integrity.service.ts:671-730`, registered at
`:749`) covers three tables: `catalog_backfill_runs`,
`catalog_external_mapping_runs` and `catalog_external_token_observations`. **Two
of the three can never populate**, because nothing in production writes their
claim columns — its own tests hand-INSERT those columns with raw SQL to make the
check fire (`integrity.realdb.test.ts:796-838`). So the detector is real for
`catalog_backfill_runs` and permanently `0/0` for the other two. Do not read a
zero there as health on those two; read it as "no mechanism".

---

## 4. Job E — the proposal backfill finishes only if you ask it more than once

`applyProposalBackfill` applies at most `CATALOG_PROPOSAL_BACKFILL_PAGE_SIZE`
(default 100, `config/index.ts:4400`) references and returns
(`services/catalog-proposals/backfill.service.ts:139-153`). **Nothing loops.** The
call made on approval is best-effort and swallows its failure into a log line
(`services/catalog-proposals/review.service.ts:545-555`).

Progress is durable per reference — a CAS,
`UPDATE … WHERE backfilled_at IS NULL RETURNING`
(`db/catalogProposals/proposalRepository.ts:381-397`), whose empty `RETURNING` set
IS the "already applied" answer — and the claim and the value write share one
transaction (`:218-272`), so a crash rolls back both.

**What to do after approving a proposal with more than 100 waiting references:**
`POST /internal/catalog-proposals/:id/backfill` repeatedly **until the response's
`referencesRemaining` is 0** (`backfill.service.ts:174-180`). Convergence on
re-run is tested
(`services/catalog-proposals/__tests__/catalog-proposals.realdb.test.ts:479`).

> **Docblock where the code is STRONGER than the comment:**
> `backfill.service.ts:178-186` warns that "a crash leaves a reference stamped
> whose value write did not land … recoverable by hand". Claim and write share one
> transaction, so such a row cannot exist. Harmless, except that it will send an
> operator hunting for orphaned stamps.

---

## 5. Jobs F and G — the CLI passes, whose resume point dies with the process

`scripts/backfill-variant-axes.ts` and the three
`scripts/backfill-catalog-{classify,paths,reconcile}.ts` passes return
`resumeAfterListingId` **only in the final report**
(`services/variant-axes/backfill.service.ts:580`, printed at
`scripts/backfill-variant-axes.ts:113`; same shape in
`services/catalog-backfill/classify.service.ts:365`, `repair.service.ts:207`,
`reconciliation.service.ts:217`). A `SIGKILL`, an OOM, or the
`assertReportSums` throw (`backfill.service.ts:541-544`) loses the resume point
while leaving every completed per-listing transaction committed (one transaction
per listing, `:530-536`).

**What to do.** Re-run from zero, or pass `--after` taken from the **previous
completed** invocation's output. Both are safe: these passes are idempotent by
construction (`backfill.service.ts:16-20`,
`services/catalog-backfill/repair.service.ts:1-17` — the `category_slugs` write is
a pure re-derivation) and every write converges on an identity key with
`ON CONFLICT DO NOTHING`. **Never assume a partial pass told you where it
stopped**, because a pass that did not finish printed nothing.

Two cautions specific to F, both from
[`../catalog-migration-operations.md`](../catalog-migration-operations.md) §Box 2:

- `runVariantAxisBackfill` has **no test**. Run it with `--limit` small first and
  read the report before widening.
- The report's `assignmentsWithheld` and the refusal breakdown are the only place
  an ambiguous legacy option becomes visible to you, because
  `countQueuedClaims` reads the **variant** grain only and there is no row-level
  read path for either grain. Keep the CLI output.

---

## 6. If you need a number

Everything here is on `GET /internal/catalog-metrics`
(`CATALOG_OPERATOR_OXY_USER_IDS`, empty ⇒ 404):
`backfill_progress`, `backfill_failed_run_count`, `backfill_retry_count`,
`reindex_pending_count`, and `backfill_dead_letter_count` — which answers
**`unmeasured` with reason `no_dead_letter_state`, and that is correct**: none of
#367's own queues has a dead-letter state, so a run that has given up is
indistinguishable from one still retrying, and a zero there would be a
permanently green tile for a condition that cannot occur. Definitions:
[`../catalog-migration-operations.md`](../catalog-migration-operations.md) §Box 5.

`GET /internal/catalog-metrics/integrity` carries `stalled_queue_lease`. **Read
`complete` before you read any finding count** — a check that threw is omitted
rather than reported clean.
