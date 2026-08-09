/**
 * The three loops of the procurement domain, and the levers that gate them.
 *
 * All three start on EVERY task, not on a leader. Claims are Postgres leases
 * taken with `for update skip locked` and released with an owner check, so N
 * tasks share the work without contending and a dead task's lease is reclaimed
 * rather than stranding a supplier order.
 *
 * The LOOPS are gated; the durable records never are. Rows are written whatever
 * the configuration says, so switching a lever off during an incident parks the
 * work and switching it back on delivers the backlog — the rule the payment and
 * moderation dispatchers already follow, and one whose inverse (gating the
 * record) is the change that looks equivalent and silently loses a supplier
 * order a customer has paid for.
 *
 * ## Why THREE loops and not one
 *
 * Because the three answer to different levers, and #124 item 10 asks for
 * exactly that independence:
 *
 *  - the ORCHESTRATION loop submits and cancels — the acts that change
 *    something at a supplier;
 *  - the POLL loop asks — the outbound reads, which a provider incident makes
 *    worth pausing on its own;
 *  - the EVENT loop interprets what is already stored — which is what moves a
 *    purchase order and therefore what a customer sees.
 *
 * One loop reading a filter would give the same behaviour and hide the fact
 * that these are three separate decisions an operator makes at 3am.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { drainProcurementOutbox } from './procurement-outbox.service.js';
import { processSupplierProviderEvents } from './event-processing.service.js';
import { runProcurementOutboxEvent } from './outbox-handlers.js';

/** The event types the orchestration loop claims — everything but the poll. */
const ORCHESTRATION_EVENT_TYPES = [
  'purchase_order_submission',
  'purchase_order_convergence',
  'purchase_order_cancellation',
  'purchase_order_accepted',
  'purchase_order_rejected',
  'purchase_order_exception',
] as const;

/** The one type the poll loop claims. */
const POLL_EVENT_TYPES = ['purchase_order_status_poll'] as const;

const timers: NodeJS.Timeout[] = [];
const abortController = new AbortController();
let orchestrationRunning = false;
let pollRunning = false;
let eventsRunning = false;

async function tickOrchestration(): Promise<void> {
  if (orchestrationRunning) return;
  orchestrationRunning = true;
  try {
    const result = await drainProcurementOutbox({
      handler: runProcurementOutboxEvent,
      eventTypes: ORCHESTRATION_EVENT_TYPES,
      batchSize: config.procurement.outboxBatchSize,
      leaseMs: config.procurement.outboxLeaseMs,
      signal: abortController.signal,
    });
    if (result.processed > 0 || result.failed > 0) {
      log.general.debug(result, '[Procurement] orchestration drained');
    }
  } catch (error: unknown) {
    // The loop must survive anything a single drain throws, or one bad row
    // stops every supplier order for the life of the process.
    log.general.error({ err: error }, '[Procurement] orchestration dispatch failed');
  } finally {
    orchestrationRunning = false;
  }
}

async function tickPolling(): Promise<void> {
  if (pollRunning) return;
  pollRunning = true;
  try {
    const result = await drainProcurementOutbox({
      handler: runProcurementOutboxEvent,
      eventTypes: POLL_EVENT_TYPES,
      batchSize: config.procurement.outboxBatchSize,
      leaseMs: config.procurement.outboxLeaseMs,
      signal: abortController.signal,
    });
    if (result.processed > 0 || result.rescheduled > 0 || result.failed > 0) {
      log.general.debug(result, '[Procurement] status polling drained');
    }
  } catch (error: unknown) {
    log.general.error({ err: error }, '[Procurement] status polling failed');
  } finally {
    pollRunning = false;
  }
}

async function tickEvents(): Promise<void> {
  if (eventsRunning) return;
  eventsRunning = true;
  try {
    const result = await processSupplierProviderEvents({
      batchSize: config.procurement.eventBatchSize,
      leaseMs: config.procurement.eventLeaseMs,
      signal: abortController.signal,
    });
    if (result.processed > 0 || result.failed > 0) {
      log.general.debug(result, '[Procurement] supplier events processed');
    }
  } catch (error: unknown) {
    log.general.error({ err: error }, '[Procurement] supplier event processing failed');
  } finally {
    eventsRunning = false;
  }
}

/** Begin draining. Idempotent — a second call is a no-op. */
export function startProcurementDispatchers(): void {
  if (timers.length > 0) return;

  if (config.procurement.orchestrationEnabled) {
    const timer = setInterval(() => void tickOrchestration(), config.procurement.outboxPollIntervalMs);
    timer.unref?.();
    timers.push(timer);
  } else {
    log.general.warn(
      '[Procurement] the orchestration dispatcher is DISABLED; supplier submissions and ' +
        'cancellations are recorded and will deliver once it is enabled',
    );
  }

  if (config.procurement.orchestrationEnabled && config.procurement.providerFetchEnabled) {
    const timer = setInterval(() => void tickPolling(), config.procurement.outboxPollIntervalMs);
    timer.unref?.();
    timers.push(timer);
  } else {
    log.general.warn(
      '[Procurement] status polling is DISABLED; webhooks are still received and stored',
    );
  }

  if (config.procurement.eventProcessingEnabled) {
    const timer = setInterval(() => void tickEvents(), config.procurement.eventPollIntervalMs);
    timer.unref?.();
    timers.push(timer);
  } else {
    log.general.warn(
      '[Procurement] supplier event processing is DISABLED; events accumulate durably and ' +
        'nothing customer-visible moves',
    );
  }

  if (timers.length > 0) {
    log.general.info(
      {
        orchestration: config.procurement.orchestrationEnabled,
        providerFetch: config.procurement.providerFetchEnabled,
        eventProcessing: config.procurement.eventProcessingEnabled,
      },
      '[Procurement] dispatchers started',
    );
  }
}

/**
 * Stop claiming new work.
 *
 * The row already in flight is allowed to reach a durable state — aborting a
 * submission mid-handler would leave a lease to expire and the work to be
 * redone, which is safe (the convergence path asks before it resubmits) but
 * wasteful.
 */
export function stopProcurementDispatchers(): void {
  abortController.abort();
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
}
