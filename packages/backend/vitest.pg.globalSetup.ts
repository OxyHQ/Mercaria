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

import { createMercariaTestDatabase, dropMercariaTestDatabase } from './src/db/testDatabase.js';

/** Pool ceiling per vitest worker. See the header for why the default is unsafe here. */
const TEST_POOL_SIZE = '4';

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
