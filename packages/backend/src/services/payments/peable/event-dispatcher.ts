/**
 * The loop that drains stored Peable events.
 *
 * Starts on EVERY task, not just a leader — claims are Postgres leases taken
 * with `for update skip locked` and released with an owner check, so N tasks
 * share the stream without contending and a dead task's lease is reclaimed
 * rather than stranding an event nobody will interpret. The Stripe dispatcher's
 * shape, deliberately, and it runs BESIDE it: the two poll the same table and
 * never collide because each claim is scoped to its own rail.
 *
 * ## What it is FOR, given the ingress already processes inline
 *
 * Three things the inline path cannot do: retry a handler that failed, pick up
 * an event whose task died between storing it and processing it, and run an
 * event that was dead-lettered and then replayed by an operator. All three are
 * the durable half of "a 200 means stored, never processed", and without a
 * poller that promise would be a comment rather than a mechanism.
 *
 * ## The gate is the RAIL
 *
 * It simply does not run when Peable is off, because in that state no route is
 * mounted, no event can have been stored, and there is nothing to park. The
 * gating decision lives in one place, `config.payments.peable.enabled`, which is
 * itself a conjunction of the flag and every secret the rail cannot work
 * without.
 */

import { config } from '../../../config/index.js';
import { log } from '../../../lib/logger.js';
import { drainPeableEvents } from './event-processor.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
const abortController = new AbortController();

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await drainPeableEvents({
      batchSize: config.payments.peable.eventBatchSize,
      leaseMs: config.payments.peable.eventLeaseMs,
      signal: abortController.signal,
    });
    if (result.processed > 0 || result.failed > 0) {
      log.general.debug(result, '[Peable] event queue drained');
    }
  } catch (error: unknown) {
    // The loop must survive anything one drain throws, or a single bad row stops
    // every subsequent payment event for the life of the process.
    log.general.error({ err: error }, '[Peable] event dispatch failed');
  } finally {
    running = false;
  }
}

/** Begin draining. Idempotent — a second call is a no-op. */
export function startPeableEventDispatcher(): void {
  if (timer !== undefined) return;
  if (!config.payments.peable.enabled) return;

  timer = setInterval(() => {
    void tick();
  }, config.payments.peable.eventPollIntervalMs);
  // Never hold the event loop open for the poll.
  timer.unref?.();

  log.general.info(
    {
      pollIntervalMs: config.payments.peable.eventPollIntervalMs,
      batchSize: config.payments.peable.eventBatchSize,
      leaseMs: config.payments.peable.eventLeaseMs,
      livemode: config.payments.peable.livemode,
    },
    '[Peable] event dispatcher started',
  );
}

/**
 * Stop claiming new work.
 *
 * The event already in flight is allowed to reach a durable state — aborting it
 * mid-handler would leave a lease to expire and the work to be redone, which is
 * safe but wasteful.
 */
export function stopPeableEventDispatcher(): void {
  abortController.abort();
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
