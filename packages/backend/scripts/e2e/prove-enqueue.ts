/**
 * #69 acceptance 4, the PER-REQUEST half: a sync is ENQUEUED, not run inline.
 *
 * The scheduled-sweep half is settled elsewhere (both connector schedulers appear
 * as `bull:marketplace-sync:repeat:*` keys with Redis and not without it). This
 * is the other half, and it needs its own experiment because the two are
 * produced by different code: `scheduler.ts` registers repeatables at boot,
 * while `requestBackfill` → `enqueueConnectionBackfill` decides per call.
 *
 * ## Why the obvious observable proves nothing
 *
 * `enqueueConnectionBackfill` adds a BullMQ job when `getSyncQueue()` is
 * non-null and otherwise AWAITS `handleConnectionBackfill` inline
 * (`queue/producers.ts`). Both paths return `void` and the HTTP layer answers
 * the same `202 {status:'enqueued'}`, so the response is a label rather than
 * evidence.
 *
 * ## The two observables, and why neither alone is enough
 *
 * 1. **A job appears in Redis**, counted out of `bull:marketplace-sync:*`
 *    against a before-floor. Alone this does not prove the WORKER rather than
 *    the request executed it.
 * 2. **The call returned before the work finished.** An inline path cannot: it
 *    awaits the whole catalogue. So `requestBackfill` returning while NO
 *    terminal `sync_runs` row exists is something the inline branch cannot
 *    produce. Alone this is weak on a tiny catalogue, where a backfill can
 *    finish inside a queue round trip — which is why the site under test holds
 *    124 products and the backfill measurably takes seconds.
 *
 * The NEGATIVE CONTROL is the same call with Redis absent: the job never
 * appears, the call blocks for the whole backfill, and a COMPLETED run exists
 * the moment it returns. Run it with `E2E_PROVE_ENQUEUE_MODE=inline`.
 *
 * Run:
 *   set -a; . packages/backend/.env.e2e; set +a
 *   bun run --cwd packages/backend scripts/e2e/prove-enqueue.ts            # queued
 *   REDIS_URL= bun run --cwd packages/backend scripts/e2e/prove-enqueue.ts # control
 */

import { Redis } from 'ioredis';
import { and, desc, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../src/db/postgres.js';
import { syncRuns } from '../../src/db/schema/connectors.js';
import { findConnectionByProvider } from '../../src/db/connectors/connectionRepository.js';
import { requestBackfill } from '../../src/services/connector-sync.service.js';
import { readDriverConfig } from './config.js';
import { readQueueDepth, type QueueDepth } from './queue-evidence.js';
import { findStoreByHandle } from '../../src/db/stores/storeRepository.js';
import { E2E_STORE_HANDLE } from './setup.js';

async function main(): Promise<void> {
  const config = readDriverConfig();
  await connectPostgres();

  const store = await findStoreByHandle(E2E_STORE_HANDLE);
  if (!store) throw new Error(`No store '${E2E_STORE_HANDLE}'. Run run-woocommerce-worker.ts first.`);
  const connection = await findConnectionByProvider(store.id, 'woocommerce');
  if (!connection) throw new Error('No WooCommerce connection. Run run-woocommerce-worker.ts first.');

  const redisConfigured = Boolean(config.redisUrl);
  let redis: Redis | null = null;
  if (redisConfigured) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    await redis.connect();
  }

  const depthBefore: QueueDepth | null = redis ? await readQueueDepth(redis) : null;
  const runsBefore = await latestRunAt(connection.id);

  const started = Date.now();
  await requestBackfill(store.id, connection.id);
  const returnedAfterMs = Date.now() - started;

  const depthAfter: QueueDepth | null = redis ? await readQueueDepth(redis) : null;
  const runAtReturn = await latestTerminalRun(connection.id, runsBefore);

  const jobsAdded =
    depthBefore && depthAfter ? depthAfter.total - depthBefore.total : null;

  // The discriminator. An inline path AWAITS the backfill, so by the time the
  // call returns a terminal run for it MUST exist; a queued one returns with the
  // worker still to pick the job up, so it must NOT.
  const terminalRunExistedAtReturn = runAtReturn !== null;

  const verdict =
    !redisConfigured
      ? terminalRunExistedAtReturn
        ? 'INLINE (control): no Redis, the call blocked and a terminal run already existed on return'
        : 'INLINE-UNPROVEN: no Redis but no terminal run on return — investigate'
      : jobsAdded !== null && jobsAdded > 0 && !terminalRunExistedAtReturn
        ? 'QUEUED: a job appeared in Redis AND the call returned before any terminal run existed'
        : jobsAdded !== null && jobsAdded > 0
          ? 'AMBIGUOUS: a job appeared, but a terminal run also existed on return'
          : 'NOT PROVEN: no job appeared in the sync queue';

  process.stdout.write(
    `${JSON.stringify(
      {
        redisConfigured,
        depthBefore,
        depthAfter,
        jobsAdded,
        requestBackfillReturnedAfterMs: returnedAfterMs,
        terminalRunExistedAtReturn,
        verdict,
      },
      null,
      2,
    )}\n`,
  );

  // Close BOTH pools explicitly. `process.exitCode` does not force an exit, and
  // an open postgres.js pool plus an ioredis socket keep the process alive
  // indefinitely — which reads as a hung experiment rather than a finished one.
  await redis?.quit();
  await closePostgres();
  process.exitCode = verdict.startsWith('QUEUED') || verdict.startsWith('INLINE (control)') ? 0 : 1;
}

/** The newest run's start instant, or 0 — the floor a later read is compared against. */
async function latestRunAt(connectionId: string): Promise<number> {
  const [row] = await getDb()
    .select({ startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .where(eq(syncRuns.connectionId, connectionId))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return row?.startedAt ? row.startedAt.getTime() : 0;
}

/** A run started after `since` that has already reached a terminal status. */
async function latestTerminalRun(connectionId: string, since: number): Promise<string | null> {
  const rows = await getDb()
    .select({ id: syncRuns.id, status: syncRuns.status, startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .where(and(eq(syncRuns.connectionId, connectionId), eq(syncRuns.kind, 'backfill')))
    .orderBy(desc(syncRuns.startedAt))
    .limit(3);
  const fresh = rows.filter(
    (r) => r.startedAt.getTime() > since && (r.status === 'completed' || r.status === 'failed'),
  );
  return fresh[0]?.id ?? null;
}

await main();
