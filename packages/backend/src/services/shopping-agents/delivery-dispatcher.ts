/**
 * The DELIVERY loop (#97).
 *
 * A separate loop from evaluation, so #97 evaluation 10's "stop evaluation or
 * notification independently" is a deploy of one without the other, not an
 * environment switch. Delivery rows are durable queue rows: a process that
 * stops sending loses nothing, findings keep being appended, and the next one
 * drains the backlog.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { claimShoppingAgentNotifications } from '../../db/shoppingAgents/shoppingAgentNotificationRepository.js';
import { deliverShoppingAgentNotification } from './delivery.service.js';

/** One tick: claim a batch, deliver each, count what happened. */
export async function runShoppingAgentDeliveryTick(
  leaseOwner: string,
  now: Date = new Date(),
): Promise<number> {
  const claimed = await claimShoppingAgentNotifications({
    leaseOwner,
    batchSize: config.shoppingAgents.notificationBatchSize,
    leaseMs: config.shoppingAgents.notificationLeaseMs,
    now,
  });

  let delivered = 0;
  for (const row of claimed) {
    const outcome = await deliverShoppingAgentNotification(row, leaseOwner, now);
    if (outcome.outcome === 'delivered') delivered += 1;
  }
  return delivered;
}

/** Start the loop on this task. `unref()` immediately — the Oxy singleton rule. */
export function startShoppingAgentDeliveryDispatcher(): void {
  const leaseOwner = `shopping-agent-delivery-${randomUUID()}`;
  const timer = setInterval(() => {
    void runShoppingAgentDeliveryTick(leaseOwner).catch((err: unknown) => {
      log.general.warn({ err }, '[ShoppingAgents] delivery tick failed');
    });
  }, config.shoppingAgents.notificationPollIntervalMs);
  timer.unref?.();
}
