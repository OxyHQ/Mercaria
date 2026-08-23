# Runbook — catalog cache failure (#367 W16)

**Read the next paragraph before doing anything, because there is no recovery
procedure here and that is the finding, not an omission.**

The catalog serving path has **exactly one cache**, and a stale read from it is
not a state it can reach. `services/catalog-authoring/schema.service.ts` holds
an in-process memo whose **key carries the invalidation revisions**, so an entry
written under an older revision cannot be looked up under a newer one — it is
unreachable rather than wrong. It is bounded at `MEMO_MAX_ENTRIES` (512),
dropping the oldest, and it caches only compositions over a **published, frozen**
product-type version.

So there is **no cache to flush, no poisoned entry to evict and no
invalidation queue to drain**. A procedure for recovering from a stale catalog
cache would be a procedure for a state that has no representation.

This is the [indexing-lag runbook](catalog-indexing-lag.md)'s posture, for a
different subject: the honest answer is usually "nothing", and saying so in a
runbook is what stops the next person inventing a remedy.

**Owner:** the on-call engineer for the Mercaria API, who in almost every case
should establish which of the two real causes below applies and close the alert.

---

## The premises, and how to re-check them

This runbook is only as true as four facts about the current tree. Each is one
command, and **if any has changed, this runbook is out of date** and the change
that broke it owes a replacement.

**1. There is one module-level CACHE in the catalog path.**

Anchor the pattern at the start of a line, or the search also returns the
per-call grouping maps that live inside functions and the result is unreadable:

```bash
grep -rnE '^const .*= new Map<|^let .*= new Map<' \
  packages/backend/src/services/catalog-authoring \
  packages/backend/src/services/catalog-observability \
  packages/backend/src/services/product-types \
  packages/backend/src/services/attributes \
  packages/backend/src/services/facets --include=*.ts | grep -v __tests__
```

Expect **exactly two** hits, and only one of them is a cache:

| Hit | What it is |
|---|---|
| `catalog-authoring/schema.service.ts` `memo` | The cache this runbook is about. |
| `catalog-observability/route-observations.ts` `buckets` | **Not a cache** — the in-process HTTP latency reservoir behind the `route_observations` metric source. It answers no read, so it cannot serve a stale one; it resets on deploy, which its own metric definitions declare with `freshnessSeconds: 0`. |

A **third** module-scope `Map` that outlives a request is a new cache and owes
the three answers in the last section.

**2. There is no Redis in the catalog path.**

```bash
grep -rln -i redis packages/backend/src/services/catalog-authoring \
  packages/backend/src/services/product-types \
  packages/backend/src/services/attributes \
  packages/backend/src/services/facets --include=*.ts
```

Expect **no output**. Redis exists in this repository (rate limiting, FX) and is
deliberately not in front of the catalog. A cross-process cache would make
"restart the task" a real remedy and this runbook wrong.

**3. The memo key still carries the invalidation revisions.**

```bash
grep -n 'memo\b' packages/backend/src/services/catalog-authoring/schema.service.ts
```

The `remember` / `memo.get` pair and the docblock above them are the mechanism:
*"its key carries the invalidation revisions, so a stale entry cannot be looked
up."* If the key stops carrying them, staleness becomes reachable and this
document must be replaced with an actual procedure.

**4. The memo is still bounded.**

`MEMO_MAX_ENTRIES` is 512 and `remember` deletes the oldest on overflow. An
unbounded memo keyed per locale, per market and per permission set is a slow
leak whose symptom is a task dying hours later with nothing pointing here.

## What an alert on "cache" here can actually mean

There are exactly two, and neither is a stale read.

| Cause | What it looks like | Action |
|---|---|---|
| **Memory growth** | RSS climbing on a task serving authoring schemas | The memo is capped at 512 compositions. If it is implicated, premise 4 has changed — the cap or the eviction is gone. Otherwise look elsewhere; this memo has a ceiling and a small one. |
| **A cold memo after deploy** | `authoring_schema_client_cache_hit_rate` dips, latency rises briefly | Expected and self-correcting. The memo is process-local, so every deploy and every task replacement starts cold. It is a latency optimisation over a correctness mechanism that lives in Postgres. |

`authoring_schema_memo_hit_rate` is **`unmeasured`** with reason
`not_instrumented` — the memo exposes no counter. **A 304 rate is not a
substitute**: a client with no `If-None-Match` against a warm memo is a miss on
one and a hit on the other, so `authoring_schema_client_cache_hit_rate`
measures a different cache. See
[../catalog-observability.md](../catalog-observability.md) §"What is not
measured, and why".

## What NOT to do

- **Do not restart tasks to "clear the cache".** The memo cannot serve a stale
  entry, so a restart discards warm work and fixes nothing. It also makes the
  next latency reading worse for the reason in the table above.
- **Do not add a manual cache-flush endpoint.** It would be an operator control
  for an unreachable state, and it would then need protecting, auditing and
  testing — a permanent cost for a condition that does not occur.
- **Do not call `clearAuthoringSchemaMemo()` from production code.** It is a test
  seam, so a suite sharing process state is isolated; its docblock says so.
- **Do not read a rising `reindex_pending_count` as a cache problem.** That is a
  different subject with its own runbook and its own "nothing to do" —
  [catalog-indexing-lag.md](catalog-indexing-lag.md).
- **Do not assume a partial-indexing incident is a cache one.** Recovery for a
  half-finished migration pass is
  [catalog-backfill-resumption.md](catalog-backfill-resumption.md); a run that
  failed one page is **unclaimable** and waits for a person, which is a real
  procedure rather than an absence.

## If a second cache is ever added

The question this runbook answers is not "is there a cache" but **"can it serve
something wrong"**. A new cache owes an answer to three things before it needs a
recovery procedure — and owes a replacement for this document if any answer is
no:

1. Is the key derived from the invalidation revision, so a stale entry is
   unreachable rather than merely unlikely?
2. Is it bounded, and does eviction have a defined order?
3. Is it process-local? A cross-process cache makes staleness survive a restart,
   which is the point at which "flush it" becomes a real remedy and this
   document stops being true.
