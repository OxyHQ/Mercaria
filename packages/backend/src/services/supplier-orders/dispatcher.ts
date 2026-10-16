/**
 * The three loops of the procurement domain.
 *
 * All three start on EVERY task, not on a leader. Claims are Postgres leases
 * taken with `for update skip locked` and released with an owner check, so N
 * tasks share the work without contending and a dead task's lease is reclaimed
 * rather than stranding a supplier order.
 *
 * The loops always run. What stops a supplier is the per-supplier kill switch
 * (`supplier_accounts.state = 'killed'`), read at the provider-call chokepoint;
 * what keeps a new retail order out of this domain is the retail entry gate
 * (`config.retail.enabled`) at checkout entry. Neither gates a durable record, so a paused supplier's work
 * waits rather than being lost.
 *
 * ## Why THREE loops and not one
 *
 * Because the three are different kinds of work, and #124 item 10 asks for them
 * to be separable:
 *
 *  - the ORCHESTRATION loop submits and cancels — the acts that change
 *    something at a supplier;
 *  - the POLL loop asks — the outbound reads, which a provider incident makes
 *    worth pausing on its own;
 *  - the EVENT loop interprets what is already stored — which is what moves a
 *    purchase order and therefore what a customer sees.
 *
 * One loop reading a filter would give the same behaviour and hide that a slow
 * provider read must not hold up a submission or the interpretation of events.
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

  const loops: [() => Promise<void>, number][] = [
    [tickOrchestration, config.procurement.outboxPollIntervalMs],
    [tickPolling, config.procurement.outboxPollIntervalMs],
    [tickEvents, config.procurement.eventPollIntervalMs],
  ];
  for (const [tick, intervalMs] of loops) {
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
    timers.push(timer);
  }
  log.general.info('[Procurement] dispatchers started');
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
