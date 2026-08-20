# Postgres: shared-test-database traps and the migration rebase protocol

> Moved out of `AGENTS.md`. The one-line rules stay there; this is the procedure.
> Schema decisions are `packages/backend/src/db/schema/CONVENTIONS.md`. How a
> migration reaches production: `docs/deploy.md`.

## The test database is built by shelling out to the real migrator

Each suite run gets its own throwaway, fully-migrated database (name pattern
`oxydb_test_<16 hex>`, from `@oxyhq/db/testing`), created and dropped by
`packages/backend/src/db/testDatabase.ts` — which SHELLS OUT
(`node:child_process` `spawn`) to the real `src/db/migrate.ts` entrypoint rather
than composing `runMigrations` a second time in-process. A second, in-test
composition is a second set of options that can drift from what production
actually runs with nothing noticing; a later "speed-up" that inlines the call
keeps every realdb suite green while validating a path production never takes.

## Traps the shared test database sets

- **A test that widens a global bound widens it for every parallel file.**
  Zeroing a config bound (e.g.
  `PAYMENT_RECONCILIATION_OPEN_PAYMENT_MIN_AGE_MS='0'`) turns an aggregate sweep
  into one over the WHOLE database whose upsert reopens rows a sibling resolved —
  and no census over query text sees it, because the zeroed config value IS the
  missing scope. Aim with a cursor floor computed as
  `max(id) where id < <fixture id>`, never a pre-taken `max(id)` (uuid v7 is not
  monotonic within a millisecond). Scoping the ASSERTIONS is not enough when the
  call WRITES.
- **Any realdb assertion that AGGREGATES must be scoped to ids the file owns.**
  Pair every count EQUALITY with a non-zero floor — an equality is vacuous at
  zero.
- **A correctly-scoped teardown can still be blocked by a row a SIBLING minted**
  (the matcher's retrieval is a trigram scan over every `canonical_products`
  row). The owner DECLINES the pinned ids (`planCanonicalTeardown`); never
  `catch` the `23503`, which also hides a genuine children-first mistake.
- **A trigger-toggle window may name exactly ONE table.**
  `ALTER TABLE … DISABLE TRIGGER` takes **ShareRowExclusive** (measured, NOT
  `ACCESS EXCLUSIVE`): no conflict with a reader, but one with `RowExclusive` —
  so an ordinary INSERT is the counterparty, which `withTriggerToggleLock`
  (window against window) cannot see. Holding one table's lock while taking a
  second's deadlocks against a writer taking the pair the other way. **Fix by
  SPLITTING, never by matching the writer's order** — both orders already exist
  here, so an ordering rule is a bet. Gated by
  `advisory-lock-census.test.ts` rule 4; the unforced suite cannot measure it
  (0/30 at base, 8/10 with a load generator holding the writer mid-transaction).
- **Every statement inside a trigger-toggle window must run on the `tx` handle
  `withTriggerToggleLock` hands the callback, never on the pooled `db`.**
  `ALTER TABLE … DISABLE TRIGGER` issued on the pool COMMITS on its own; a throw
  between the disable and the matching enable then leaves the trigger disabled
  DATABASE-WIDE for the rest of the run, and every LATER file asserting that
  trigger refuses a write passes VACUOUSLY. Inside the transaction the DDL rolls
  back with everything else, so an aborted window restores the trigger instead
  of dropping it. `advisory-lock-census.test.ts` fails the build on a
  `disable trigger` issued on the wrong kind of handle, in either direction.
- **`match_policy_versions_active_key` is GLOBAL** (one active policy per
  database). Every realdb file that matches must hold #63's advisory-lock mutex
  (`services/ingestion/__tests__/active-policy-slot.ts`) for its WHOLE run — a
  session-level lock on a RESERVED connection. Do not scope the index, do not
  borrow the active policy, do not `DISABLE TRIGGER` to free the slot (it takes
  **ShareRowExclusive**, the same lock the bullet above measures — not
  `ACCESS EXCLUSIVE`, which this file claimed until #301 — so it does not shut
  out a plain `runMatch` READ; it queues behind the ordinary INSERT/UPDATE/DELETE
  every match writes, which the mutex cannot prevent because it serialises
  window against window), do not retry-loop (each retry is an aborted
  transaction against the pool the holder needs). Re-measure off `pg_locks` and
  CI's own `40P01` detail before restating either lock mode — do not re-assert
  from memory.
- **A lock-wait observation must NAME ITS OWN HOLDER.** `select count(*) from
  pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`
  is a question about the whole shared database, and a file may only act on an
  answer about ITSELF. Measured over one full run: a session was in
  `wait_event_type = 'Lock'` for 22.8% of its wall clock (304 of 1331 samples at
  50ms), 432 of those observations on `select pg_advisory_lock($1)` — the global
  matching-policy slot, held for a whole file's run while the next queues. So the
  unscoped count is a positive control a STRANGER satisfies, which releases a
  barrier before the race it is guarding has happened. Use `pg_blocking_pids`
  against a pid the file computed — the WAITER's where it is knowable
  (`canonical-teardown`, `concurrent-publish`, `connection-mode`), the HOLDER's
  where the waiter runs on the pool and its backend is not
  (`variant-axis-backfill-vanish`, #795) — and tell "nothing ever blocked" apart
  from "the block was not observed in time": only the first is a bug in the code
  under test. After #803 no unscoped lock-wait control remains in the backend.
  **One hop answers `> 0` and nothing more.** Row-lock waiters CHAIN — the second
  queues behind the FIRST WAITER — so a one-hop
  `pg_blocking_pids(pid) @> array[holder]` count reports the head of the queue
  however many are lined up (measured: holder plus two waiters gives 1, the
  recursive form gives 2). "Is anyone queued behind me" is one hop; a barrier
  that must see N waiters needs `connector-pin-release`'s recursive CTE, which
  paid for this once already by timing out at every poll while
  `pg_stat_activity` plainly showed both racers waiting.
- **`FAIL x.test.ts` with `Tests 0 failed` is a load failure**, not a regression.
  Baseline on the base revision under the SAME parallel conditions.
- **A service that starts writing a NEW table makes every fixture that CALLS it
  a writer of that table.** Measured when `accrueRewardForConversion` started
  writing `referral_ledger_postings`: `referral-rewards.realdb.test.ts` began
  creating rows it never named, and its teardown — which only knew its OWN
  tables — failed with `23503` on the first full-suite run. A sibling fixture's
  teardown has to change WITH a service's new write, not after somebody notices.
- **Write fixture instants RELATIVE to `now`** — a hardcoded absolute date
  detonates in a sibling file's expiry sweep. The opposite direction bites too:
  a fixture date the real clock has not yet REACHED passes today and fails on
  the day it arrives — `docs/pickup.md`'s "Teardown and the trigger-toggle
  window" section has the worked example (moving an injected clock back a
  week rather than extending a closure's date forward).
- **A green realdb case is not evidence you measured what you NAMED — `tsc`
  is.** The backend compiles with `strict: false`, so a bogus literal reaches a
  service and the call still runs. Measured in #639: `offerContext: 'available'`
  is not a `CatalogOfferContextState` (`included | withdrawn`), and it passed
  four cases whose numbers happened to be unaffected — a green suite over a call
  that was not the call the author meant to make. This is `AGENTS.md`'s "a build
  is not a substitute for `tsc`" from the MEASUREMENT side: there Babel strips
  types and `expo export` bundles what `tsc` rejects; here a passing assertion
  says the rows were right and says nothing about whether the call was the one
  you named. Typecheck before believing a realdb number, and before quoting one
  in an issue.

## What the harness needs from its role, and why superuser costs the reserve

The suite connects as `mercaria`, which the `postgis/postgis` image creates as a
**SUPERUSER** — locally (`docker-compose.postgres.yml`) and in CI
(`ci.yml`'s `POSTGRES_USER`). `superuser_reserved_connections` withholds nothing
from a superuser, so the reserve that exists to keep a slot free for an operator
is spent by the fleet that exhausts the pool (#696). Measured on a private
`postgis/postgis:17-3.5` with the shared server's settings
(`max_connections=100 superuser_reserved_connections=3 reserved_connections=0`),
both roles on one server with no other client backends:

| role | held | first refusal | routine | message |
|---|---|---|---|---|
| `mercaria` (superuser) | **100** | attempt 101 | `InitProcess` | `sorry, too many clients already` |
| non-superuser + `CREATEDB` | **97** | attempt 98 | `InitPostgres` | `remaining connection slots are reserved for roles with the SUPERUSER attribute` |

Two slots fewer, and — the point — a *different* refusal: three slots stay
reachable for a person diagnosing the saturation.

**A non-superuser IS sufficient. Measured, not predicted**, by running the real
entrypoint (`createMercariaTestDatabase` → `spawn` of `src/db/migrate.ts`
`--phase=all`) and the real realdb files. Three things stood between it and
green, each with a fix that needs **no server restart**:

- **`CREATE EXTENSION postgis`.** `createTestDatabase` issues a bare
  `create database`, so a throwaway inherits `template1` — which the image does
  NOT seed (it seeds `template_postgis` and `POSTGRES_DB`). PostGIS is
  `trusted=false`, so the per-database create genuinely runs and genuinely needs
  superuser. Seeding `template1` **once** makes
  `CREATE EXTENSION IF NOT EXISTS` short-circuit on the duplicate-name check,
  which is reached BEFORE the privilege check — measured: without
  `IF NOT EXISTS` the same role gets `extension "postgis" already exists`, not
  `permission denied`. `pg_trgm` is `trusted=true` and needs nothing; the
  unprivileged role creates and owns it.
- **`SET LOCAL session_replication_role = replica`** (`buyer-requests.realdb`,
  `integrity.realdb`). Superuser-only as a GUC, and deliberately chosen over
  `ALTER TABLE … DISABLE TRIGGER` because it takes no table lock and so cannot
  build the #301 deadlock — rewriting it would trade a privilege for a hang.
  `GRANT SET ON PARAMETER` (PG15+) grants exactly it; `pg_parameter_acl` is a
  SHARED catalog (`relisshared=true`), so one grant covers every future
  throwaway database.
- **`ALTER TABLE … DISABLE TRIGGER ALL`** — one statement, in
  `offer-freshness.realdb`, fixed here to `DISABLE TRIGGER USER`. `ALL` names
  the table's internal FK triggers, which is what requires superuser and buys
  nothing (a row's own FK checks do not fire on DELETE) while silencing `23503`
  for the window.

So the provisioning is three statements on a RUNNING server, and this is the
argument for it over `reserved_connections` (the other candidate in #696):
that setting is `postmaster` context, so it cannot be applied without restarting
the shared container — which destroys every in-flight realdb run on it.

```sql
CREATE ROLE mercaria_test LOGIN PASSWORD '…'
  NOSUPERUSER CREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
GRANT SET ON PARAMETER session_replication_role TO mercaria_test;
\c template1
CREATE EXTENSION IF NOT EXISTS postgis;
```

**Flipping the harness to that role is a COORDINATED step and is deliberately
not done here.** `vitest.pg.globalSetup.ts`'s `LOCAL_COMPOSE_URL` and `ci.yml`'s
`TEST_DATABASE_URL` still name `mercaria`, because every already-running shared
container lacks the role and would answer every agent
`role "mercaria_test" does not exist`. Moving only CI is worse than moving
neither — it is #481's divergence again, a privilege regression reproducing in
exactly one environment.

## Rebasing a migration behind another branch's

Mechanical, and every part done by hand corrupts the chain silently.

- **`bun run build:shared-types` BEFORE `db:generate`, always.** drizzle-kit
  renders every closed-value-set CHECK from the BUILT `@mercaria/shared-types`,
  so a stale `dist/` emits `DROP CONSTRAINT … ADD CONSTRAINT` pairs that narrow a
  sibling branch's tuple back — in a diff that looks entirely plausible.
- **A stale `dist/` also breaks `tsc`, and NOT only on a migration rebase.**
  Measured rebasing behind #712: `typecheck` went red on
  `services/curation/merge-conflicts.ts` for a `CatalogMergeConflictKind` member
  main had just added, in a file the branch never touched. So ANY rebase behind a
  shared-types change needs `build:shared-types` before the typecheck is worth
  reading — the failure names somebody else's module, which makes "main is
  broken" the first guess and the wrong one.
- **Never hand-rename a migration, hand-edit `meta/_journal.json` or hand-write a
  snapshot.** Delete your `.sql` AND your `meta/<idx>_snapshot.json`, restore
  `_journal.json` to main's version, rebuild shared-types, then re-run
  `db:generate`.
- **Regeneration DROPS every hand-written statement** — triggers, functions,
  backfill `UPDATE`s. Re-apply them, then READ the regenerated file for
  statements you did not intend, and grep for exactly one `-- oxy:deploy-phase=`.
- **A rebase can stage the deletion of an UPSTREAM snapshot.** Before pushing,
  assert the journal's idx set equals the set of `meta/*_snapshot.json` files.
- **A two-phase branch repeats the two-pass generation** (additive state →
  generate `pre`; clean-cut state → generate `post`). Never split one generated
  file by hand.
- **`SCHEMA_TABLE_COUNT` in `db/__tests__/schema-conventions.test.ts` conflicts
  on every such rebase and NEITHER side is right** — count it empirically from
  the barrel's `PgTable` exports.
