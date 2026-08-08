/**
 * The loop that runs the expiry sweep — Mercaria's replacement for the Mongo TTL
 * monitor.
 *
 * `expiryTargets.ts` says WHAT expires; `@oxyhq/db`'s `sweepAllExpiredRows` says
 * HOW a target is swept. Neither of them runs on its own, and that gap is the
 * whole reason this file exists: Mongo's reaper was a property of the SERVER, so
 * porting a TTL index leaves nothing behind that a reviewer would notice going
 * missing. The registry without a scheduler is a list nobody reads.
 *
 * ## Started on every task, like the outbox dispatcher beside it
 *
 * There is no leader election and none is wanted. The sweep is a `DELETE … WHERE
 * <column> <= now() - interval`, so two tasks running it concurrently delete the
 * same already-doomed rows and the loser simply deletes nothing — the work is
 * idempotent by construction, and a leader would add a failure mode (nobody
 * sweeps because the leader died) to buy nothing.
 *
 * ## Bounded, and deliberately not caught up in one pass
 *
 * `sweepAllExpiredRows` batches through `ctid` and stops at `maxBatches`,
 * reporting `truncated` when rows remain. That is not a limitation to work
 * around: this is background maintenance sharing a connection pool with request
 * traffic, and a first run after a long backlog would otherwise hold a delete
 * open against `moderation_outboxes` while the dispatcher is trying to claim
 * from it. A truncated sweep just runs again on the next tick.
 *
 * ## The interval is long on purpose
 *
 * Mongo's TTL monitor woke every 60 seconds; none of the three retentions here is
 * shorter than 14 DAYS, so sweeping hourly is already four hundred times finer
 * than the shortest deadline. No read path depends on a swept row being gone —
 * `expiryTargets.ts` documents that per target — so the sweep's lag is a storage
 * question, never a correctness one.
 */

import { getTableName } from 'drizzle-orm';
import { sweepAllExpiredRows, type ExpirySweepResult } from '@oxyhq/db/expiry';
import { getDb } from './postgres.js';
import { EXPIRY_TARGETS } from './expiryTargets.js';
import { log } from '../lib/logger.js';

/** How often the sweep runs. See the header for why an hour is generous. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Rows deleted per statement, and statements per target per tick.
 *
 * 1_000 × 20 caps one target at 20_000 rows per pass — enough that a normal day's
 * expiry clears in one tick, small enough that no single DELETE holds locks on a
 * table the dispatcher is claiming from for long.
 */
const SWEEP_BATCH_SIZE = 1_000;
const SWEEP_MAX_BATCHES = 20;

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * One pass over every target.
 *
 * Exported so a test can run the sweep deterministically instead of waiting an
 * hour for a tick — the loop below is the only other caller.
 */
export async function sweepExpiredRowsOnce(): Promise<ExpirySweepResult[]> {
  return await sweepAllExpiredRows(getDb(), EXPIRY_TARGETS, {
    batchSize: SWEEP_BATCH_SIZE,
    maxBatches: SWEEP_MAX_BATCHES,
  });
}

async function tick(): Promise<void> {
  // A pass that outlives its interval must not have a second one started on top
  // of it: they would contend for the same rows and the same pool.
  if (running) return;
  running = true;
  try {
    const results = await sweepExpiredRowsOnce();
    const deleted = results.reduce((total, result) => total + result.deleted, 0);
    const truncated = results.filter((result) => result.truncated).map((result) => result.table);
    if (deleted > 0 || truncated.length > 0) {
      log.general.info({ deleted, truncated, results }, '[Expiry] sweep complete');
    }
  } catch (error: unknown) {
    // The loop must survive anything one pass throws, or a single bad target
    // stops expiry for the life of the process — and the symptom of that is a
    // table growing forever, which nothing else would report.
    log.general.error({ err: error }, '[Expiry] sweep failed');
  } finally {
    running = false;
  }
}

/**
 * Begin sweeping. Idempotent — a second call is a no-op.
 *
 * Call after `connectPostgres()`: the first pass runs on the first tick, not at
 * start, so a task boots and serves traffic without waiting on maintenance.
 */
export function startExpirySweeper(): void {
  if (timer !== undefined) return;

  timer = setInterval(() => {
    void tick();
  }, SWEEP_INTERVAL_MS);
  // Never hold the event loop open for a housekeeping timer — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info(
    {
      intervalMs: SWEEP_INTERVAL_MS,
      // The table NAMES, not the count: a registry that silently lost an entry
      // still logs a plausible number, and this line is the only place a running
      // task says which tables it believes it is reaping.
      targets: EXPIRY_TARGETS.map((target) => getTableName(target.table)),
    },
    '[Expiry] sweeper started',
  );
}

/** Stop sweeping. A pass already in flight is allowed to finish. */
export function stopExpirySweeper(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
