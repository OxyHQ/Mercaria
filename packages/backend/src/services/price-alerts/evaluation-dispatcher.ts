/**
 * The evaluation loop (#79 evaluation 1, abuse rule 2).
 *
 * `PRICE_ALERT_EVALUATION_ENABLED` gates the LOOP and never the durable record:
 * a queue row is written on every offer write to a watched product whatever this
 * flag says, and turning it on drains whatever accumulated while it was off.
 * Turning it off cannot lose a qualifying event either — what stops is the
 * DECIDING, and the offers are still there to be decided against when it comes
 * back. The three levers and what each does are in `config/index.ts`.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import {
  claimPriceAlertEvaluations,
  completePriceAlertEvaluation,
  releasePriceAlertEvaluation,
} from '../../db/priceAlerts/priceAlertEvaluationRepository.js';
import { evaluatePriceAlertsForProduct } from './evaluation.service.js';

/** How many failed attempts before a subject stops being retried, VISIBLY. */
const MAX_EVALUATION_ATTEMPTS = 8;

/** One tick: claim a batch, evaluate each subject, release. */
export async function runPriceAlertEvaluationTick(
  leaseOwner: string,
  now: Date = new Date(),
): Promise<number> {
  const claimed = await claimPriceAlertEvaluations({
    leaseOwner,
    batchSize: config.priceAlerts.evaluationBatchSize,
    leaseMs: config.priceAlerts.evaluationLeaseMs,
    now,
  });

  let evaluated = 0;
  for (const job of claimed) {
    try {
      const outcome = await evaluatePriceAlertsForProduct(job.canonicalProductId, now);
      const owned = await completePriceAlertEvaluation({
        id: job.id,
        leaseOwner,
        evaluatedAlerts: outcome.evaluatedAlerts,
        qualifiedAlerts: outcome.qualifiedAlerts,
        now,
      });
      if (owned) evaluated += 1;
    } catch (err: unknown) {
      const deadLettered = job.attempts >= MAX_EVALUATION_ATTEMPTS;
      const backoffMs = Math.min(
        config.priceAlerts.evaluationMaxBackoffMs,
        1_000 * 2 ** Math.min(job.attempts, 16),
      );
      await releasePriceAlertEvaluation({
        id: job.id,
        leaseOwner,
        deadLettered,
        availableAt: new Date(now.getTime() + backoffMs),
        // A CODE and never the exception's own text: an error message from a
        // driver or a provider is somebody else's unbounded vocabulary, and this
        // column is read by an operator surface.
        failure: deadLettered ? 'evaluation_dead_lettered' : 'evaluation_failed',
        now,
      });
      log.general.warn(
        { err, canonicalProductId: job.canonicalProductId, deadLettered },
        '[PriceAlerts] subject evaluation failed',
      );
    }
  }
  return evaluated;
}

/**
 * Start the loop on this task.
 *
 * `unref()` immediately: a module-level `setInterval` keeps the Node event loop
 * alive and hangs a vitest run non-deterministically — the convention
 * `LeaderElection` established and every Oxy singleton since has followed.
 */
export function startPriceAlertEvaluationDispatcher(): void {
  if (!config.priceAlerts.evaluationEnabled) return;

  const leaseOwner = `price-alert-eval-${randomUUID()}`;
  const timer = setInterval(() => {
    void runPriceAlertEvaluationTick(leaseOwner).catch((err: unknown) => {
      log.general.warn({ err }, '[PriceAlerts] evaluation tick failed');
    });
  }, config.priceAlerts.evaluationPollIntervalMs);
  timer.unref?.();
}
