/**
 * The bounded retry on a catalog backfill run (#367 W16 line 759), against a
 * REAL Postgres server.
 *
 * ## What was wrong, stated as the measurement that found it
 *
 * `RESUMABLE = ['pending', 'paused']` — `failed` is EXCLUDED from the claim
 * predicate, so a failed run cannot be re-claimed. And `runCatalogBackfillPage`
 * released `failed` on the FIRST page-level error. So one dropped connection
 * mid-pass terminated a run that still held a perfectly good cursor, and it
 * waited for a person. There is no `MAX_ATTEMPTS` anywhere in the domain: these
 * queues did not retry forever, they gave up instantly.
 *
 * The state was never the gap. `failed` is terminal, visible, carries
 * `last_error` and is published in a DTO — a dead-letter in all but the name.
 * What was missing is everything BEFORE it.
 *
 * ## Why a real server
 *
 * `recordBackfillPageFailure` is ONE statement whose `set` carries a `case` over
 * the column's own pre-increment value, guarded by an owner check. A mocked
 * update accepts any statement; only a server evaluates the `case`, applies the
 * `least(...)`, enforces `catalog_backfill_runs_consecutive_failures_check` and
 * decides the owner predicate. Every property below is one of those.
 *
 * ## Scoping
 *
 * Every assertion is against runs this file inserted, by id. The file writes no
 * canonical rows and runs no pages — it drives the repository directly, because
 * the property under test is the failure bookkeeping and not what a stage does.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { catalogBackfillRuns } from '../../../db/schema/backfill.js';
import {
  advanceBackfillRun,
  claimBackfillRun,
  recordBackfillPageFailure,
  releaseBackfillRun,
  EMPTY_COUNTERS,
} from '../../../db/backfill/backfillRunRepository.js';

let db: Database;

const RUN = uuidv7().slice(-12).replace(/\W/gu, '');
const OWNER = `retry-owner-${RUN}`;
const OPERATOR = `retry-operator-${RUN}`;
const created: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  if (created.length > 0) {
    await db.delete(catalogBackfillRuns).where(inArray(catalogBackfillRuns.id, created));
  }
  await closePostgres();
});

/** One open, claimable run of this file's own. */
async function openRun(): Promise<string> {
  const [row] = await db
    .insert(catalogBackfillRuns)
    .values({
      stage: 'provisional_products',
      mode: 'dry_run',
      mappingVersion: 1,
      cohortKind: 'all',
      cohortValue: null,
      status: 'pending',
      cursor: `cursor-${RUN}`,
      requestedByOxyUserId: OPERATOR,
    })
    .returning({ id: catalogBackfillRuns.id });
  created.push(row.id);
  return row.id;
}

async function readRun(id: string) {
  const [row] = await db
    .select({
      status: catalogBackfillRuns.status,
      consecutiveFailures: catalogBackfillRuns.consecutiveFailures,
      cursor: catalogBackfillRuns.cursor,
      leaseOwner: catalogBackfillRuns.leaseOwner,
      lastError: catalogBackfillRuns.lastError,
    })
    .from(catalogBackfillRuns)
    .where(eq(catalogBackfillRuns.id, id));
  return row;
}

/** Claim, then fail, once. Returns what the failure settled on. */
async function failOnce(id: string, maxAttempts: number, error = 'connection reset') {
  const claimed = await claimBackfillRun({ runId: id, leaseOwner: OWNER });
  expect(claimed, 'the run was not claimable').toBeDefined();
  return recordBackfillPageFailure({ runId: id, leaseOwner: OWNER, maxAttempts, error });
}

describe('a page failure is counted before it is terminal', () => {
  it('releases to paused below the ceiling, so the dispatcher re-reads the SAME page', async () => {
    // `paused` rather than `pending`, and the database is what settled that:
    // `catalog_backfill_runs_started_shape_check` is the biconditional
    // `(status = 'pending') = (started_at is null)`, so a claimed run cannot go
    // back to `pending` at all. This case fails with a 23514 against the first
    // implementation, which is the whole reason it runs on a real server.
    const id = await openRun();

    expect(await failOnce(id, 8)).toBe('paused');

    const row = await readRun(id);
    expect(row.status).toBe('paused');
    expect(row.consecutiveFailures).toBe(1);
    expect(row.leaseOwner).toBeNull();
    // The whole point of retrying rather than restarting: the cursor is where
    // the failed page STARTED, so the retry is exact rather than a re-run.
    expect(row.cursor).toBe(`cursor-${RUN}`);
    expect(row.lastError).toBe('connection reset');

    // And `paused` is claimable, which is what makes "the dispatcher picks it
    // up" a fact rather than an intention.
    const reclaimed = await claimBackfillRun({ runId: id, leaseOwner: `${OWNER}-2` });
    expect(reclaimed).toBeDefined();
  });

  it('releases to failed AT the ceiling, and failed is not claimable', async () => {
    const id = await openRun();

    // A ceiling of 2 so the case is two statements rather than eight.
    expect(await failOnce(id, 2)).toBe('paused');
    expect(await failOnce(id, 2)).toBe('failed');

    const row = await readRun(id);
    expect(row.status).toBe('failed');
    expect(row.consecutiveFailures).toBe(2);
    // Terminal: this is the dead-letter the domain always had.
    expect(await claimBackfillRun({ runId: id, leaseOwner: `${OWNER}-3` })).toBeUndefined();
  });

  it('never stores a count above a ceiling somebody LOWERED', async () => {
    // The case `least(...)` is actually for, and it is not a race: the claim
    // predicate already makes one impossible, because `failed` is unclaimable
    // and no lease means no increment. `maxAttempts` is an env var, so the
    // reachable way to exceed the ceiling is for the ceiling to move.
    //
    // Three failures under a ceiling of 8, then the ceiling drops to 2.
    const id = await openRun();
    expect(await failOnce(id, 8)).toBe('paused');
    expect(await failOnce(id, 8)).toBe('paused');
    expect((await readRun(id)).consecutiveFailures).toBe(2);

    expect(await failOnce(id, 2)).toBe('failed');
    // 2 + 1 = 3 without the clamp, which would read as three-eighths of a
    // two-attempt budget.
    expect((await readRun(id)).consecutiveFailures).toBe(2);
  });
});

describe('a page that advances resets the budget', () => {
  it('sets consecutive failures back to zero', async () => {
    // The property that makes the count CONSECUTIVE. A long pass that hits one
    // transient error every few hundred pages must not accumulate its way to
    // terminal.
    const id = await openRun();
    expect(await failOnce(id, 8)).toBe('paused');
    expect((await readRun(id)).consecutiveFailures).toBe(1);

    const claimed = await claimBackfillRun({ runId: id, leaseOwner: OWNER });
    expect(claimed).toBeDefined();
    const advanced = await advanceBackfillRun({
      runId: id,
      leaseOwner: OWNER,
      cursor: `cursor-${RUN}-next`,
      counters: EMPTY_COUNTERS,
    });
    expect(advanced).toBe(true);

    expect((await readRun(id)).consecutiveFailures).toBe(0);
  });
});

describe('the owner check', () => {
  it('records nothing when the lease was reclaimed mid-page', async () => {
    // A task whose lease went to somebody else must not write its verdict over
    // the new owner's — the same rule `advanceBackfillRun` applies to counters.
    const id = await openRun();
    const claimed = await claimBackfillRun({ runId: id, leaseOwner: OWNER });
    expect(claimed).toBeDefined();

    const settled = await recordBackfillPageFailure({
      runId: id,
      leaseOwner: `${OWNER}-someone-else`,
      maxAttempts: 8,
      error: 'should not land',
    });

    expect(settled).toBeUndefined();
    const row = await readRun(id);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.leaseOwner).toBe(OWNER);
    expect(row.lastError).toBeNull();
  });
});

describe('operator cancellation is NOT a retry', () => {
  it('stays terminal on the first and only attempt', async () => {
    // The reason the retry happens BEFORE `failed` rather than by widening the
    // claim predicate to include it. `cancelCatalogBackfillRun` releases to
    // `failed` with the operator's reason; if `failed` were claimable the
    // dispatcher would restart a run somebody had just stopped, within fifteen
    // seconds and silently. This drives the release path cancellation uses.
    const id = await openRun();
    const claimed = await claimBackfillRun({ runId: id, leaseOwner: OWNER });
    expect(claimed).toBeDefined();

    const released = await releaseBackfillRun({
      runId: id,
      leaseOwner: OWNER,
      outcome: 'failed',
      error: `cancelled by ${OPERATOR}: no longer needed`,
    });
    expect(released).toBe(true);

    const row = await readRun(id);
    expect(row.status).toBe('failed');
    // Cancellation does not spend the retry budget, because it does not go
    // through the counter at all.
    expect(row.consecutiveFailures).toBe(0);
    expect(await claimBackfillRun({ runId: id, leaseOwner: `${OWNER}-4` })).toBeUndefined();
  });
});
