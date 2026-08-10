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

/** One pass: re-read what the rail says, then catch the audit trail up. */
async function runOnce(): Promise<void> {
  const reconciled = await reconcileMerchantSubscriptions();
  const grace = await announceExpiredGracePeriods();
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
  timer = setInterval(() => {
    void runOnce().catch((err) =>
      log.general.error({ err }, '[MerchantBilling] a reconciliation pass failed'),
    );
  }, config.merchantBilling.reconciliationIntervalMs);
  timer.unref?.();
}

/** Stop the loop. Test support and graceful shutdown. */
export function stopMerchantSubscriptionReconciler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
