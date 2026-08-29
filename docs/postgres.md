# PostgreSQL

The backend is Postgres-native: `DATABASE_URL` is **required to boot**
(`src/index.ts`). Every route, the moderation outbox and the payment domain run
against it; there is no second store. Database `mercaria` on the shared RDS
instance `oxy-postgres` (`postgres.internal.oxy.so:5432`), owned by role
`mercaria`, with PostGIS installed once by a privileged role (it is not a
trusted extension — see `docs/runbooks/30-postgres-database-provisioning.md`
in `oxy-infra`).

- **Driver/ORM:** drizzle-orm + postgres.js, via `@oxyhq/db` — it owns the
  column builders, the casing authority (`DATABASE_CASING`), the migration
  ledger/deploy-phase enforcement, and the throwaway-database test harness. Do
  not hand-roll something `@oxyhq/db` already provides.
- **Schema:** `packages/backend/src/db/schema/` (drizzle table defs, one file
  per domain). `packages/backend/src/db/schema/CONVENTIONS.md` is the
  canonical, binding ledger for this port — naming, primary keys, the
  `DualMoney` four-column expansion, closed value sets (`text` + CHECK, never a
  pg `enum`), timestamps, foreign keys/`ON DELETE` decisions, the `jsonb`
  register (which columns earned it and why), generated columns, and the full
  Mongoose-model → Postgres-table map. Read it before touching the schema.
- **Migrations:** `bun run db:generate` (drizzle-kit) writes the SQL;
  `packages/backend/src/db/migrate.ts` (invoked as `bun run db:migrate --
  --target-database=<name> --phase=pre|post|all`, and in production as the
  compiled `dist/db/migrate.js` run as a one-shot ECS task) is the **only**
  thing that applies it — never `drizzle-kit migrate` (devDependency only,
  cannot reach the production image). Every generated `.sql` file needs exactly
  one `-- oxy:deploy-phase=pre` (additive) or `-- oxy:deploy-phase=post`
  (drops/renames/narrows) marker; there is no default. `deploy-aws.yml`'s
  `workflow_dispatch` input `migration_phase=all` applies the whole chain in
  one run before the rollout — for a from-zero/cutover batch only, never a
  normal release.
- **Tests:** `docker-compose.postgres.yml` runs a local `postgis/postgis:17-3.5`
  on port 5435 for `bun run --cwd packages/backend test`; CI/deploy pin the
  same image via a service container. Each suite run gets its own throwaway,
  fully-migrated database (name pattern `oxydb_test_<16 hex>`, from
  `@oxyhq/db/testing`), created and dropped by
  `packages/backend/src/db/testDatabase.ts`, which shells out to the real
  `migrate.ts` entrypoint rather than composing `runMigrations` a second time.
- **A test that widens a global bound widens it for every parallel file.**
  `reconciliation.realdb.test.ts` sets
  `PAYMENT_RECONCILIATION_OPEN_PAYMENT_MIN_AGE_MS='0'` so a payable it just
  booked is sweepable; that buffer is the ONLY thing bounding `auditOpenPayables`,
  an aggregate over the whole of `ledger_entries`, so one
  `auditLedgerPage({cursor:null})` reports `merchant_payable_unexplained` for
  every unexplained open payable in the database — and `recordDiscrepancy`'s
  upsert REOPENS the row `repairs.realdb.test.ts` had resolved, failing in the
  victim as `expected 'open' to be 'resolved'` while naming nothing about the
  cause. **The zeroed config value IS the missing scope, so no census over query
  text sees anything wrong.** Aim with a cursor floor computed as
  `max(id) where id < <fixture id>` — never a pre-taken `max(id)`, since
  `@oxyhq/db`'s uuid v7 is not monotonic within a millisecond — else hold
  `reconciliation-sweep-slot.ts` file-wide. Scoping the ASSERTIONS is not enough
  when the call WRITES.
- **A correctly-scoped teardown can still be blocked by a row a SIBLING minted.**
  The matcher's retrieval is a trigram scan over every `canonical_products` row,
  so a sibling's `runMatch` records a `match_decisions` row citing another file's
  fixture, and both citing columns are `ON DELETE restrict` — measured once in
  four full baseline runs. The owner DECLINES exactly the pinned ids
  (`planCanonicalTeardown`) rather than deleting a sibling's row, which would
  convert a loud teardown failure into a silent wrong answer and would
  additionally have to clear `catalog_source_objects.last_match_decision_id` in a
  third domain. **Never `catch` the `23503`** — that also hides a genuine
  children-first mistake. The discriminator for this whole class is not which
  column a teardown is scoped by, but whether a sibling has since referenced the
  rows it owns.
- **Legacy Mongo/Mongoose is GONE** (code removed post-cutover in PR #136; the
  `mercaria-production` database itself DROPPED on 2026-08-08): no `src/models/`,
  no `src/lib/db.ts`, no `mongoose` in `package.json`, no `MONGODB_URI` secret or
  SSM parameter. There is no rollback target and no re-running the backfill — the
  only copy left is a final dump archived offline. Postgres is the sole authority
  for every byte this service owns.

### Rebasing a migration behind another branch's

Two branches that each generate a migration collide on the SAME index, and the
resolution is mechanical — but every part of it that gets done by hand is a way
to corrupt the chain silently. Measured across four branches rebased in one
batch (#94, #105, #58, #77), each of which hit at least one of these:

- **Never hand-rename a migration, hand-edit `meta/_journal.json`, or hand-write
  a snapshot.** Delete your `.sql` AND your `meta/<idx>_snapshot.json`, restore
  `_journal.json` to main's version, then re-run `db:generate` so drizzle emits
  against the post-merge snapshot chain. A renamed file keeps a snapshot that
  diffs against the wrong parent, and the damage appears in whoever generates
  next, not in you.
- **Regeneration DROPS every hand-written statement** — trigger and function
  bodies, backfill `UPDATE`s, anything drizzle-kit cannot model. Re-apply them
  and verify by grepping the regenerated file for each trigger/function pair and
  for exactly one `-- oxy:deploy-phase=` line. Three of the four branches lost
  their triggers here; all three would have applied cleanly and enforced nothing.
- **A rebase can stage the deletion of an UPSTREAM snapshot** (`git status`
  showing `D meta/00NN_snapshot.json` for a file that is not yours), which
  breaks the NEXT `db:generate` rather than anything in your own PR. Before
  pushing, assert the journal's idx set equals the set of `meta/*_snapshot.json`
  files — a green suite does not catch this, because the migrator reads the
  `.sql` files and never looks at a snapshot.
- **A two-phase branch repeats the two-pass generation**: apply the additive
  schema state, generate (`pre`), apply the clean-cut state, generate (`post`).
  Never split one generated file in half by hand.
- **`SCHEMA_TABLE_COUNT` in `db/__tests__/schema-conventions.test.ts` conflicts
  on every such rebase and NEITHER side is right** — it is main's count plus
  your net delta. Count it empirically from the barrel's `PgTable` exports;
  arithmetic over the PR descriptions misses tables that MOVED between files.
