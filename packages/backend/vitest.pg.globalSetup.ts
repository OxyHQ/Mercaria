/**
 * One throwaway, fully-migrated PostgreSQL database for the whole suite.
 *
 * ## What it does
 *
 * `TEST_DATABASE_URL` (falling back to `DATABASE_URL`, then to the local compose
 * server) names a SERVER, never the database the tests use: the harness creates
 * its own throwaway database on that server, migrates it with the real migrator,
 * and drops it afterwards. So a developer can point it at their local
 * `mercaria_dev` and CI at its service container without either one ever being
 * written to.
 *
 * It FAILS rather than skipping when no server answers. A harness that skipped
 * would report a green suite for a migration whose SQL was never executed, which
 * is the one outcome this phase exists to prevent — and the skip would be
 * invisible in CI, where nobody reads a passing log.
 *
 * `PG_MAX_POOL_SIZE` is forced down to 4. vitest runs test files in parallel
 * workers and each one that connects opens its own pool against the same
 * server; at the production default of 20 a handful of workers exhausts
 * Postgres's `max_connections` (100 by default) and the failure arrives as
 * `sorry, too many clients already` from whichever file happened to be last —
 * a failure that reads as a bug in that file and is not.
 */

import postgres from 'postgres';

import { createMercariaTestDatabase, dropMercariaTestDatabase } from './src/db/testDatabase.js';

/** Pool ceiling per vitest worker. See the header for why the default is unsafe here. */
const TEST_POOL_SIZE = '4';

/**
 * The `max_locks_per_transaction` this suite requires of whatever server it is
 * pointed at.
 *
 * Every realdb file that creates its own throwaway database migrates it with
 * the real migrator, which applies the whole chain in ONE transaction and so
 * holds every object lock it takes until commit. PostgreSQL sizes ONE shared
 * lock table from `max_locks_per_transaction * (max_connections +
 * max_prepared_transactions)`, so those migrations contend for a single pool
 * rather than each getting their own budget.
 *
 * Measured on `postgis/postgis:17-3.5` with
 * `scripts/lock-capacity-probe.ts` — N real migrations through the real
 * migrator entrypoint, launched together and raised until `out of shared
 * memory` — on 2026-08-21, at commit 9b18057, with a 133-entry chain costing
 * 5,986 locks per full-chain migration:
 *
 *     64 (the default)  ->   4 concurrent migrations, the 5th fails
 *     256               ->  15 concurrent migrations, the 16th fails
 *
 * At the default the failure does not arrive as a clean refusal — it lands
 * mid-migration on whichever `ALTER TABLE … ADD CONSTRAINT` happened to be
 * executing, in whichever files happened to overlap, so it reads as an
 * unrelated flake that moves between files run to run.
 *
 * ## How many the suite needs is not stated here, deliberately
 *
 * This comment used to say "the suite needs six". It needed twelve, and the
 * only reason nobody noticed is that 256 still carried it (#849). The count is
 * mechanically derivable, so `scripts/validate-lock-capacity.mjs` derives it on
 * every build and fails when the suite outgrows the MEASURED capacity —
 * projected onto the chain as it stands, since a longer chain locks more objects
 * inside one transaction and carries fewer concurrent migrations than it did.
 *
 * The 64 row above is also from the earlier measurement and has not been
 * re-taken; it is kept because nothing sizes off it — the guard refuses any
 * ceiling it holds no measurement row for, and 64 is not one of them.
 *
 * Asserted here rather than trusted, because the setting is `postmaster`
 * context and the two places that raise it use two different mechanisms:
 * `docker-compose.postgres.yml` passes a server argument, and CI has to write
 * postgresql.auto.conf and restart, since a GitHub Actions service block has
 * nowhere to put a command. Two mechanisms for one fact can drift, and the
 * direction that matters is the silent one — lock exhaustion reproducing in
 * only one environment. That drift is now ALSO checked statically: the guard
 * compares this constant against both servers' literals, so a half-applied
 * change fails the build as well as the run.
 */
const REQUIRED_MAX_LOCKS_PER_TRANSACTION = 256;

/**
 * Fail before the first migration when the server cannot support the suite.
 *
 * Checked against the SERVER the harness was handed, so it covers a local
 * compose server, a CI service container and anything `TEST_DATABASE_URL`
 * names, without any of them having to be recognised.
 */
async function assertLockCeiling(adminUrl: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  let setting: string;
  try {
    const [row] = await sql<{ setting: string }[]>`
      select setting from pg_settings where name = 'max_locks_per_transaction'
    `;
    // A server that does not report the setting at all is a server this suite
    // cannot make a claim about, so it is a failure rather than a pass.
    if (!row) throw new Error('pg_settings has no max_locks_per_transaction row');
    setting = row.setting;
  } finally {
    await sql.end({ timeout: 5 });
  }

  const actual = Number.parseInt(setting, 10);
  if (Number.isNaN(actual) || actual < REQUIRED_MAX_LOCKS_PER_TRANSACTION) {
    throw new Error(
      `The Postgres server at ${new URL(adminUrl).host} has ` +
        `max_locks_per_transaction=${setting}, below the ${REQUIRED_MAX_LOCKS_PER_TRANSACTION} ` +
        `this suite requires. Concurrent realdb migrations exhaust the shared lock table at ` +
        `the default 64 and fail with "out of shared memory" in whichever files happen to ` +
        `overlap.\n` +
        `\n` +
        `This is a property of the SERVER, not of the test that reported it — this ` +
        `check runs once for the whole package, so it stops files that never open a ` +
        `connection.\n` +
        `\n` +
        `The setting is postmaster context, so a running server cannot be changed into ` +
        `compliance without a RESTART. That makes the remedy depend on where you are, ` +
        `and one of the two is not safe to paste:\n` +
        `\n` +
        `  From the SHARED CHECKOUT — recreate the compose server so it picks up the\n` +
        `  \`command:\` in docker-compose.postgres.yml:\n` +
        `    docker compose -f docker-compose.postgres.yml up -d --force-recreate postgres\n` +
        `\n` +
        `  From a WORKTREE this will NOT work, and it fails as a Docker problem rather\n` +
        `  than as this one: compose derives its network name from the directory, so a\n` +
        `  new directory wants a new network, and with many worktrees open Docker\n` +
        `  answers "all predefined address pools have been fully subnetted". It fails\n` +
        `  SAFELY — the old container keeps running at the old setting — so the symptom\n` +
        `  is that you run the remedy, see an unrelated error, and the ceiling is\n` +
        `  unchanged.\n` +
        `\n` +
        `  DO NOT reach for \`ALTER SYSTEM\` + \`docker restart\` to get around that. It\n` +
        `  works, and it is how CI does it (.github/workflows/ci.yml, "Raise the\n` +
        `  Postgres lock ceiling") — but CI owns its container for one job, and this\n` +
        `  one is SHARED by every worktree and agent on the machine. Restarting it\n` +
        `  destroys every in-flight run against it: measured, four throwaway databases\n` +
        `  and twenty-four connections went down, and the ~40s of crash recovery that\n` +
        `  followed answered everyone else "the database system is not yet accepting\n` +
        `  connections" — which reads as a bug in their own code.\n` +
        `\n` +
        `  Checking that it looks idle first does NOT make it safe. That check expires\n` +
        `  before you can act on it; a sibling starting a run in the gap is exactly the\n` +
        `  case that gets destroyed. Restarting the shared server is a COORDINATED\n` +
        `  action — do it from the shared checkout, or ask.`,
    );
  }
}

/**
 * The server `docker-compose.postgres.yml` publishes, used when neither variable
 * is set.
 *
 * A default rather than a hard requirement because the compose file is IN this
 * repo and states this exact URL, so requiring the variable would only add a
 * step every developer has to be told about once and works around thereafter.
 * Nothing is written to the `mercaria_dev` database named here — the harness
 * creates its own.
 */
const LOCAL_COMPOSE_URL = 'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

/** Told to the developer whenever the server cannot be reached, whatever named it. */
const START_HINT = 'docker compose -f docker-compose.postgres.yml up -d postgres';

let databaseUrl: string | null = null;

export async function setup(): Promise<void> {
  const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? LOCAL_COMPOSE_URL;

  // Before the first migration, not after: at the default ceiling the failure
  // lands mid-`ALTER TABLE` in whichever files overlap, which reads as a bug in
  // one of them. This turns that into one sentence naming the real cause.
  //
  // A connection failure here is left to the handler below, which is the one
  // that knows how to say "start the server".
  try {
    await assertLockCeiling(adminUrl);
  } catch (error) {
    // A server that is simply not running gets the better "start it with…"
    // message from the create below, so only a REACHABLE server that failed the
    // check itself stops the run here.
    const unreachable = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/.test(String(error));
    if (!unreachable) throw error;
  }

  try {
    databaseUrl = await createMercariaTestDatabase(adminUrl);
  } catch (error) {
    // The bare driver error is `ECONNREFUSED 127.0.0.1:5435`, which reads as a
    // broken test rather than a missing prerequisite. Say which server was tried
    // and how to start it, and keep the original as the cause.
    throw new Error(
      `The Postgres test harness could not create its throwaway database on ` +
        `${new URL(adminUrl).host}. Start the local server with:\n  ${START_HINT}\n` +
        `Or point TEST_DATABASE_URL at a server it may create and drop databases on.`,
      { cause: error },
    );
  }

  process.env.DATABASE_URL = databaseUrl;
  process.env.PG_MAX_POOL_SIZE = TEST_POOL_SIZE;
}

export async function teardown(): Promise<void> {
  if (!databaseUrl) return;
  const url = databaseUrl;
  databaseUrl = null;
  await dropMercariaTestDatabase(url);
}
