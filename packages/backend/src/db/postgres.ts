/**
 * PostgreSQL Connection
 *
 * Drizzle ORM over postgres.js, built through `@oxyhq/db`'s `createDatabase`
 * so the handle is constructed with `DATABASE_CASING` — the one setting that
 * decides what queries REFERENCE, and which `drizzle.config.ts` reads again to
 * decide what the DDL CREATES. Both sides read the same exported constant, so
 * they cannot drift into referencing columns the migrations never created.
 *
 * postgres.js and NOT `drizzle-orm/bun-sql`: the ECS image runs `node`, and the
 * vitest suite runs under node too. `bun-sql` reaches for the `Bun` global and
 * hard-fails the moment anything loads it outside Bun, which would be every
 * production request and every test.
 *
 * Connect once at boot, then read the handle synchronously from anywhere via
 * `getDb()`.
 *
 * ## This is the only store this package opens
 *
 * `src/index.ts` calls `connectPostgres()` and nothing else. There is no second
 * store to fall back to — `src/lib/db.ts`, the Mongoose models and the backfill
 * one-shot were deleted after the cutover — so a failure here is a total outage
 * for this task, which is why `DATABASE_URL` is required at config load and why
 * the connect below proves the server answers before publishing the handle.
 */

import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import { assertPostgresMigrationsCurrent, readJournal } from '@oxyhq/db/migrate';
import type postgres from 'postgres';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import { MIGRATIONS_FOLDER } from './migrationsFolder.js';
import * as schema from './schema/index.js';

/** Seconds `closePostgres` waits for in-flight queries before forcing the socket shut. */
const CLOSE_TIMEOUT_SECONDS = 5;

/** The migration journal this image ships. See `assertMigrationsCurrent`. */
const JOURNAL = readJournal(MIGRATIONS_FOLDER);

export type Database = OxyDatabase<typeof schema>;

/**
 * An open transaction on that pool — the handle `db.transaction(async (tx) => …)`
 * passes its callback.
 *
 * DERIVED from `Database` rather than written out, so it cannot drift from the
 * schema or from drizzle's generics when either changes.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Either handle. A write that must be able to JOIN a caller's transaction takes
 * this: a `Transaction` is not assignable to `Database` (it has no `$client`),
 * so a helper typed only as `Database` silently forces its caller to run OUTSIDE
 * the transaction — which is how a guarded write loses atomicity with the work
 * it is supposed to be atomic WITH.
 *
 * Mercaria has real transactional paths waiting on this. `report-intake.service`
 * commits an `AbuseReport` and its `ModerationOutbox` row together or not at
 * all; checkout reserves inventory and creates its orders together;
 * `draft-order.complete` converts a draft to a paid order idempotently. Each is
 * a case where "the helper quietly ran outside the transaction" is a real
 * corruption, not a style problem.
 */
export type DatabaseOrTransaction = Database | Transaction;

let db: Database | null = null;
let client: postgres.Sql | null = null;

/**
 * Open the connection pool. Call once during startup, before serving traffic.
 *
 * Idempotent: a second call returns the existing handle rather than opening a
 * second pool.
 *
 * There is no "is it configured?" branch here any more: `config.postgres.url`
 * is required at config LOAD, so an unconfigured task never gets far enough to
 * call this. That check moved rather than disappeared — see
 * `resolveDatabaseUrl` in `config/index.ts` for why failing there is the right
 * place.
 */
export async function connectPostgres(): Promise<Database> {
  if (db) return db;

  const maxPoolSize = config.postgres.maxPoolSize;
  const instance = createDatabase({
    databaseUrl: config.postgres.url,
    schema,
    client: {
      max: maxPoolSize,
      idle_timeout: config.postgres.idleTimeoutSeconds,
      connect_timeout: config.postgres.connectTimeoutSeconds,
      max_lifetime: config.postgres.maxLifetimeSeconds,
      onnotice: (notice) => log.general.debug({ notice: notice.message }, 'Postgres notice'),
    },
  });

  // postgres.js connects lazily, so constructing the pool proves nothing. Issue
  // a real round trip here so an unreachable or misconfigured database fails
  // during startup instead of on the first user request — and only publish the
  // handle once that round trip has succeeded.
  try {
    await instance.client`select 1`;
  } catch (error) {
    await instance.client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
    throw error;
  }

  client = instance.client;
  db = instance.db;

  log.general.info({ maxPoolSize }, 'Connected to PostgreSQL successfully');
  return db;
}

/**
 * The connection opened by `connectPostgres()`. Everything that serves a
 * request goes through here.
 *
 * The raw postgres.js handle underneath is reachable as `getDb().$client`, and
 * it has exactly two legitimate uses — both one-shot, never request-path code:
 * `COPY` for the Fase 4 backfill (a protocol-level operation drizzle does not
 * wrap) and the `ANALYZE` after it. Reaching for it to run ordinary SQL
 * bypasses the schema types AND the casing configuration that keep queries and
 * migrations agreeing on column names.
 *
 * @throws {Error} If called before `connectPostgres()` resolved — a programming
 *   error (a query issued before startup finished), not a runtime condition to
 *   recover from.
 */
export function getDb(): Database {
  if (!db) {
    throw new Error(
      'PostgreSQL is not connected. Call connectPostgres() during startup ' +
        'before issuing queries.',
    );
  }
  return db;
}

/**
 * Whether the database answers a trivial query right now — the Postgres half of
 * `/health`, once there is one.
 *
 * A real round trip, deliberately, and not a `db !== null` flag: a pool can
 * exist while the server behind it is unreachable, so the cheap synchronous
 * answer is the one that reports healthy during an outage.
 *
 * Never throws: an unreachable database is a health-check RESULT, not an error
 * for the caller to handle.
 */
export async function checkPostgresHealth(): Promise<boolean> {
  const instanceClient = client;
  if (!instanceClient) return false;
  try {
    await instanceClient`select 1`;
    return true;
  } catch (error) {
    log.general.error({ err: error }, 'Postgres health check failed');
    return false;
  }
}

/**
 * Whether this task's migrations have all been applied — the second half of
 * `/health/ready`.
 *
 * Lives HERE rather than in the route so the raw postgres.js handle stays inside
 * this module: `assertPostgresMigrationsCurrent` needs a `postgres.Sql`, and
 * handing `$client` out to a route would reopen the escape hatch this module's
 * docblock exists to keep closed.
 *
 * The journal is read ONCE at module load, not per probe. It is a set of files
 * shipped inside the image and cannot change while the task runs, so re-reading
 * it every few seconds would only add a way for readiness to fail on an
 * unrelated filesystem hiccup.
 *
 * @throws {Error} `MigrationsNotCurrentError` when the database is behind this
 *   image, or a driver error when the ledger cannot be read at all. Both mean
 *   "do not send this task traffic"; the caller distinguishes them by having
 *   already checked connectivity.
 */
export async function assertMigrationsCurrent(): Promise<void> {
  const instanceClient = client;
  if (!instanceClient) {
    throw new Error(
      'PostgreSQL is not connected. Call connectPostgres() during startup ' +
        'before asserting the migration ledger.',
    );
  }
  await assertPostgresMigrationsCurrent(instanceClient, JOURNAL);
}

/** Close the pool (for shutdown hooks). Safe to call when never connected. */
export async function closePostgres(): Promise<void> {
  const instanceClient = client;
  if (!instanceClient) return;
  client = null;
  db = null;
  await instanceClient.end({ timeout: CLOSE_TIMEOUT_SECONDS });
}
