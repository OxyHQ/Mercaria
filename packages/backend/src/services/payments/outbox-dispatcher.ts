/**
 * The loop that drains the payment outbox.
 *
 * Starts on EVERY task, not just a leader. Claims are Postgres leases taken with
 * `for update skip locked` and released with an owner check, so N tasks share the
 * work without contending and a dead task's lease is reclaimed rather than
 * stranding the row.
 *
 * The LOOP is gated by configuration; the durable record never is. Rows are
 * written whatever `config.payments.outboxEnabled` says, so switching the
 * dispatcher off during an incident parks the work and switching it back on
 * delivers the backlog. Exactly the rule the moderation dispatcher follows, and
 * for the same reason it was written down there: gating the record instead is
 * the change that looks equivalent and silently loses work.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { drainPaymentOutbox } from './payment-outbox.service.js';
import { runPaymentOutboxEvent } from './outbox-handlers.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
const abortController = new AbortController();

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await drainPaymentOutbox({
      handler: runPaymentOutboxEvent,
      batchSize: config.payments.outboxBatchSize,
      leaseMs: config.payments.outboxLeaseMs,
      signal: abortController.signal,
    });
    if (result.processed > 0 || result.failed > 0) {
      log.general.debug(result, '[Payments] outbox drained');
    }
  } catch (error: unknown) {
    // The loop must survive anything a single drain throws, or one bad row stops
    // every payment's consequences for the life of the process.
    log.general.error({ err: error }, '[Payments] outbox dispatch failed');
  } finally {
    running = false;
  }
}

/** Begin draining. Idempotent — a second call is a no-op. */
export function startPaymentOutboxDispatcher(): void {
  if (timer !== undefined) return;
  if (!config.payments.outboxEnabled) {
    log.general.warn(
      '[Payments] outbox dispatcher is DISABLED; payment events are recorded and will ' +
        'deliver once it is enabled',
    );
    return;
  }

  timer = setInterval(() => {
    void tick();
  }, config.payments.outboxPollIntervalMs);
  // Never hold the event loop open for the poll — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info(
    {
      pollIntervalMs: config.payments.outboxPollIntervalMs,
      batchSize: config.payments.outboxBatchSize,
      leaseMs: config.payments.outboxLeaseMs,
    },
    '[Payments] outbox dispatcher started',
  );
}

/**
 * Stop claiming new work.
 *
 * The row already in flight is allowed to reach a durable state — aborting it
 * mid-handler would leave a lease to expire and the work to be redone, which is
 * safe but wasteful.
 */
export function stopPaymentOutboxDispatcher(): void {
  abortController.abort();
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
