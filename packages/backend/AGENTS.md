# @mercaria/backend

Express API on PostgreSQL (Drizzle). Delta on the root `AGENTS.md`; it loads when you work here.

## Commands

Run from the repo root. Postgres must be up: `docker compose -f docker-compose.postgres.yml up -d` (port 5435).

```bash
bun run --cwd packages/backend test         # vitest, incl. *.realdb.test.ts
bun run --cwd packages/backend typecheck
bun run build:shared-types                  # before db:generate
bun run --cwd packages/backend db:generate  # needs the deploy-phase marker below
```

Testing and migration detail: [`docs/postgres-testing-and-migrations.md`](../../docs/postgres-testing-and-migrations.md).
Schema decisions: [`src/db/schema/CONVENTIONS.md`](src/db/schema/CONVENTIONS.md).

## PostgreSQL

`DATABASE_URL` is **required to boot**. PostgreSQL is the ONLY store: no
`src/models/`, no rollback target.

- **`bun run db:generate` writes migrations; `src/db/migrate.ts` is the ONLY
  thing that applies them** — never `drizzle-kit migrate`. Every generated `.sql`
  needs exactly one `-- oxy:deploy-phase=pre` (additive) or `=post` (drops,
  renames, narrows) marker; no default.
- **`bun run build:shared-types` BEFORE `db:generate`, always.** drizzle-kit renders
  every closed-value-set CHECK from the BUILT `@mercaria/shared-types`, so a stale
  `dist/` silently emits `DROP`/`ADD CONSTRAINT` pairs narrowing a sibling branch's
  tuple back, in a diff that looks plausible.
- **Never hand-rename a migration, hand-edit `meta/_journal.json` or hand-write a
  snapshot**; after any regeneration READ the file for statements you did not
  intend — it DROPS every hand-written trigger, function, backfill and the
  marker; verify its count is 1.
- **Do not convert `*.realdb.test.ts` suites to mocks.** A mocked insert/update
  accepts a statement the server rejects; CHECKs, unique indexes, `requireTransaction`
  and `FOR UPDATE SKIP LOCKED` have no mocked counterpart.
- **The test database is SHARED across parallel files.** Scope aggregates to
  ids your file owns, floor every count equality, never widen a global config bound,
  hold the advisory-lock mutex for the global active matching policy, and keep a
  trigger-toggle window to exactly ONE table.
