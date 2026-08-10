/**
 * The sweep that catches a rail answering late (#127 refund rule 8).
 *
 * A request whose refund is committed sits in `in_progress` until the RAIL
 * reports. The ordinary path is the buyer refreshing their portal, which reads
 * `refunds.provider_state` live — but a buyer who never looks again is a request
 * that never reaches `completed`, and a completed request is what closes the
 * case and sends the last message.
 *
 * ## The dependency points ONE way
 *
 * This domain READS `refunds.provider_state`; it does not subscribe to provider
 * events and nothing in the payment domain knows this domain exists. A hook from
 * `refund-execution.service` into here would invert the seam that keeps the
 * money path free of everything built on top of it — the same one-way rule
 * `verified-conversion.ts` states for analytics and #110's own reconciler
 * already follows.
 *
 * ## The LOOP is gated; the record never is
 *
 * `RETAIL_SERVICE_RECONCILER_ENABLED` stops the sweep and stops nothing else.
 * Every request it would have advanced is advanced by the operator surface's
 * `complete`, which drives the same idempotent path, and by the buyer's own
 * portal read, which shows the true rail state whatever this loop is doing.
 *
 * ## `setInterval` unrefs
 *
 * A module-level housekeeping timer that keeps the event loop alive
 * non-deterministically hangs a Jest/vitest run under load. `.unref?.()`, with
 * the optional call for non-Node runtimes — the convention every singleton in
 * this repository follows.
 */

import { config } from '../../config/index.js';
import { findRefundById } from '../../db/orders/refundRepository.js';
import {
  appendRetailServiceEvent,
  listRetailServiceRequestsAwaitingSettlement,
  listRetailServiceRequestsPastSupplierClock,
  transitionRetailServiceRequest,
} from '../../db/retailServiceRequests/requestRepository.js';
import { log } from '../../lib/logger.js';
import { retailSystemDecider } from './authorization.js';
import { markRetailServiceRequestSettled } from './decision.service.js';
import { loadRetailServiceOrder } from './order-facts.js';
import {
  notifyRetailRefundCompleted,
  notifyRetailRefundFailed,
  notifyRetailRequestClosed,
  notifyRetailServiceDelayed,
} from './notifications.js';

let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Advance one page of requests whose rail has answered.
 *
 * Returns what it moved so a caller — a test, an operator trigger — can assert
 * it did something. Idempotent: a request already `completed` is not in the
 * partial index this reads.
 */
export async function reconcileRetailServiceRefunds(
  now: Date,
): Promise<{ settled: number; failed: number }> {
  const decider = retailSystemDecider('request:complete');
  const page = await listRetailServiceRequestsAwaitingSettlement({
    olderThan: new Date(now.getTime() - config.retailService.reconcileGraceMs),
    limit: config.retailService.reconcileBatchSize,
  });

  let settled = 0;
  let failed = 0;
  for (const request of page) {
    if (request.refundId === null) continue;
    const refund = await findRefundById(request.refundId);
    if (!refund) continue;

    if (refund.providerState === 'succeeded') {
      await markRetailServiceRequestSettled(decider, request.id, now);
      const context = await loadRetailServiceOrder(request.orderId);
      if (context !== null) {
        notifyRetailRefundCompleted(context.order, request.id);
        notifyRetailRequestClosed(context.order, request.id, 'completed');
      }
      settled += 1;
      continue;
    }

    if (refund.providerState === 'failed') {
      // The request stays `in_progress` with a bounded failure beside it. The
      // MONEY question lives in #49's own `refund_failed` discrepancy; this
      // domain records only that the buyer was told, which is the one thing
      // #49 cannot do.
      await transitionRetailServiceRequest({
        id: request.id,
        from: ['in_progress'],
        to: 'in_progress',
        completionFailure: 'refund_refused',
      });
      await appendRetailServiceEvent({
        requestId: request.id,
        kind: 'refund_failed',
        actorKind: 'system',
        detail: 'the rail refused the refund',
      });
      const context = await loadRetailServiceOrder(request.orderId);
      if (context !== null) notifyRetailRefundFailed(context.order, request.id);
      failed += 1;
    }
  }

  if (settled > 0 || failed > 0) {
    log.general.info({ settled, failed }, '[RetailService] refund settlement reconciled');
  }
  return { settled, failed };
}

/**
 * Tell a buyer their request is taking longer than expected (#127 communication
 * item 10).
 *
 * Keyed on the SUPPLIER clock, which is Mercaria's own deadline for a supplier's
 * answer — and passing it does NOTHING to the request. #127 policy rule 9 is
 * that a missing supplier response does not make a request disappear, and that
 * is why this function only sends a message: there is no transition here, no
 * closure and no state a supplier's silence can drive.
 *
 * The message's dedupe suffix carries the DAY, so a request stuck for a
 * fortnight produces a handful of messages rather than one or one a minute, and
 * the body names no supplier and no reason.
 */
export async function notifyRetailServiceDelays(now: Date): Promise<number> {
  const page = await listRetailServiceRequestsPastSupplierClock(
    now,
    config.retailService.reconcileBatchSize,
  );
  let notified = 0;
  const day = now.toISOString().slice(0, 10);
  for (const request of page) {
    const context = await loadRetailServiceOrder(request.orderId);
    if (context === null) continue;
    notifyRetailServiceDelayed(context.order, request.id, day);
    notified += 1;
  }
  return notified;
}

/** Start the sweep. A no-op when the lever is off or it is already running. */
export function startRetailServiceReconciler(): void {
  if (timer !== undefined) return;
  if (!config.retailService.reconcilerEnabled) {
    log.general.info({}, '[RetailService] the refund reconciler is disabled');
    return;
  }
  timer = setInterval(() => {
    const now = new Date();
    void reconcileRetailServiceRefunds(now).catch((err: unknown) => {
      log.general.error({ err }, '[RetailService] the refund reconciler failed a pass');
    });
    void notifyRetailServiceDelays(now).catch((err: unknown) => {
      log.general.error({ err }, '[RetailService] the delay notifier failed a pass');
    });
  }, config.retailService.reconcileIntervalMs);
  timer.unref?.();
  log.general.info(
    { intervalMs: config.retailService.reconcileIntervalMs },
    '[RetailService] the refund reconciler started',
  );
}

/** Stop the sweep. */
export function stopRetailServiceReconciler(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}
