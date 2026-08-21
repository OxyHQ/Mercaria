# Canonical graph performance

Everything in this directory was **measured**. Nothing is estimated, projected
or copied from another scale, and the harness that produced it refuses to write
a report at all when a floor it cannot vouch for goes unmet — see
[Vacuity floors](#vacuity-floors-why-a-green-run-is-not-evidence) below.

| File | What it is |
| --- | --- |
| [`canonical-graph-benchmarks.md`](./canonical-graph-benchmarks.md) | The **decisions** — index strategy per critical read, the reads that stay normalized, what was deliberately not adopted, and what a projection would have to carry if one is ever adopted. |
| [`plans-medium-before.md`](./plans-medium-before.md) | Generated report, `medium` scale, **before** #61's indexes. |
| [`plans-medium.md`](./plans-medium.md) | Generated report, `medium` scale, **after**. Same dataset, not re-seeded. |
| [`plans-small.md`](./plans-small.md) | Generated report, `small` scale, after. |
| [`plans-search-small.md`](./plans-search-small.md) | Generated report, `small` scale, with **#70's nine search shapes** (Q16–Q24). Same harness, same workload table; `docs/search.md` carries the decisions it justified. |
| [`folding-and-tokenization.md`](./folding-and-tokenization.md) | **#367's folding benchmark** — the recall matrix over the three folding spaces, what a per-locale analyser buys, what the localized full-text index costs, and four catalogue languages `normalizeEntityName` corrupts. A different KIND of measurement from the rest of this directory: verdicts rather than latencies, with its own floors. It adds no shape to the workload table, and #61's own gates are why. |

## Running it

The benchmark is opt-in and deliberately **not** in CI — seeding a hundred
thousand products on every commit is a long job that tells nobody anything. What
CI runs instead is
`packages/backend/src/db/__tests__/graph-plan-regression.realdb.test.ts`, which
drives the same workload table against a `ci` scale, in its own throwaway
database (the generator truncates, and the shared one carries every other
realdb test's fixtures), and fails the build when a read stops using the index
it was measured on — mutation-tested by dropping an index inside a transaction
and confirming the gate goes red naming the shape.

**Do not shrink the `ci` scale.** The property under test is a PLANNER
decision — whether Postgres still prefers the index over a heap scan — and a
gate that fires because a table became too small for an index to win is a gate
whoever hits it next disables, for a reason that is about statistics rather
than about the schema.

```sh
# One-time: a scratch database with the extensions, migrated.
docker exec <pg> psql -U mercaria -d postgres -c 'create database mercaria_bench owner mercaria'
docker exec <pg> psql -U mercaria -d mercaria_bench \
  -c 'create extension if not exists postgis' \
  -c 'create extension if not exists pg_trgm'

cd packages/backend
DATABASE_URL=postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_bench \
  bun run db:migrate -- --target-database=mercaria_bench --phase=all

# Then, per run:
GRAPH_BENCHMARK=1 \
  DATABASE_URL=postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_bench \
  bun run scripts/graph-query-benchmark.ts \
    --scale=medium --runs=50 --out=../../docs/performance
```

Flags: `--scale=ci|small|medium|large`, `--seed=<int>`, `--runs=<int>`,
`--label=<stem>` (the report filename), `--out=<dir>`, and `--no-seed` to
measure an already-seeded database.

**Two gates protect the target**, plus a third inside the generator: the script
refuses to run without `GRAPH_BENCHMARK=1`, refuses a `DATABASE_URL` whose
database name does not contain `bench`, and `seedGraph` re-checks
`current_database()` itself — it TRUNCATES, and a truncation guarded in one
file is guarded once.

### A before/after pass

`--no-seed` exists for exactly this. Re-seeding between the two halves would
change the physical layout as well as the schema, and the difference could then
be attributed to either:

```sh
# 1. Seed and measure the current schema.
… --scale=medium --label=medium-before --out=../../docs/performance
# 2. Apply the migration under test.
bun run db:migrate -- --target-database=mercaria_bench --phase=all
# 3. Measure the SAME rows.
… --scale=medium --no-seed --label=medium --out=../../docs/performance
```

## What the harness measures, and how

- **The SQL measured is the SQL the reader sent.** Every shape in
  `services/graph-benchmark/workload.ts` calls the repository function the API
  calls, against a drizzle handle with postgres.js's `debug` hook attached; the
  recorded statement and its bound parameters are what get `EXPLAIN`ed and
  timed. No SQL is transcribed anywhere, so the benchmark cannot drift away from
  the read it claims to measure — which is the failure mode a pasted query has,
  silently, in the direction that flatters whoever pasted it.
- **Two clocks.** `EXPLAIN ANALYZE` instruments every node and inflates
  execution time, so plan facts come from ONE instrumented run and the
  p50/p95/p99 come from N uninstrumented ones timed client-side (round trip
  included). The two are reported side by side and never averaged.
- **Rows scanned** is summed over LEAF nodes only, each contributing
  `(emitted + removed by filter + removed by index recheck) × loops`. So a
  filter that throws away 90% of what it read is visible, and a nested loop that
  re-scans its inner side 500 times counts 500 times. `scan/return` is that
  divided by the rows the statement returned — the amplification.
- **A mutating shape runs in its own rolled-back transaction, one per
  execution.** `EXPLAIN ANALYZE` really executes: the freshness sweep measured
  fifty times outside one would retire fifty pages of offers, and every run
  after the first would measure a predicate the previous run had emptied —
  falling latencies that look like a warming cache and are a shrinking table.
- **The dataset is deterministic.** Every id, price, Zipf rank and market code
  is a pure function of the scale name and one integer seed. Two runs of a scale
  produce byte-identical rows, so a plan that changed between two runs changed
  because the SCHEMA changed.

## Vacuity floors: why a green run is not evidence

A benchmark's most dangerous output is a number nobody measured, because a
measurement of NOTHING looks exactly like a fast one — a generator that inserted
no rows, a predicate that matched nothing and a plan taken against an empty
table all produce a small number and a tidy plan. So:

- Every table has a **row floor derived from the scale**, not from what the
  generator happened to write. Deriving it from the run's own output would make
  the check circular.
- Every shape declares a **minimum rows returned**. A shape that legitimately
  returns nothing would have to declare `0` and say why; none currently does.
- Shapes whose plan must not regress declare **required indexes** and
  **forbidden node types**.
- When any floor is unmet the report renders as `## THIS RUN MEASURED NOTHING`
  listing every violation, and the script exits non-zero. It does not quietly
  print a smaller table.

Both floors caught real faults while #61 was being built, which is the only
evidence that they work:

- `Q13: returned 0 rows` — the freshness sweep's twenty-two executions were
  sharing one transaction, so each found five hundred fewer lapsed offers than
  the last. That is a harness bug that would have published a falling latency.
- `Q10: plan contains a forbidden node type Seq Scan` — the first generator
  named every product `Benchmodel <i> Pro <j>X`, so `name % '<any name>'`
  matched 9,999 rows of 10,000 and the planner correctly ignored the trigram
  index. The run would have reported "the trigram index does not serve the
  search": a conclusion about the SEED, published as a conclusion about the
  SCHEMA.

The floors are unit-tested with mutation self-tests
(`services/graph-benchmark/__tests__/measure.test.ts`), and the plan-regression
suite mutation-tests itself by dropping an index inside a transaction and
confirming the gate goes red naming the shape.

## Caveats on the published numbers

- **Hardware.** Measured on a 32-core x86-64 host with 125 GB RAM, against
  `postgis/postgis:17-3.5` (PostgreSQL 17.5) in Docker with default settings —
  notably the default `shared_buffers`. Production is RDS with different
  memory, different storage and concurrent load. **The RATIOS are the
  transferable result; the absolute milliseconds are not.**
- **Cold cache was not measurable.** Evicting the OS page cache needs
  privileges a benchmark should not hold, so the reports give a "first touch
  versus steady state" buffer split and label it a LOWER BOUND on a cold read
  rather than a cold measurement. Every steady-state figure here is a warm one.
- **Index sizes are post-bulk-load and are not comparable between an index the
  migration created and one built afterwards.** An index built by
  `CREATE INDEX` over existing rows is packed dense; one maintained during a
  million-row insert is not. `offers_variant_comparison_idx` reads 103 MB and
  `offers_variant_price_sort_idx` 61 MB for the same three columns on the same
  rows, and that gap is build order, not a property of either shape.
- **The `large` scale (1 M products / 10 M offers) is DEFINED and was NOT RUN.**
  Its name appears in `dataset.ts` and nowhere in these numbers.
