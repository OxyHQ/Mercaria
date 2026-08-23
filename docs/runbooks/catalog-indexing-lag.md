# Runbook — catalog indexing lag (#367 W17)

**Read the next paragraph before doing anything, because the honest answer to
this alert is usually "nothing".**

`reindex_pending_count` **only ever grows.** `attribute_reindex_requests` has
several producers, a deterministic caller-supplied primary key, a lease-shaped
schema, a pending index and an `attempts` counter — and **no consumer**. Nothing
in this repository writes `processed_at`: the column appears in exactly one
place, as an `is null` predicate in a read-only operator listing. So **a rising
count is the EXPECTED reading and is not an incident**, and there is no worker to
restart, no lease to clear and no queue to drain.

That is why `reindex_throughput` is `unmeasured` with reason
`no_consumer_registered` rather than reporting a throughput of zero: a throughput
of zero and a stalled consumer are the same number, and only one of them
describes this deployment.

Reference: [../catalog-observability.md](../catalog-observability.md) §"What is
not measured, and why" seam 7, and the trace's reindex hop.

**Owner:** the on-call engineer for the Mercaria API, who should in most cases
close the alert and, if it keeps firing, get the alert changed.

---

## The alert

| Signal | Where | Condition |
|---|---|---|
| `reindex_pending_count` | `GET /internal/catalog-metrics` → `.data.readings[] \| select(.key=="reindex_pending_count")` | **do not alert on growth.** Alert only on the shape of the growth — see below |
| `reindex_throughput` | same report | always `unmeasured`; alert if it ever becomes `measured` without a consumer landing, which would mean somebody produced a number from nothing |
| `attributeReindex.queueWideUndrainedRequests` | `GET /internal/catalog-metrics/trace/{draft,listing}/<id>` → `.data.attributeReindex` | the same count, queue-wide, reported on every trace |

The only defensible alert on this metric today is a **rate** one: the count
growing much faster than the catalogue is being published, which points at an
enqueuer looping rather than at an index falling behind. An absolute threshold on
a monotonically increasing number is an alert that fires once and then fires
forever.

## What it means

Rows are being enqueued for a search re-index that no code path performs. The
producers are:

| Producer | When |
|---|---|
| `services/attributes/definition-registry.service.ts` | an attribute definition was published, deprecated or retired |
| `services/attributes/attribute-observation.service.ts` | a canonical attribute value was observed or selected |
| `services/attributes/source-mapping.service.ts` | a source's normalization rules changed |
| `services/curation/correction.service.ts` | an operator corrected a canonical value |
| `services/backfill/stages/projections.ts` | #60's backfill stage 7, and only while `CANONICAL_SEARCH_INDEXING_ENABLED` is on — with it off the stage records `reindex_disabled` and enqueues nothing. This one inserts the table DIRECTLY rather than calling `enqueueAttributeReindex`, so a search for the repository function's callers misses it |

**Do not re-derive that table by hand.** It is
`CATALOG_EVENT_CONTRACTS.reindex_request.producers` in
`packages/backend/src/services/catalog-event-contracts.ts`, and
`services/__tests__/catalog-event-contracts.test.ts` derives the same set from
the source tree and fails the build when the two disagree. This table said
"three enqueuers" and named three of them until that gate was written.

## What it does NOT mean

- **Not that search results are stale.** There is no attribute-derived search
  index for them to be stale against. `GET /search` (#70) composes its answer
  from live reads and is gated by `CANONICAL_SEARCH`; it does not consult this
  queue.
- **Not that a publication is incomplete.** `publishDraft` is not among the
  producers above, and it structurally could not land a row naming a native
  listing: `ATTRIBUTE_ENTITY_KINDS` is `['product', 'variant']` meaning CANONICAL
  product and variant, so there is no `entity_id` a listing could occupy. The
  trace reports `attributeReindex.state: "unreachable"` on a COMPLETE chain, and
  that is the point.
- **Not a stalled lease.** The integrity sweep's `stalled_queue_lease` check
  covers `catalog_backfill_runs`, `catalog_external_mapping_runs` and
  `catalog_external_token_observations` — **not** this table. A row here was never
  claimed, because nothing claims.
- **Not something a deploy fixes.** The rows are durable and correct; they are
  waiting for a consumer that does not exist.
- **Not a duplicate problem.** `reindexRequestId` is
  `<entityKind>:<entityId>:<attributeKey|*>:<reason>` and the insert is
  `ON CONFLICT DO NOTHING`, so a repeat writes nothing at all — no tuple version,
  no timestamp. The count grows with distinct WORK, not with retries.

## The first three things to check

**1. Confirm the reading, and read its own attribution limit.**

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-metrics \
| jq '.data.readings[]
      | select(.key|startswith("reindex_"))
      | {key, state, numerator, reason, seam}'
```

`reindex_pending_count` answers `state: "measured"` with the count as
`numerator`. `reindex_throughput` answers `state: "unmeasured"`,
`reason: "no_consumer_registered"`, and its `seam` names what would close it.

**2. Confirm the consumer is still absent** — this is the check that turns "the
runbook says to ignore it" into a fact about the current tree:

```bash
grep -rn "processedAt" packages/backend/src/db/attributes/attributeOpsRepository.ts
grep -rn "listPendingReindexRequests" packages/backend/src --include=*.ts
```

Expect exactly one `processedAt` occurrence (an `isNull` predicate) and exactly
two callers of the listing — its own definition and
`controllers/internal-catalog-attributes.controller.ts`. **If either has changed,
a consumer has landed and this runbook is out of date**; the throughput seam
should be closed in the same change.

**3. Find out WHICH enqueuer is producing the growth**, since that is the only
actionable question:

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  "https://<api>/internal/catalog-attributes/reindex-requests" \
| jq '{returned: .data.pendingReturned,
       byReason: ([.data.requests[].reason] | group_by(.)
                  | map({reason: .[0], rows: length}))}'
```

`reason` is the enqueuer's own vocabulary (`definition_published`, `backfill`,
and the observation reasons). A count dominated by `backfill` is #60's stage 7
doing exactly what it says; a count dominated by `definition_published` growing
without any definitions being published is a real finding.

That listing is capped at **200 rows, oldest first**, so `pendingReturned: 200`
means "at least 200" and the breakdown is over the oldest page rather than over
the queue. `reindex_pending_count` in the metrics report is the whole count. The
endpoint is read-only and there is deliberately no drain beside it, for the reason
in its own docblock: an operator button that marked these processed would discard
work nobody did.

## Likely causes, most likely first

1. **Ordinary accumulation.** The expected state. Somebody published attribute
   definitions, or a backfill ran with `CANONICAL_SEARCH_INDEXING_ENABLED` on,
   and the rows are waiting for a consumer nobody has built. No action.
2. **An alert on an absolute threshold.** The alert is wrong, not the system. Fix
   the alert.
3. **A backfill pass with search indexing on.** #60's stage 7 enqueues one row per
   canonical product, so a whole-catalogue pass adds one row per product in a
   single run. Expected, large, and finished when the run is.
4. **An enqueuer in a loop.** A definition-publication path called repeatedly
   would add rows under `definition_published` with no corresponding governance
   audit events. This is the one case worth escalating.
5. **A consumer landed and is failing.** Only reachable once somebody builds one.
   Then `attempts` starts moving and this runbook needs rewriting around a real
   claim path.

## Remedy

**In the expected case there is no remedy and none is needed.** Close the alert
and change its condition.

| Cause | Action |
|---|---|
| An absolute-threshold alert on a monotonic count | Change it to a rate, or exclude `reindex_pending_count` from queue-depth alerting entirely — the production-readiness checklist in the reference doc has that as a line item. |
| A whole-catalogue backfill pass | Nothing. Confirm the run is progressing with `GET /internal/backfill/runs` and `GET /internal/backfill/metrics`. |
| Search indexing enqueued by mistake | `CANONICAL_SEARCH_INDEXING_ENABLED=false` stops #60's stage from enqueuing. It does not remove the rows already there, and it must not — the rows are correct. |
| An enqueuer in a loop | Escalate to whoever owns `services/attributes/`. The rows are harmless; the loop is not. |
| Somebody wants the queue to drain | That is the seam, not an incident: build the consumer, and close `reindex_throughput` in the same change. #61 declined it deliberately because the refresh semantics belong to a projection nobody has adopted. |

## What NOT to do

- **Do not restart a worker.** There is none. This is the whole reason this
  runbook exists rather than a one-line alert description.
- **Do not `DELETE FROM attribute_reindex_requests`.** The rows are the record of
  what a future consumer owes. Deleting them makes the queue read as healthy and
  silently loses the work, and because the primary key is deterministic and the
  insert is `ON CONFLICT DO NOTHING`, the enqueuers will NOT re-create a row for
  work they already recorded — so the loss is permanent.
- **Do not write `processed_at` by hand** to make the number go down. That is the
  same loss with an audit trail that says it was processed.
- **Do not treat this as an offer-convergence or match-queue problem.** Those are
  different queues with real consumers and real dead-letter or lease semantics:
  `GET /internal/offers/convergence` and `GET /internal/matching/metrics`.
- **Do not add a `catalog_backfill_runs`-style dead-letter alert here.**
  `backfill_dead_letter_count` is measured now, but it is about BACKFILL RUNS —
  a queue with a bounded retry and a recorded terminal cause. Reindex requests
  have neither, and no consumer at all, so a dead-letter count over them would
  be a permanently green tile for a condition that cannot occur. The metric to
  read here is still `reindex_pending_count`, which only grows.
