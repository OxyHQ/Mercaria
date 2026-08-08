/**
 * The loop that re-reads connected accounts Stripe has not told us about lately.
 *
 * ADR 0001's sequence 6 ends with "periodic reconciliation converges if any
 * webhook was missed", and this is that sentence. A missed `account.updated` is
 * silent by construction — nothing in Mercaria knows an event it never received
 * exists — so the only mechanism that can notice is one that does not depend on
 * having been told.
 *
 * ## Deliberately narrow, because #50 owns reconciliation properly
 *
 * One question, asked on a timer: which accounts have not been read for a while,
 * and what does Stripe say about them now. No dead-letter replay, no drift
 * report, no comparison of Mercaria's ledger against Stripe's balances — those
 * are the reconciliation FRAMEWORK, and building a fraction of it here would
 * leave two half-frameworks to merge.
 *
 * ## No lease, and why that is safe here where the outbox needs one
 *
 * An outbox row is WORK: two tasks running it twice does the thing twice. A sync
 * is an OBSERVATION: two tasks reading the same account concurrently both write
 * what Stripe said, and the repository's compare-and-swap on `last_synced_at`
 * keeps the freshest one. So N tasks running this loop cost N reads of the same
 * account and produce one correct row — wasteful at scale, and the cheap fix
 * when it matters is a larger interval, not a lease protocol for a read.
 *
 * The ordering (oldest first, never-synced ahead of everything) is what stops
 * that waste from becoming starvation: every task walks the same queue from the
 * same end, so they collide on the head rather than spreading over the tail.
 */

import { config } from '../../../config/index.js';
import { getDb } from '../../../db/postgres.js';
import { findStaleProviderAccounts } from '../../../db/payments/providerAccountRepository.js';
import { log } from '../../../lib/logger.js';
import { redactAccountId, syncAccountRow } from './account.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Refresh one batch of stale accounts.
 *
 * Exported for the tests and for an operator triggering it out of band. Each
 * account is synced independently: one seller whose account Stripe refuses to
 * return must not stop the sweep reaching the rest, which is precisely the
 * situation — an account in an odd state — where the sweep matters most.
 *
 * @returns How many accounts were refreshed and how many failed.
 */
export async function reconcileStaleAccounts(options?: {
  batchSize?: number;
  staleAfterMs?: number;
}): Promise<{ refreshed: number; failed: number }> {
  const staleAfterMs = options?.staleAfterMs ?? config.payments.stripe.accountSyncStaleAfterMs;
  const batchSize = options?.batchSize ?? config.payments.stripe.accountSyncBatchSize;

  const rows = await findStaleProviderAccounts(getDb(), {
    provider: 'stripe',
    staleBefore: new Date(Date.now() - staleAfterMs),
    limit: batchSize,
  });

  let refreshed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await syncAccountRow(row);
      refreshed += 1;
    } catch (error: unknown) {
      failed += 1;
      log.general.error(
        {
          err: error,
          accountRowId: row.id,
          providerAccountId: redactAccountId(row.providerAccountId),
        },
        '[Stripe] account reconciliation failed for one account',
      );
    }
  }
  return { refreshed, failed };
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await reconcileStaleAccounts();
    if (result.refreshed > 0 || result.failed > 0) {
      log.general.debug(result, '[Stripe] connected accounts reconciled');
    }
  } catch (error: unknown) {
    // The loop must survive anything one sweep throws, or a single unreadable
    // account stops every account converging for the life of the process.
    log.general.error({ err: error }, '[Stripe] account reconciliation sweep failed');
  } finally {
    running = false;
  }
}

/** Begin reconciling. Idempotent — a second call is a no-op. */
export function startStripeAccountReconciler(): void {
  if (timer !== undefined) return;
  if (!config.payments.stripe.enabled) return;

  timer = setInterval(() => {
    void tick();
  }, config.payments.stripe.accountSyncIntervalMs);
  // Never hold the event loop open for the poll — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info(
    {
      intervalMs: config.payments.stripe.accountSyncIntervalMs,
      batchSize: config.payments.stripe.accountSyncBatchSize,
      staleAfterMs: config.payments.stripe.accountSyncStaleAfterMs,
    },
    '[Stripe] connected-account reconciler started',
  );
}

/**
 * Stop sweeping.
 *
 * The account already in flight finishes — it is a read followed by a
 * compare-and-swap, so interrupting it would save milliseconds and risk a write
 * landing after the process claimed to have stopped.
 */
export function stopStripeAccountReconciler(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
