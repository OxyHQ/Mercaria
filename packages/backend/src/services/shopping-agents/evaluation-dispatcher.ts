/**
 * The EVALUATION loop (#97 evaluation 1, cost 1 and 10).
 *
 * `SHOPPING_AGENT_EVALUATION_ENABLED` gates the LOOP and never the durable
 * record. The scheduled sweep beside it is #97 cost rule 3 — "category and
 * source-aware reevaluation intervals" — expressed per AGENT, because the
 * cadence a shopper set for their own objective is the only interval this
 * domain has any business owning; how often a SOURCE is re-read is #68's, and a
 * second answer here would be the global TTL #68 forbids.
 *
 * ## An agent that keeps failing is ARCHIVED, not retried forever
 *
 * #97 cost rule 10 asks for exactly that, and the mechanism is the queue row's
 * own `dead_letter`: after `evaluationMaxAttempts` the row stops being claimed
 * and stays visible, so an operator metric can count them and the agent's owner
 * still has their agent. Deleting or disabling the agent itself would destroy
 * something a person made because a database was briefly unavailable.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import {
  claimShoppingAgentEvaluations,
  completeShoppingAgentEvaluation,
  listDueScheduledAgents,
  releaseShoppingAgentEvaluation,
  requestShoppingAgentEvaluation,
} from '../../db/shoppingAgents/shoppingAgentEvaluationRepository.js';
import { evaluateShoppingAgent } from './evaluation.service.js';

/** One tick: enqueue what is due on a schedule, then claim and evaluate. */
export async function runShoppingAgentEvaluationTick(
  leaseOwner: string,
  now: Date = new Date(),
): Promise<number> {
  for (const due of await listDueScheduledAgents(config.shoppingAgents.evaluationBatchSize, now)) {
    await requestShoppingAgentEvaluation(
      { agentId: due.id, triggerSource: 'scheduled' },
      undefined,
      now,
    );
  }

  const claimed = await claimShoppingAgentEvaluations({
    leaseOwner,
    batchSize: config.shoppingAgents.evaluationBatchSize,
    leaseMs: config.shoppingAgents.evaluationLeaseMs,
    now,
  });

  let evaluated = 0;
  for (const job of claimed) {
    try {
      const outcome = await evaluateShoppingAgent(job.agentId, job.triggerSource, now);
      const owned = await completeShoppingAgentEvaluation({
        id: job.id,
        leaseOwner,
        // The REAL three-valued outcome, or nothing at all. Collapsing
        // `not_qualified` and `incomplete` into absence would leave
        // `readShoppingAgentEvaluationSummary().incomplete` at a permanent zero
        // — and that number is the one that shows a working queue delivering
        // nothing, which is the failure this domain is shaped around.
        ...(outcome.findingOutcome === undefined ? {} : { outcome: outcome.findingOutcome }),
        now,
      });
      if (owned) evaluated += 1;
    } catch (err: unknown) {
      const deadLettered = job.attempts >= config.shoppingAgents.evaluationMaxAttempts;
      const backoffMs = Math.min(
        config.shoppingAgents.evaluationMaxBackoffMs,
        1_000 * 2 ** Math.min(job.attempts, 16),
      );
      await releaseShoppingAgentEvaluation({
        id: job.id,
        leaseOwner,
        deadLettered,
        availableAt: new Date(now.getTime() + backoffMs),
        failure: deadLettered ? 'evaluation_dead_lettered' : 'evaluation_failed',
        now,
      });
      log.general.warn(
        { err, agentId: job.agentId, deadLettered },
        '[ShoppingAgents] agent evaluation failed',
      );
    }
  }
  return evaluated;
}

/** Start the loop on this task. `unref()` immediately — see the trigger dispatcher. */
export function startShoppingAgentEvaluationDispatcher(): void {
  if (!config.shoppingAgents.evaluationEnabled) return;

  const leaseOwner = `shopping-agent-eval-${randomUUID()}`;
  const timer = setInterval(() => {
    void runShoppingAgentEvaluationTick(leaseOwner).catch((err: unknown) => {
      log.general.warn({ err }, '[ShoppingAgents] evaluation tick failed');
    });
  }, config.shoppingAgents.evaluationPollIntervalMs);
  timer.unref?.();
}
