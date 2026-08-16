/**
 * The reconciliation loop (#67).
 *
 * `AFFILIATE_RECONCILIATION_ENABLED` gates the LOOP and NEVER a durable record.
 * Turning it off stops Mercaria asking networks what they owe; it cannot delete
 * a transaction, an observation or a posting, and turning it back on drains
 * whatever the networks accumulated meanwhile — the lookback is 45 days, so a
 * pass after an outage re-reads the whole window rather than resuming from a
 * cursor that could have been left mid-page.
 *
 * There is deliberately no per-network flag. The eBay half already fails closed
 * on its own terms (`ebay.ts`), and a second lever whose only reachable effect
 * is to disable a network that is disabled anyway would be a switch nobody
 * could test.
 *
 * ## `unref()` is not optional
 *
 * A module-level `setInterval` keeps the Node event loop alive and hangs a
 * vitest run non-deterministically — the convention every Oxy singleton follows
 * since `LeaseElection`, and the reason `--detectOpenHandles` exists in this
 * repository's debugging notes.
 */

import { randomUUID } from 'node:crypto';
import { AFFILIATE_NETWORK_IDS } from '@mercaria/shared-types';
import { config } from '../../../config/index.js';
import { log } from '../../../lib/logger.js';
import { getDb } from '../../../db/postgres.js';
import {
  runAffiliateReconciliationPass,
  type AffiliateReconciliationPassResult,
} from './poll.service.js';

/**
 * One tick: a pass over every network.
 *
 * Exported so the operator surface and the tests drive the SAME function the
 * timer drives. A network whose pass throws does NOT stop the others: a failing
 * Awin credential must not be the reason nobody ever polls a second network.
 */
export async function runAffiliateReconciliationTick(
  leaseOwner: string,
  now: Date = new Date(),
): Promise<readonly AffiliateReconciliationPassResult[]> {
  const db = getDb();
  const results: AffiliateReconciliationPassResult[] = [];
  for (const network of AFFILIATE_NETWORK_IDS) {
    try {
      const result = await runAffiliateReconciliationPass(db, { network, now, leaseOwner });
      results.push(result);
      if (result.unavailable) {
        // Reported at INFO, not WARN: a network with no reader and a deployment
        // with no publisher account are both configuration states somebody
        // chose, and paging on one every hour is how a real warning stops being
        // read.
        log.general.info(
          { network, reason: result.unavailable.reason },
          `[AffiliateReconciliation] ${result.unavailable.detail}`,
        );
      }
    } catch (err) {
      log.general.warn({ err, network }, '[AffiliateReconciliation] pass failed');
    }
  }
  return results;
}

/** Start the loop on this task. See the module docblock. */
export function startAffiliateReconciliationDispatcher(): void {
  if (!config.affiliateOutbound.reconciliationEnabled) return;

  const leaseOwner = `affiliate-reconciliation-${randomUUID()}`;
  const timer = setInterval(() => {
    void runAffiliateReconciliationTick(leaseOwner).catch((err: unknown) => {
      log.general.warn({ err }, '[AffiliateReconciliation] tick failed');
    });
  }, Math.max(60_000, config.affiliateOutbound.reportPollIntervalMs));
  timer.unref?.();
}
