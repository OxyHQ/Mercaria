/**
 * The delivery loop (#79).
 *
 * Issue operations 5's "notification stop independent of alert storage" is a
 * deploy, not an environment switch: delivery rows are durable queue rows, so a
 * process that stops delivering loses nothing — alerts keep being evaluated and
 * triggers keep being written — and the next one drains the backlog in queue
 * order.
 *
 * A separate dispatcher from the evaluator's rather than a second branch in it,
 * because issue evaluation 10 asks for separate durable jobs "so a notification
 * failure does not lose the qualifying event" — and one loop doing both would
 * make a stuck transport hold the lease that decides prices.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { claimPriceAlertNotifications } from '../../db/priceAlerts/priceAlertNotificationRepository.js';
import { deliverPriceAlertNotification } from './delivery.service.js';

/** One tick: claim a batch and deliver each. Returns how many actually went out. */
export async function runPriceAlertDeliveryTick(
  leaseOwner: string,
  now: Date = new Date(),
): Promise<number> {
  const claimed = await claimPriceAlertNotifications({
    leaseOwner,
    batchSize: config.priceAlerts.notificationBatchSize,
    leaseMs: config.priceAlerts.notificationLeaseMs,
    now,
  });

  let delivered = 0;
  for (const row of claimed) {
    try {
      const outcome = await deliverPriceAlertNotification(row, leaseOwner, now);
      if (outcome.outcome === 'delivered') delivered += 1;
    } catch (err: unknown) {
      // `deliverPriceAlertNotification` releases its own lease on every path it
      // knows about, so reaching here means something outside its own handling
      // threw. The row keeps its `delivering` state and its lease EXPIRES, which
      // is the reclaim path — deliberately not a release here, because this
      // handler does not know whether the send happened.
      log.general.error(
        { err, priceAlertNotificationId: row.id },
        '[PriceAlerts] delivery threw outside its own handling; the lease will expire',
      );
    }
  }
  return delivered;
}

/** Start the loop on this task. `unref()` immediately — see the evaluator's note. */
export function startPriceAlertDeliveryDispatcher(): void {
  const leaseOwner = `price-alert-delivery-${randomUUID()}`;
  const timer = setInterval(() => {
    void runPriceAlertDeliveryTick(leaseOwner).catch((err: unknown) => {
      log.general.warn({ err }, '[PriceAlerts] delivery tick failed');
    });
  }, config.priceAlerts.notificationPollIntervalMs);
  timer.unref?.();
}
