/**
 * Apply the SQL migrations in `packages/backend/drizzle/` to `DATABASE_URL`.
 *
 * This is the ONE migration mechanism for the Postgres side of this package.
 * `bun run db:migrate` runs it, the vitest Postgres harness
 * (`src/db/testDatabase.ts`) shells out to this same script so the harness
 * exercises the entrypoint an operator actually runs, and production will run
 * its COMPILED form (`dist/db/migrate.js`) as a one-shot ECS task. Nothing
 * applies a migration by any other route.
 *
 * ## Why not `drizzle-kit migrate`
 *
 * drizzle-kit is a CLI that cannot reach production: it is a devDependency and
 * the shipped image installs production dependencies only (see the root
 * `Dockerfile`). `drizzle-orm` — a runtime dependency — ships the migrator
 * itself, so the migrator compiles into the SAME image the service runs and
 * adds no dependency at all.
 *
 * Both tools share ONE ledger: `drizzle-kit migrate` and drizzle's own
 * `migrate()` read the same `meta/_journal.json` and write the same
 * `drizzle.__drizzle_migrations` rows, so a database migrated by either is
 * understood by the other. drizzle-kit stays a devDependency for
 * `db:generate`, which only ever runs on a developer's machine.
 *
 * ## What `runMigrations` enforces on every run
 *
 * The ordering below is `@oxyhq/db`'s, not this file's — each step was added
 * after a real incident in an Oxy service that composed them by hand and got
 * the order wrong. In summary, and in this order: read the journal and every
 * migration's deploy-phase marker from disk (no connection yet); open one
 * connection and assert it reaches the expected database as its FIRST
 * statement; refuse a journal holding an entry the high-water apply rule can
 * never reach; decide what THIS side of the deploy may apply; ensure the
 * extensions; apply; re-read the ledger and confirm.
 *
 * ## `--target-database=<name>` is REQUIRED, on every run including a dry run
 *
 * `expectedDatabase` is optional in `@oxyhq/db` so a consumer can adopt the
 * package without changing every invocation site. Mercaria adopts it from day
 * one, because this is the guard whose absence does not fail loudly: pointed at
 * the wrong database a migrator finds an empty ledger, applies the entire
 * journal, logs `Applied N` and exits 0 — leaving the real database untouched
 * while the operator reads a success line.
 *
 * ## `--phase=pre|post|all`, default `all`
 *
 * Every generated `.sql` file must carry `-- oxy:deploy-phase=pre` or
 * `-- oxy:deploy-phase=post` on its own line. There is no default and an
 * unmarked migration is a hard failure here, before any DDL runs — a default
 * would quietly pick a side for a migration whose author never considered the
 * question.
 *
 *   `pre`  — additive only (new table, new defaulted column, widened CHECK).
 *            Correct against the image still serving AND the one arriving, so
 *            it is applied BEFORE the rollout.
 *   `post` — anything that takes something away (DROP, RENAME, narrowed
 *            constraint). Applied early it is an outage on the image still
 *            serving, so it runs AFTER the new image is live.
 *
 * The default is `all` because the only callers that exist today are a
 * developer's own database and the test harness, neither of which has a
 * previous image to protect. The deploy workflow passes `pre` and `post`
 * explicitly when it lands.
 *
 * ## `DRY_RUN`
 *
 * `DRY_RUN=true` reports what WOULD be applied and writes nothing — not even
 * the ledger table.
 */

import {
  MIGRATION_RUNS,
  readTargetDatabase,
  runMigrations,
  type MigrationRun,
  type RequiredExtension,
} from '@oxyhq/db/migrate';
import { MIGRATIONS_FOLDER } from './migrationsFolder.js';
import { log } from '../lib/logger.js';

/**
 * The extensions Mercaria's schema depends on, ensured before any migration is
 * applied rather than inside a numbered one.
 *
 * A migration that names a `geography` column fails outright on a database
 * where PostGIS is absent, and only on a FRESH one — the shape that passes on a
 * warm developer machine and then fails in CI or on a newly provisioned RDS
 * database. Making it a precondition of the MIGRATOR means the ordering cannot
 * be got wrong by renumbering, squashing or regenerating the sequence.
 *
 * `IF NOT EXISTS` (which `ensureExtensions` uses) short-circuits BEFORE the
 * privilege check, so this is a no-op for the unprivileged application role on
 * an already-prepared database. It is NOT a fallback that installs PostGIS
 * where it is missing: a new target database still needs a privileged role to
 * run `CREATE EXTENSION` once. `mercaria` on the shared `oxy-postgres` instance
 * has already had that done.
 */
const REQUIRED_EXTENSIONS: readonly RequiredExtension[] = [
  {
    name: 'postgis',
    reason:
      'Mercaria stores seller/store/pickup locations and answers "near me" ' +
      'catalogue queries, which need a real geography type with a GiST index ' +
      'rather than a bounding box dressed up as a distance.',
  },
];

/** Whether `DRY_RUN` asks for a report instead of an apply. */
function isDryRun(): boolean {
  const value = (process.env.DRY_RUN ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * Read `--phase=<pre|post|all>` out of an argument list, defaulting to `all`.
 *
 * Parsed here rather than in `@oxyhq/db` because the package takes a `run`
 * OPTION, not a flag — how a caller spells it on its own command line is the
 * caller's business. An unrecognised value throws rather than falling back:
 * silently running `all` for someone who typed `--phase=pre-deploy` is exactly
 * the drop-applied-too-early outage the phases exist to prevent.
 */
function readPhase(argv: readonly string[]): MigrationRun {
  const prefix = '--phase=';
  const flag = argv.find((arg) => arg.startsWith(prefix));
  if (!flag) return 'all';

  const value = flag.slice(prefix.length).trim();
  if (!(MIGRATION_RUNS as readonly string[]).includes(value)) {
    throw new Error(
      `Unrecognised --phase=${JSON.stringify(value)}. Use one of: ${MIGRATION_RUNS.join(', ')}.`,
    );
  }
  return value as MigrationRun;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Before DATABASE_URL, and before anything opens a socket: an operator who
  // forgot the flag should learn it instantly rather than after a connection.
  const expectedDatabase = readTargetDatabase(argv);
  const run = readPhase(argv);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Start a local Postgres with: ' +
        'docker compose -f docker-compose.postgres.yml up -d postgres',
    );
  }

  await runMigrations({
    databaseUrl,
    migrationsFolder: MIGRATIONS_FOLDER,
    extensions: REQUIRED_EXTENSIONS,
    run,
    expectedDatabase,
    dryRun: isDryRun(),
    logger: {
      info: (message) => log.general.info(message),
      debug: (message) => log.general.debug(message),
    },
  });
}

main().catch((error: unknown) => {
  log.general.error({ err: error }, 'Postgres migration failed');
  // Not `process.exit`: pino's pretty transport writes from a worker thread in
  // development, and exiting here would truncate the very message that says
  // what went wrong. The event loop is already free once the pool is closed.
  process.exitCode = 1;
});
