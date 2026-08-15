/**
 * The TRIGGER loop — one canonical product's fan-out (#97 evaluation 1,
 * cost 2 and 8).
 *
 * `SHOPPING_AGENT_TRIGGER_ENABLED` gates the LOOP and never the durable record:
 * a trigger row is written on every offer write to a watched product whatever
 * this flag says, and turning it on drains whatever accumulated while it was
 * off. Turning it off cannot lose an event either — what stops is the WAKING,
 * and the catalogue is still there to be evaluated against when it comes back.
 *
 * ## The fan-out is BOUNDED and the row CONVERGES, which is #97 cost rule 8
 *
 * One claim wakes at most `triggerFanOutLimit` agents. That is not a truncation
 * that loses the rest: the trigger row is a convergence queue, so the ones it
 * did not reach are still owed a wake-up and the NEXT claim takes them — a
 * popular product cannot starve every other job by arriving with ten thousand
 * watchers, and no watcher is dropped.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import {
  claimShoppingAgentTriggers,
  completeShoppingAgentTrigger,
  releaseShoppingAgentTrigger,
} from '../../db/shoppingAgents/shoppingAgentTriggerRepository.js';
import { listEvaluableShoppingAgentIdsForProduct } from '../../db/shoppingAgents/shoppingAgentRepository.js';
import { requestShoppingAgentEvaluation } from '../../db/shoppingAgents/shoppingAgentEvaluationRepository.js';

/** How many failed attempts before a subject stops being retried, VISIBLY. */
const MAX_TRIGGER_ATTEMPTS = 8;

/** One tick: claim a batch of products, wake the agents watching each, release. */
export async function runShoppingAgentTriggerTick(
  leaseOwner: string,
  now: Date = new Date(),
): Promise<number> {
  const claimed = await claimShoppingAgentTriggers({
    leaseOwner,
    batchSize: config.shoppingAgents.triggerBatchSize,
    leaseMs: config.shoppingAgents.triggerLeaseMs,
    now,
  });

  let processed = 0;
  for (const job of claimed) {
    try {
      const agentIds = await listEvaluableShoppingAgentIdsForProduct(
        job.canonicalProductId,
        config.shoppingAgents.triggerFanOutLimit,
      );
      for (const agentId of agentIds) {
        await requestShoppingAgentEvaluation(
          { agentId, triggerSource: 'offer_change' },
          undefined,
          now,
        );
      }
      const owned = await completeShoppingAgentTrigger({
        id: job.id,
        leaseOwner,
        fannedOutAgents: agentIds.length,
        now,
      });
      if (owned) processed += 1;
    } catch (err: unknown) {
      const deadLettered = job.attempts >= MAX_TRIGGER_ATTEMPTS;
      const backoffMs = Math.min(
        config.shoppingAgents.evaluationMaxBackoffMs,
        1_000 * 2 ** Math.min(job.attempts, 16),
      );
      await releaseShoppingAgentTrigger({
        id: job.id,
        leaseOwner,
        deadLettered,
        availableAt: new Date(now.getTime() + backoffMs),
        // A CODE and never the exception's own text: a driver's message is
        // somebody else's unbounded vocabulary and this column is read by an
        // operator surface.
        failure: deadLettered ? 'fan_out_dead_lettered' : 'fan_out_failed',
        now,
      });
      log.general.warn(
        { err, canonicalProductId: job.canonicalProductId, deadLettered },
        '[ShoppingAgents] product fan-out failed',
      );
    }
  }
  return processed;
}

/**
 * Start the loop on this task.
 *
 * `unref()` immediately: a module-level `setInterval` keeps the Node event loop
 * alive and hangs a vitest run non-deterministically — the convention every Oxy
 * singleton follows.
 */
export function startShoppingAgentTriggerDispatcher(): void {
  if (!config.shoppingAgents.triggerEnabled) return;

  const leaseOwner = `shopping-agent-trigger-${randomUUID()}`;
  const timer = setInterval(() => {
    void runShoppingAgentTriggerTick(leaseOwner).catch((err: unknown) => {
      log.general.warn({ err }, '[ShoppingAgents] trigger tick failed');
    });
  }, config.shoppingAgents.triggerPollIntervalMs);
  timer.unref?.();
}
