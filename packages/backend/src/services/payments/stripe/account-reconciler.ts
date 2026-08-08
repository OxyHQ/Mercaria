/**
 * The loop that re-reads connected accounts Stripe has not told us about lately.
 *
 * ADR 0001's sequence 6 ends with "periodic reconciliation converges if any
 * webhook was missed", and this is that sentence. A missed `account.updated` is
 * silent by construction — nothing in Mercaria knows an event it never received
 * exists — so the only mechanism that can notice is one that does not depend on
 * having been told.
 *
 * ## Deliberately narrow, and #50 REUSES it rather than replacing it
 *
 * One question, asked on a timer: which accounts have not been read for a while,
 * and what does Stripe say about them now. No dead-letter replay, no ledger
 * comparison — those are the reconciliation FRAMEWORK, and building a fraction
 * of them here would have left two half-frameworks to merge.
 *
 * That framework arrived with #50, and this loop is what its `account_readiness`
 * job runs (issue #50, jobs 6). The only thing that changed is the RETURN: the
 * sweep now reports which accounts failed and which ones DRIFTED, so #50 can
 * turn both into discrepancy rows. It still owns the timer, the ordering and the
 * lease-free argument below — duplicating any of that in the reconciliation
 * package would have been the second half-framework by another route.
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
 * What one sweep observed, per account it could not simply confirm.
 *
 * #50 needs the DETAIL this used to throw away. Two counters answer "did the
 * sweep run"; they cannot answer "which seller is stuck" or "which readiness
 * change did a webhook never deliver", and both of those are discrepancies with
 * an operator action behind them (issue #50, jobs 6).
 *
 * Returned rather than pushed through a callback, deliberately: a callback would
 * make this module import the discrepancy recorder, and #46's reconciler knowing
 * about #50's queue is the coupling that turns a narrow, well-understood sweep
 * into the framework it explicitly refused to become.
 */
export interface AccountReconciliationObservation {
  accountRowId: string;
  /** Already redacted to its last four characters — never the full account id. */
  providerAccountId: string;
  ownerType: string;
  ownerId: string;
  /** Set when the rail refused the read. The row was left exactly as it was. */
  error?: string;
  /**
   * Set when the re-read MOVED the stored state — which means an
   * `account.updated` was never delivered, and the seller's readiness has been
   * silently wrong for up to `STRIPE_ACCOUNT_SYNC_STALE_AFTER_MS`.
   */
  drift?: { from: string; to: string };
}

/** What one sweep did. */
export interface AccountReconciliationResult {
  refreshed: number;
  failed: number;
  /** Only the accounts that failed or drifted — a quiet sweep returns none. */
  observations: AccountReconciliationObservation[];
}

/**
 * Refresh one batch of stale accounts.
 *
 * Exported for the tests, for #50's `account_readiness` job and for an operator
 * triggering it out of band. Each account is synced independently: one seller
 * whose account Stripe refuses to return must not stop the sweep reaching the
 * rest, which is precisely the situation — an account in an odd state — where
 * the sweep matters most.
 */
export async function reconcileStaleAccounts(options?: {
  batchSize?: number;
  staleAfterMs?: number;
}): Promise<AccountReconciliationResult> {
  const staleAfterMs = options?.staleAfterMs ?? config.payments.stripe.accountSyncStaleAfterMs;
  const batchSize = options?.batchSize ?? config.payments.stripe.accountSyncBatchSize;

  const rows = await findStaleProviderAccounts(getDb(), {
    provider: 'stripe',
    staleBefore: new Date(Date.now() - staleAfterMs),
    limit: batchSize,
  });

  let refreshed = 0;
  let failed = 0;
  const observations: AccountReconciliationObservation[] = [];
  for (const row of rows) {
    const identity = {
      accountRowId: row.id,
      providerAccountId: redactAccountId(row.providerAccountId),
      ownerType: row.ownerType,
      ownerId: row.ownerId,
    };
    try {
      const synced = await syncAccountRow(row);
      refreshed += 1;
      // The state MOVED on a plain re-read, so nothing told Mercaria about it.
      // Worth reporting even though the sweep has already corrected it: a
      // correction here means a webhook was lost, and a seller whose readiness
      // lagged is a seller who silently could not be sold through.
      if (synced.onboardingState !== row.onboardingState) {
        observations.push({
          ...identity,
          drift: { from: row.onboardingState, to: synced.onboardingState },
        });
      }
    } catch (error: unknown) {
      failed += 1;
      observations.push({
        ...identity,
        error: error instanceof Error ? error.message : String(error),
      });
      log.general.error(
        { err: error, ...identity },
        '[Stripe] account reconciliation failed for one account',
      );
    }
  }
  return { refreshed, failed, observations };
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await reconcileStaleAccounts();
    if (result.refreshed > 0 || result.failed > 0) {
      // Counts only. The observations are per-account detail and belong in #50's
      // discrepancy queue, where they are deduped and can be resolved — a log
      // line repeating them every fifteen minutes is the noise that queue exists
      // to replace.
      log.general.debug(
        { refreshed: result.refreshed, failed: result.failed },
        '[Stripe] connected accounts reconciled',
      );
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
