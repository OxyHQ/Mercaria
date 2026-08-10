/**
 * The sweep that finishes a return once the rail has paid (#110 acceptance 5).
 *
 * ## Why a sweep exists at all
 *
 * `refund.service.process` drains the provider outbox inline, so the rail has
 * usually answered before `refundReturnRequest` returns and the return completes
 * in the same call. "Usually" is the whole reason for this file: a rail that is
 * slow, a task that died mid-drain, a refund the dispatcher picked up later.
 * Without a sweep those returns sit in `refund_pending` forever — the buyer's
 * portal says a refund is on its way and nothing ever says it arrived, which is
 * the failure #50's own reconciliation section describes: an event that was
 * never delivered is invisible to everything that waits to be told.
 *
 * ## The dependency points ONE way
 *
 * This reads `refunds.provider_state`. It does not subscribe to provider events
 * and nothing in the payment domain knows this domain exists — a hook from
 * `refund-execution.service` into here would invert the seam that keeps the
 * money path free of everything built on top of it, which is the same one-way
 * rule `verified-conversion.ts` states for analytics.
 *
 * ## The LOOP is gated; the rows never are
 *
 * `BUYER_REQUEST_RECONCILER_ENABLED` stops the timer and nothing else. A return
 * waiting on a rail is a durable row that a merchant or an operator can also
 * advance by hand, and turning the sweep off during an incident must not make a
 * buyer's refund unfinishable.
 */

import { config } from '../../config/index.js';
import { listReturnRequestsAwaitingRefundSettlement } from '../../db/buyerRequests/returnRepository.js';
import { log } from '../../lib/logger.js';
import { reconcileReturnRefund } from './return-decision.service.js';

/** The timer, so the dispatcher can be stopped in a test. */
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Advance every `refund_pending` return whose rail has answered.
 *
 * Bounded by the configured batch size and resumable by `updated_at`, so a
 * backlog drains across ticks rather than in one statement. Each request is
 * isolated: one that throws is logged and the page continues, because a page
 * that aborted on its worst row would stall behind it forever — the
 * `examineSubject` rule from #60's backfill.
 *
 * @returns how many returns this pass moved to a terminal answer.
 */
export async function reconcileBuyerRequestRefunds(now: Date = new Date()): Promise<number> {
  // A grace period before a return is swept: the inline drain usually finishes
  // the job, and sweeping a row the request handler is still working on would
  // race it into the same compare-and-swap for no benefit.
  const updatedBefore = new Date(
    now.getTime() - config.buyerRequests.reconcileGraceMs,
  );
  const pending = await listReturnRequestsAwaitingRefundSettlement({
    updatedBefore,
    limit: config.buyerRequests.reconcileBatchSize,
  });

  let advanced = 0;
  for (const request of pending) {
    try {
      const after = await reconcileReturnRefund({ requestId: request.id, now });
      if (after.request.state !== 'refund_pending') advanced += 1;
    } catch (err: unknown) {
      log.general.warn(
        { err, requestId: request.id },
        '[BuyerRequests] a return refund could not be reconciled; the next pass retries',
      );
    }
  }
  return advanced;
}

/**
 * Start the sweep on this task.
 *
 * `.unref()` so the timer never holds the event loop open — the house rule for
 * every module-level `setInterval`, and the reason a jest run does not hang.
 */
export function startBuyerRequestReconciler(): void {
  if (timer !== null) return;
  if (!config.buyerRequests.reconcilerEnabled) {
    log.general.info(
      '[BuyerRequests] refund reconciler disabled; returns awaiting a rail are advanced by ' +
        'the merchant or operator surfaces only',
    );
    return;
  }
  timer = setInterval(() => {
    void reconcileBuyerRequestRefunds().catch((err: unknown) => {
      log.general.error({ err }, '[BuyerRequests] refund reconciler pass failed');
    });
  }, config.buyerRequests.reconcileIntervalMs);
  timer.unref?.();
}

/** Stop the sweep. */
export function stopBuyerRequestReconciler(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
