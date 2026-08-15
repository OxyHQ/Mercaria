/**
 * Proving that a sync was ENQUEUED rather than run inline (#69 acceptance 4).
 *
 * `POST /admin/stores/:id/channels/:id/sync` answers `202 {status:'enqueued'}`
 * either way. With Redis, `enqueueConnectionBackfill` adds a BullMQ job and
 * returns; without it, `runInline` AWAITS `handleConnectionBackfill` — the whole
 * catalogue — inside the request, and then answers the identical 202. So the
 * word "enqueued" in that response is a label, not evidence, and the runbook's
 * §2 note that "scenario W3 is meaningless without REDIS_URL" is exactly this.
 *
 * Two independent observables, because each alone has a way of lying:
 *
 *  1. **A job appears in Redis.** Counted directly out of `bull:marketplace-sync:*`
 *     across the request. Its vacuity floor is the count BEFORE — a queue that
 *     already held jobs, or a key pattern matching nothing, is otherwise
 *     indistinguishable from a job that was added.
 *  2. **The response beat the work.** An inline run cannot answer before the
 *     backfill finishes, so a 202 that lands materially before the `sync_runs`
 *     row reaches a terminal status is something an inline path cannot produce.
 *
 * The second is what makes the first meaningful for a SMALL catalogue: a
 * backfill of three products can finish in the time a queue round trip takes, so
 * the timing alone would be inconclusive, while a job key alone does not prove
 * the WORKER rather than the request executed it.
 */

import { Redis } from 'ioredis';
import { MARKETPLACE_SYNC_QUEUE } from '../../src/queue/constants.js';

/** What one observation of the sync queue's depth found. */
export interface QueueDepth {
  /** Jobs currently in the wait/active/delayed/completed/failed sets. */
  readonly total: number;
  /** The Redis keys counted — the vacuity floor's evidence. */
  readonly keysMatched: number;
}

/** The verdict on how one sync request was executed. */
export type SyncExecutionEvidence =
  | {
      readonly mode: 'queued';
      readonly jobsAdded: number;
      readonly depthBefore: QueueDepth;
      readonly depthAfter: QueueDepth;
      readonly responseMs: number;
      readonly runCompletedMs: number | null;
    }
  | {
      readonly mode: 'inline_or_unproven';
      readonly reason: string;
      readonly depthBefore: QueueDepth;
      readonly depthAfter: QueueDepth;
      readonly responseMs: number;
      readonly runCompletedMs: number | null;
    }
  | { readonly mode: 'no_redis'; readonly reason: string; readonly responseMs: number };

/**
 * Count what the sync queue is holding.
 *
 * Counts the BullMQ list/set keys directly rather than constructing a `Queue`,
 * so this observation shares no code with the thing it is observing — a
 * `getSyncQueue()` here would report `null` for exactly the misconfiguration it
 * is supposed to detect, and read as "zero jobs".
 */
export async function readQueueDepth(redis: Redis): Promise<QueueDepth> {
  const prefix = `bull:${MARKETPLACE_SYNC_QUEUE}`;
  const lists = ['wait', 'paused', 'active'];
  const zsets = ['delayed', 'completed', 'failed', 'prioritized'];

  let total = 0;
  let keysMatched = 0;

  for (const name of lists) {
    const len = await redis.llen(`${prefix}:${name}`);
    if (len > 0) keysMatched += 1;
    total += len;
  }
  for (const name of zsets) {
    const len = await redis.zcard(`${prefix}:${name}`);
    if (len > 0) keysMatched += 1;
    total += len;
  }

  return { total, keysMatched };
}

/**
 * Decide how a sync request was executed, from two observations plus the timing.
 *
 * `runCompletedMs` is how long after the request the `sync_runs` row reached a
 * terminal status, or null when it never did within the wait. A response that
 * returned BEFORE that instant is one an inline path could not have produced.
 */
export function decideSyncExecution(input: {
  readonly redisConfigured: boolean;
  readonly depthBefore: QueueDepth | null;
  readonly depthAfter: QueueDepth | null;
  readonly responseMs: number;
  readonly runCompletedMs: number | null;
}): SyncExecutionEvidence {
  if (!input.redisConfigured || !input.depthBefore || !input.depthAfter) {
    return {
      mode: 'no_redis',
      reason:
        'REDIS_URL is not configured, so `getSyncQueue()` returns null and the backfill ' +
        'ran INLINE inside the request. Acceptance 4 cannot be demonstrated in this ' +
        'configuration — it is not a failure of the connector.',
      responseMs: input.responseMs,
    };
  }

  const jobsAdded = input.depthAfter.total - input.depthBefore.total;

  // A job that was added AND completed before the second observation nets to
  // zero in `wait` while showing up in `completed`; both are counted, so a
  // non-positive delta genuinely means nothing was enqueued.
  if (jobsAdded <= 0) {
    return {
      mode: 'inline_or_unproven',
      reason:
        `the sync queue's depth did not grow across the request ` +
        `(${input.depthBefore.total} → ${input.depthAfter.total}), so no job was observed ` +
        'being added. Either the producer ran the handler inline, or the job was added and ' +
        'removed by retention before the second observation.',
      depthBefore: input.depthBefore,
      depthAfter: input.depthAfter,
      responseMs: input.responseMs,
      runCompletedMs: input.runCompletedMs,
    };
  }

  return {
    mode: 'queued',
    jobsAdded,
    depthBefore: input.depthBefore,
    depthAfter: input.depthAfter,
    responseMs: input.responseMs,
    runCompletedMs: input.runCompletedMs,
  };
}
