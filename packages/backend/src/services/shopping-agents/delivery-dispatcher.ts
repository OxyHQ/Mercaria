/**
 * The DELIVERY loop, and #97 evaluation 10's independent kill switch.
 *
 * `SHOPPING_AGENT_NOTIFICATIONS_ENABLED` stops the sending and NOTHING else:
 * catalogue events keep enqueueing, agents keep being evaluated and findings
 * keep being appended, so flipping it back drains the backlog and nothing that
 * qualified while it was off is lost. That is the whole point of it being a
 * separate lever from the evaluation one — #97 evaluation 10 asks that the two
 * stop INDEPENDENTLY.
 *
 * It defaults ON, unlike the three rollout levers, because it is an INCIDENT
 * lever and an incident lever that ships in the off position is a feature
 * nobody notices is missing.
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
  if (!config.shoppingAgents.notificationsEnabled) return;

  const leaseOwner = `shopping-agent-delivery-${randomUUID()}`;
  const timer = setInterval(() => {
    void runShoppingAgentDeliveryTick(leaseOwner).catch((err: unknown) => {
      log.general.warn({ err }, '[ShoppingAgents] delivery tick failed');
    });
  }, config.shoppingAgents.notificationPollIntervalMs);
  timer.unref?.();
}
