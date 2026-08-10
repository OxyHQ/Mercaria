/**
 * The delivery loop, and issue operations 5's GLOBAL NOTIFICATION KILL SWITCH.
 *
 * `PRICE_ALERT_NOTIFICATIONS_ENABLED` gates this loop and NOTHING else. That is
 * the whole of "a global notification kill switch independent of alert storage":
 * with it off, alerts keep being evaluated, triggers keep being written and
 * delivery rows keep being queued — nothing is lost and nothing is sent, and
 * flipping it back drains the backlog in queue order.
 *
 * It defaults ON, unlike the two rollout levers beside it, because it is an
 * INCIDENT lever: a switch that ships in the off position is a feature nobody
 * notices is missing.
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
  if (!config.priceAlerts.notificationsEnabled) return;

  const leaseOwner = `price-alert-delivery-${randomUUID()}`;
  const timer = setInterval(() => {
    void runPriceAlertDeliveryTick(leaseOwner).catch((err: unknown) => {
      log.general.warn({ err }, '[PriceAlerts] delivery tick failed');
    });
  }, config.priceAlerts.notificationPollIntervalMs);
  timer.unref?.();
}
