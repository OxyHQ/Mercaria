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
 * A configured cohort starts the timer even before asynchronous registration.
 * Each drain requires its registered namespace and restricts claims in SQL;
 * turning off new actions never strands existing cohort obligations.
 */

import { parseBillingCohort } from '../../billing/cohort-config.js';
import { config } from '../../../config/index.js';
import { log } from '../../../lib/logger.js';
import { drainStripeEvents } from './event-processor.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
let abortController = new AbortController();

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  const signal = abortController.signal;
  try {
    const result = await drainStripeEvents({
      batchSize: config.payments.stripe.eventBatchSize,
      leaseMs: config.payments.stripe.eventLeaseMs,
      signal,
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
  if (
    !config.payments.stripe.enabled &&
    !parseBillingCohort(config.merchantBilling.peableCohortJson)
  )
    return;
  abortController = new AbortController();

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
