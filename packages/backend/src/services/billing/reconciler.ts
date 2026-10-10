/**
 * The merchant-subscription reconciliation loop (#89 billing rule 7).
 *
 * Two things run on a timer here and they answer different questions:
 *
 *  - **Re-read subscriptions from the rail.** Webhooks are the normal event path
 *    and are NOT a substitute — an event that was never delivered is invisible
 *    to everything that waits to be told (#50's opening sentence, applied one
 *    domain over).
 *  - **Announce grace periods that have run out.** This changes nothing: the
 *    resolver stops entitling at the deadline whether or not the sweep has run,
 *    so what it adds is the audit row, not the effect.
 *
 * Started on EVERY task, like the other dispatchers, because both actions are
 * idempotent — a re-read that finds nothing new writes nothing, and the grace
 * announcement is guarded by the trail it appends to. A leader would only add a
 * way for nobody to run it at all.
 *
 * The timer calls `.unref?.()` immediately, so a module-level interval cannot
 * keep the event loop alive and hang a test run (`~/Oxy/AGENTS.md`).
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import {
  announceExpiredGracePeriods,
  reconcileMerchantSubscriptions,
} from './subscription.service.js';

let timer: ReturnType<typeof setInterval> | undefined;
let afterId: string | undefined;
let graceAfterId: string | undefined;
let generation = 0;
let inFlight = false;

/** One bounded page per pass, then catch the audit trail up. */
async function runOnce(startedGeneration: number): Promise<void> {
  const reconciled = await reconcileMerchantSubscriptions({ afterId });
  if (startedGeneration !== generation) return;
  afterId = reconciled.nextAfterId ?? undefined;
  const grace = await announceExpiredGracePeriods({ afterId: graceAfterId });
  if (startedGeneration !== generation) return;
  graceAfterId = grace.nextAfterId ?? undefined;
  if (reconciled.applied > 0 || reconciled.failed > 0 || grace.announced > 0) {
    log.general.info(
      { ...reconciled, graceAnnounced: grace.announced },
      '[MerchantBilling] subscription reconciliation pass',
    );
  }
}

/**
 * Start the loop, unless this deployment has it switched off.
 *
 * The flag gates the LOOP and nothing durable: a subscription still applies
 * every webhook, still books every invoice and still stops entitling when its
 * grace expires with this off.
 */
export function startMerchantSubscriptionReconciler(): void {
  if (timer) return;
  if (!config.merchantBilling.reconciliationEnabled) {
    log.general.info(
      {},
      '[MerchantBilling] subscription reconciliation is off; webhooks and grace deadlines are unaffected',
    );
    return;
  }
  afterId = undefined;
  graceAfterId = undefined;
  const startedGeneration = ++generation;
  timer = setInterval(() => {
    // A slow provider must not overlap pages or let an old pass reset a new cursor.
    if (inFlight) return;
    inFlight = true;
    void runOnce(startedGeneration)
      .catch((err) => log.general.error({ err }, '[MerchantBilling] a reconciliation pass failed'))
      .finally(() => {
        inFlight = false;
      });
  }, config.merchantBilling.reconciliationIntervalMs);
  timer.unref?.();
}

/** Stop the loop. Test support and graceful shutdown. */
export function stopMerchantSubscriptionReconciler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
  afterId = undefined;
  graceAfterId = undefined;
  generation += 1;
}
