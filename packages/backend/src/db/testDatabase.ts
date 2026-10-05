/**
 * Throwaway Postgres Database for the Test Suite
 *
 * Creates one uniquely-named, fully-migrated database per suite run on the
 * server `TEST_DATABASE_URL` (or `DATABASE_URL`) points at, and drops it
 * afterwards. `@oxy.so/db/testing` owns the create/drop mechanics — including
 * the name it generates (`oxydb_test_<16 hex>`) and the pattern
 * `dropTestDatabase` refuses to drop outside of, which is what stops a stray
 * connection string from turning teardown into `DROP DATABASE mercaria`.
 *
 * ## Why the migration shells out instead of calling `runMigrations` in-process
 *
 * `@oxy.so/db/testing` takes `migrate` as a callback precisely so a caller can
 * pass `(url) => runMigrations({ … })` directly, and that would be one fewer
 * moving part. It is deliberately NOT what happens here.
 *
 * A second, in-test composition of `runMigrations` is a second set of options —
 * its own migrations folder, its own extension list, its own phase — that can
 * drift from `src/db/migrate.ts` without anything noticing, and the drift is
 * invisible in exactly the direction that matters: the suite would keep passing
 * against a correctly migrated database while the script an operator actually
 * runs was broken. Shelling out to the real entrypoint means the harness
 * exercises the same argument parsing, the same `--target-database` guard, the
 * same extension preamble and the same phase enforcement that dev and
 * production get. The cost is one subprocess per suite run.
 *
 * `bun` rather than `node`: the entrypoint is TypeScript and the suite runs
 * under node, so there is no compiled `dist/db/migrate.js` to reach for. bun is
 * this monorepo's package manager and script runner, so it is present wherever
 * the suite runs.
 *
 * `--phase=all` because a throwaway database has no previous image to protect —
 * the pre/post split exists to sequence a rollout, and there is no rollout here.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@oxy.so/db/migrate';
import { createTestDatabase, dropTestDatabase } from '@oxy.so/db/testing';
import { MIGRATIONS_FOLDER } from './migrationsFolder.js';
import { REQUIRED_EXTENSIONS } from './requiredExtensions.js';

/** This package's root — where `package.json` and `drizzle.config.ts` live. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The migration entrypoint, run exactly as `bun run db:migrate` runs it. */
const MIGRATE_SCRIPT = join(PACKAGE_ROOT, 'src', 'db', 'migrate.ts');

/**
 * Apply the real migrator to a freshly created throwaway database.
 *
 * @throws {Error} When the migrator exits non-zero, carrying its combined
 *   stdout and stderr — a migration that fails inside `createTestDatabase`'s
 *   hook otherwise surfaces as a bare exit code with the actual SQL error lost
 *   to a discarded pipe.
 */
export async function applyMigrations(
  databaseUrl: string,
  phase: 'all' | 'pre' | 'post' = 'all',
): Promise<void> {
  const target = new URL(databaseUrl).pathname.replace(/^\//, '');

  const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    const child = spawn(
      'bun',
      ['run', MIGRATE_SCRIPT, `--target-database=${target}`, `--phase=${phase}`],
      {
        cwd: PACKAGE_ROOT,
        // The migrator reads DATABASE_URL from the environment; the throwaway
        // database's own URL is the only one it may see here.
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let text = '';
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, text }));
  });

  if (output.code !== 0) {
    throw new Error(
      `Migrating the test database ${target} failed (exit ${String(output.code)}):\n${output.text}`,
    );
  }
}

/**
 * Create a fully-migrated throwaway database and return its connection string.
 *
 * @param adminUrl A Postgres connection string on a server this may create and
 *   drop databases on. No default — see `@oxy.so/db/testing`, which refuses
 *   rather than inventing a server to connect to.
 */
export async function createMercariaTestDatabase(adminUrl: string): Promise<string> {
  return createTestDatabase({ adminUrl, migrate: (databaseUrl) => applyMigrations(databaseUrl) });
}

/**
 * A throwaway database migrated only THROUGH one migration, for a test that
 * must put rows into the schema as it stood BEFORE a later migration and then
 * watch that migration act on them — the legacy rows a `post` migration exists
 * to handle. The rest of the chain is then applied with
 * {@link applyMigrations}, through the real entrypoint, in the phase a deploy
 * would use.
 *
 * The stop is a folder holding the journal's prefix, byte-for-byte, because
 * drizzle's migrator has no other way to be handed a subset — the device
 * `@oxy.so/db` itself uses for a `pre` run. It cannot shell out like
 * {@link applyMigrations}: `migrate.ts` resolves its folder from its own path.
 * The extensions are the SAME list (`requiredExtensions.ts`), which is the
 * drift the module docblock warns about, closed.
 */
export async function createMercariaTestDatabaseThrough(adminUrl: string, lastTag: string): Promise<string> {
  return createTestDatabase({
    adminUrl,
    migrate: async (databaseUrl) => {
      const folder = journalPrefix(lastTag);
      try {
        await runMigrations({
          databaseUrl,
          migrationsFolder: folder,
          extensions: REQUIRED_EXTENSIONS,
          run: 'all',
          expectedDatabase: new URL(databaseUrl).pathname.replace(/^\//, ''),
          dryRun: false,
          logger: { info: () => undefined, debug: () => undefined },
        });
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  });
}

/** A temporary migrations folder ending at `lastTag`. The caller removes it. */
function journalPrefix(lastTag: string): string {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const end = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (end < 0) throw new Error(`No migration ${lastTag} in the journal`);
  const retained = journal.entries.slice(0, end + 1);

  const folder = mkdtempSync(join(tmpdir(), 'mercaria-migrate-through-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: retained }));
  for (const entry of retained) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

/**
 * Drop a database created by {@link createMercariaTestDatabase}.
 *
 * A thin pass-through so the harness has one import for both halves; the guard
 * that makes this safe (the name pattern, checked BEFORE any connection is
 * opened, plus `WITH (FORCE)` so a leaked handle cannot hang teardown) lives in
 * `@oxy.so/db/testing` and is deliberately not reimplemented here.
 */
export async function dropMercariaTestDatabase(databaseUrl: string): Promise<void> {
  await dropTestDatabase(databaseUrl);
}
