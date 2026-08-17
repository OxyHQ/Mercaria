# Runbook — catalog latency budget breach (#367 W16)

A catalog read surface's p95 went above its budget on some ECS task. Reference:
[../catalog-observability.md](../catalog-observability.md) §"W16 — performance".

**Three things to know before you look at anything.**

**First: there are FOUR budgets and every one of them names a route the API really
serves** — verified against the router stack by `contract-gates.test.ts`, whose
`UNSERVED_TEMPLATES` is empty and asserted empty. There is deliberately no
autocomplete budget: no such route exists (W1's checkbox), and it was removed
rather than pointed at `GET /catalog-authoring/categories`, which is a localized
browse with no text parameter. So an alert naming a fifth surface is reading
something other than this one.

**Second: on a DEFAULT deployment only two of the four are mounted.**
`GET /catalog-authoring/schemas/:productTypeKey` sits behind
`CATALOG_AUTHORING_ENABLED` and `POST /facets` behind `FACETS_ENABLED`, both
defaulting to false. Those two therefore have no observation and no verdict here —
and the LATENCY report cannot tell you that, because it omits the verdict for a
cold task in exactly the same way. **The metrics report is the discriminator**: it
answers `unmeasured` / `surface_not_mounted` for a route that cannot be served,
naming the variable to set.

**Third: the numbers are per ECS TASK and reset on every deploy.** A p95 here is
"what this task has served since it started", never a historical series. There is
no fleet aggregate in this repository and there is deliberately no prometheus.

**Owner:** the on-call engineer for the Mercaria API.

---

## The alert

`GET /internal/catalog-metrics/latency`, behind
`CATALOG_OPERATOR_OXY_USER_IDS`. It reads no database — every input is in module
scope — so it is cheap and it answers about the ONE task that served the request.

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-metrics/latency \
| jq '.data.budgets[]
      | {route: .budget.route, method: .budget.method,
         budgetMs: .budget.p95BudgetMs, withinBudget,
         observed: (.observed // "no observation")}'
```

| Condition | Means |
|---|---|
| `withinBudget: false` | **the alert.** `observed.p95Ms > budget.p95BudgetMs` on this task |
| `withinBudget` absent AND `observed` absent | no sample. **NOT green** — there is no verdict, deliberately. Two different causes, and this report cannot tell them apart: a cold task, or a route that is not mounted at all. Ask the metrics report (below) |
| `withinBudget: true` with a low `observed.observations` | a verdict over a handful of samples. Read the count |

An unobserved budget is excluded from `breachedCatalogLatencyBudgets()` too, for
the same reason: it is neither breached nor clear, and including it would page
somebody about a task that has served no traffic. That helper exists and no HTTP
route calls it today; the alert reads the report.

**To tell "not mounted" from "cold task", ask the metrics report:**

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-metrics \
| jq '.data.readings[]
      | select(.reason == "surface_not_mounted")
      | {key, reason, seam}'
```

A reading there means the route cannot be served in this deployment and the `seam`
names the variable to set. Nothing back means every budgeted route IS mounted, so
a missing observation is a genuinely quiet surface.

The budgets, and what each number is:

| Route | p95 budget | It is the point at which the surface has gone WRONG |
|---|---|---|
| `GET /categories` | 150 ms | one statement over the materialized ancestry path; measured at 1.1–2.6 ms p50 by the ancestry benchmark |
| `GET /catalog-authoring/schemas/:productTypeKey` | 400 ms | the COLD composition; the memo serves the repeat and the ETag a returning client |
| `GET /search` | 600 ms | #70's staged retrieval plus per-page offer hydration |
| `POST /facets` | 500 ms | several bucket aggregations over one scope, ten statements per scope measured |

The last two are the flag-gated ones.

They are deliberately generous. A budget set at the current p95 turns green into
"unchanged" and fires on ordinary fluctuation, which is how a latency alert gets
muted in week two.

## What it means

On that task, the 95th-percentile wall-clock time from route entry to response
finish — measured with `process.hrtime.bigint()`, captured synchronously at the
top of the request — exceeded the threshold over the most recent reservoir of at
most `LATENCY_RESERVOIR_CAPACITY` (4,096) samples. Nearest-rank, so the figure is
a duration some request actually took.

## What it does NOT mean

- **Not that the fleet is slow.** One task. Read several, or read the one the
  complaint came from.
- **Not that the database is slow.** The timer measures the WHOLE request: route
  matching, validation, every statement, the serializer and the write to the
  socket. A slow plan and a slow projection are one number.
- **Not a trend.** Counters and the reservoir reset on restart, so a comparison
  across a deploy is a comparison between two different populations.
- **Not necessarily recent.** The reservoir is the most recent 4,096 samples per
  route, so on a quiet surface it can span hours; on a busy one, minutes. A burst
  of slow requests can dominate it for a while after the burst is over. That is
  the intended bias — for an incident signal "the last few thousand requests" is
  the question — but it means a breach can outlive its cause.
- **Not a 5xx**, and for `/categories`, `/search` and `POST /facets` there is no
  error-rate metric at all. The only two ratio metrics over the route store —
  `authoring_schema_error_rate` and `authoring_schema_client_cache_hit_rate` — are
  keyed on the authoring-schema template alone. For the other three routes,
  `observed` on the latency report is the whole of what this surface knows; the
  store counts their 5xx and 304s, and no metric publishes those counts.
- **Not caused by `CANONICAL_SEARCH` being off.** With the lever `off` or
  `shadow`, `GET /search` answers 404 from the handler and IS observed — with a
  real, very small duration. That LOWERS the p95; it cannot raise it. That lever
  is in the HANDLER, not the mount, which is why `/search` never reports
  `surface_not_mounted`.
- **Not a breach at all on a surface that is not mounted.** With
  `CATALOG_AUTHORING_ENABLED` or `FACETS_ENABLED` off there is no observation to
  breach, and any figure attributed to those two routes came from somewhere other
  than this report.

## The first three things to check

**1. Read the report on the affected task, and look at `observations` before
`p95Ms`.**

A verdict over thirty samples is a verdict about thirty requests. There is no
minimum-sample rule in the code — `withinBudget` is computed from any non-empty
reservoir — so the count is the reader's responsibility.

**2. Establish whether it is the PLAN or the load.**

For `GET /categories` this is answerable, and it is the likeliest real cause. The
category tree read is a single statement over `categories.ancestor_ids`, and the
ancestry benchmark measured exactly what the planner does with it:

```bash
# Postgres must be up: docker compose -f docker-compose.postgres.yml up -d
# The plan-regression suite CI runs, against its own throwaway database.
bun run --cwd packages/backend test src/db/__tests__/graph-plan-regression.realdb.test.ts
# The ADR 0007 D2 ancestry benchmark, including the scale probe.
bun run --cwd packages/backend test \
  src/services/catalog-observability/__tests__/ancestry-benchmark.realdb.test.ts
```

Read the recorded finding before concluding anything about indexes, because two
earlier drafts of it were confidently wrong in OPPOSITE directions. What held
across seven runs is **selectivity**, not a threshold:

- a narrow subtree read (30 of 5,010 rows, 0.6%) gets a **Bitmap Index Scan** on
  `categories_ancestor_ids_idx` and scans 30 rows;
- a wide one (500 of 5,010, 10%) gets a **sequential scan, correctly** — an index
  is the wrong tool for a tenth of a small table.

So "the index is not being used" is not by itself a fault, and **no row count is
the threshold**: the planner sits near its own cost boundary on the less selective
shapes at this size and its choice moves with `analyze` and with concurrent load.
Do not quote a crossover figure; there is not one worth quoting. What IS
deterministic, and gated: the index CAN serve `ancestor_ids @> array[$1]` when the
sequential scan is taken away, and dropping it turns that red naming the index.

**3. Read the request-level lines, if debug logging is on.**

Every observed request emits a `catalog.route_observed` line carrying `method`,
`route`, `statusCode`, `durationMs` and the `correlationId`. It is at **`debug`**,
which is off in production by default (`LOG_LEVEL` defaults to `info` outside
dev), so this is a "turn it on for a window" step and not something to expect in
the log already. The correlation id is also on every response as
`x-mercaria-correlation-id`, so a slow request somebody reported can be quoted
back and found.

## Likely causes, most likely first

1. **A plan change.** The budgets are set so that approaching them is a plan
   change rather than load — that is the `/categories` rationale verbatim. A
   dropped index, a statistics change after a bulk load, or a table that grew past
   a planner threshold.
2. **The catalogue grew, or its statistics went stale.** `/categories` scans the
   tree, and which plan it gets is a selectivity decision the planner makes near
   its own cost boundary at this size. The bad case is a grown table with STALE
   statistics, where the planner is costing a size it no longer has — that is
   exactly the condition that produced two wrong drafts of the benchmark's own
   finding. Run `ANALYZE categories` before concluding anything.
3. **A burst still in the reservoir.** Compare against another task. If one task
   breaches and its siblings do not, and the breaching task is the oldest, the
   samples are historic.
4. **Contention on the shared pool.** Every catalog read shares the connection
   pool with checkout, orders and the dispatchers. A metrics collection is itself
   a few hundred statements including a 60-scope facet sweep, so a probe polling
   `GET /internal/catalog-metrics` every few seconds is a plausible contributor —
   check the probe's interval.
5. **`/search`'s own composition.** The staged retrieval plus per-page offer
   hydration is what the 600 ms headroom is for; a breach there points at the
   offer read rather than at retrieval, and #70's own plan shapes (Q16–Q24 in
   `docs/performance/`) are where to look.
6. **A cold task.** The authoring schema memo is per process and holds only frozen
   versions, so the first composition per key on a new task is a cold one — which
   is exactly what the 400 ms budget is set for. Read
   `authoring_schema_client_cache_hit_rate` beside it: a low 304 rate on a task
   whose p95 is high is a population of cold compositions rather than a slow one.
   The SERVER memo's own hit rate is still a seam.
7. **The budget is wrong.** Last, deliberately. It is the conclusion that requires
   the most evidence and is the easiest to reach for.

## Remedy

| Cause | Action |
|---|---|
| A plan change | Fix the plan, then re-run the plan-regression suite. `EXPLAIN` the reader's OWN statement — #61's harness records what postgres.js actually sent, so there is no transcription to drift. |
| Stale statistics after a bulk load | `ANALYZE categories` (and whichever tables the breaching read touches). The ancestry benchmark runs `ANALYZE` before measuring for exactly this reason: a plan chosen from default estimates is a plan for a database nobody runs. |
| A burst | Nothing. Confirm against a sibling task and let the reservoir roll over. |
| Pool contention | Lengthen the metrics probe's interval; a collection is not a cheap read. |
| A genuinely slower composition | The work belongs to the owning domain (search, facets, authoring), not here. This domain only measures. |
| The budget is wrong | Change `CATALOG_LATENCY_BUDGETS` **and its `rationale` in the same edit.** The rationale field exists precisely so a raised number carries the reasoning that justifies it; raising the number and leaving the sentence is how the budget stops meaning anything. |

## What NOT to do

- **Do not raise the budget to silence the alert.** That is the failure mode the
  `rationale` field was added to prevent, and it is called out in `budgets.ts`'s
  own header: a budget set at the current p95 fires on ordinary fluctuation, and
  the fix somebody reaches for next is a bigger number.
- **Do not average p95s across tasks.** They are separate populations with
  separate reservoirs. If you need a fleet figure, take the worst task's p95 and
  say so.
- **Do not read a missing `withinBudget` as green.** It is absent because there is
  no observation, and both fields are omitted together precisely so a consumer
  cannot render a verdict it was not given.
- **Do not add an index because a read is slow.** The measured finding here is a
  case where the index exists, CAN serve the predicate, is not chosen, and is
  slower when forced. Measure which plan the planner picks first.
- **Do not compare a p95 across a deploy.** The store is module-scope and resets.
- **Do not add a fifth budget without a mounted route behind it.**
  `contract-gates.test.ts` will fail the build, which is the point: three of the
  original five named nothing, and a budget for a route the API does not serve is
  invisible rather than merely inert.
- **Do not add a table to record these timings.** That was considered and
  rejected: it is a write in the hot path of exactly the surfaces whose latency is
  under budget.
