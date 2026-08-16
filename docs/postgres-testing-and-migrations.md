# Postgres: shared-test-database traps and the migration rebase protocol

> Moved out of `AGENTS.md`. The one-line rules stay there; this is the procedure.
> Schema decisions are `packages/backend/src/db/schema/CONVENTIONS.md`.

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
- **`match_policy_versions_active_key` is GLOBAL** (one active policy per
  database). Every realdb file that matches must hold #63's advisory-lock mutex
  (`services/ingestion/__tests__/active-policy-slot.ts`) for its WHOLE run — a
  session-level lock on a RESERVED connection. Do not scope the index, do not
  borrow the active policy, do not `DISABLE TRIGGER` (an ACCESS EXCLUSIVE lock
  builds a convoy), do not retry-loop (each retry is an aborted transaction
  against the pool the holder needs).
- **`FAIL x.test.ts` with `Tests 0 failed` is a load failure**, not a regression.
  Baseline on the base revision under the SAME parallel conditions.
- **Write fixture instants RELATIVE to `now`** — a hardcoded absolute date
  detonates in a sibling file's expiry sweep.

## Rebasing a migration behind another branch's

Mechanical, and every part done by hand corrupts the chain silently.

- **`bun run build:shared-types` BEFORE `db:generate`, always.** drizzle-kit
  renders every closed-value-set CHECK from the BUILT `@mercaria/shared-types`,
  so a stale `dist/` emits `DROP CONSTRAINT … ADD CONSTRAINT` pairs that narrow a
  sibling branch's tuple back — in a diff that looks entirely plausible.
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
