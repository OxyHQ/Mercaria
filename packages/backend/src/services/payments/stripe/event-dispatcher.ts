/**
 * The loop that drains stored Stripe events.
 *
 * Starts on EVERY task, not just a leader — claims are Postgres leases taken
 * with `for update skip locked` and released with an owner check, so N tasks
 * share the stream without contending and a dead task's lease is reclaimed
 * rather than stranding an event nobody will interpret. Exactly the payment
 * outbox dispatcher's shape, deliberately.
 *
 * ## What it is FOR, given the ingress already processes inline
 *
 * Three things the inline path cannot do: retry a handler that failed, pick up
 * an event whose task died between storing it and processing it, and run an
 * event that was dead-lettered and then replayed by an operator. All three are
 * the durable half of "a 200 means stored, never processed", and without a
 * poller that promise would be a comment rather than a mechanism.
 *
 * ## The gate is the RAIL, not the loop
 *
 * Unlike the outbox dispatcher — which is gated separately from its record so an
 * incident can park work — this simply does not run when Stripe is off, because
 * in that state no route is mounted, no event can have been stored, and there is
 * nothing to park. The gating decision lives in one place, `STRIPE_ENABLED`.
 */

import { config } from '../../../config/index.js';
import { log } from '../../../lib/logger.js';
import { drainStripeEvents } from './event-processor.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
const abortController = new AbortController();

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await drainStripeEvents({
      batchSize: config.payments.stripe.eventBatchSize,
      leaseMs: config.payments.stripe.eventLeaseMs,
      signal: abortController.signal,
    });
    if (result.processed > 0 || result.failed > 0) {
      log.general.debug(result, '[Stripe] event queue drained');
    }
  } catch (error: unknown) {
    // The loop must survive anything one drain throws, or a single bad row stops
    // every subsequent payment event for the life of the process.
    log.general.error({ err: error }, '[Stripe] event dispatch failed');
  } finally {
    running = false;
  }
}

/** Begin draining. Idempotent — a second call is a no-op. */
export function startStripeEventDispatcher(): void {
  if (timer !== undefined) return;
  if (!config.payments.stripe.enabled) return;

  timer = setInterval(() => {
    void tick();
  }, config.payments.stripe.eventPollIntervalMs);
  // Never hold the event loop open for the poll — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info(
    {
      pollIntervalMs: config.payments.stripe.eventPollIntervalMs,
      batchSize: config.payments.stripe.eventBatchSize,
      leaseMs: config.payments.stripe.eventLeaseMs,
      livemode: config.payments.stripe.livemode,
    },
    '[Stripe] event dispatcher started',
  );
}

/**
 * Stop claiming new work.
 *
 * The event already in flight is allowed to reach a durable state — aborting it
 * mid-handler would leave a lease to expire and the work to be redone, which is
 * safe but wasteful.
 */
export function stopStripeEventDispatcher(): void {
  abortController.abort();
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
