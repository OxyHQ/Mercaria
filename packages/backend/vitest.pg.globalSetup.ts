/**
 * One throwaway, fully-migrated PostgreSQL database for the whole suite.
 *
 * ## Wired in, alongside the Mongo replica set
 *
 * `vitest.config.ts` lists BOTH global setups. The Mongo one does not go away
 * until the last Mongo-backed test does; this one arrived with the payment
 * domain, whose write path is Postgres-native and whose central invariant — a
 * ledger transaction balancing to zero per currency, and refusing to be edited
 * afterwards — is enforced by a trigger no mock can stand in for.
 *
 * The cost is real and worth naming: every test file in this package now needs a
 * reachable Postgres server before it can start, whether or not it touches one.
 * `docker compose -f docker-compose.postgres.yml up -d postgres` at the repo
 * root is the local answer; CI runs a `postgis/postgis:17-3.5` service pinned to
 * the same image.
 *
 * ## What it does
 *
 * `TEST_DATABASE_URL` (falling back to `DATABASE_URL`) names a SERVER, never
 * the database the tests use: the harness creates its own throwaway database on
 * that server, migrates it with the real migrator, and drops it afterwards. So
 * a developer can point it at their local `mercaria_dev` and CI at its service
 * container without either one ever being written to.
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

let databaseUrl: string | null = null;

export async function setup(): Promise<void> {
  const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      'The Postgres test harness needs TEST_DATABASE_URL (or DATABASE_URL) — a ' +
        'connection string for a server it may create and drop databases on. It ' +
        'never writes to the database named in that URL. Start one with: ' +
        'docker compose -f docker-compose.postgres.yml up -d postgres',
    );
  }

  databaseUrl = await createMercariaTestDatabase(adminUrl);
  process.env.DATABASE_URL = databaseUrl;
  process.env.PG_MAX_POOL_SIZE = TEST_POOL_SIZE;
}

export async function teardown(): Promise<void> {
  if (!databaseUrl) return;
  const url = databaseUrl;
  databaseUrl = null;
  await dropMercariaTestDatabase(url);
}
