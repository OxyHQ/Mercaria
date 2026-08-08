/**
 * The payment domain's operational numbers — issue #50, metrics 1 to 8.
 *
 * ## No metrics infrastructure, deliberately
 *
 * A JSON endpoint and structured logs, and no prometheus client, no registry, no
 * exporter. Three reasons, in order of weight:
 *
 * 1. Mercaria's ECS tasks are behind an ALB with no scrape path, so a
 *    `/metrics` endpoint in the prometheus text format would be a format nothing
 *    in this account can read.
 * 2. Every number below is an aggregate over a table that is already indexed
 *    for it. A counter library would add a second, in-memory copy of facts the
 *    database already holds authoritatively — and the two would disagree after
 *    every restart, with the in-memory one being the wrong one.
 * 3. Scraping and alerting are `oxy-infra`'s (see `docs/payments.md`). Wiring an
 *    exporter here would put half of that decision in the wrong repository.
 *
 * The one number that CANNOT come from a table is the ledger-imbalance counter,
 * and it is process-local for a reason stated at its own definition: the write
 * it counts is one that rolls back.
 *
 * ## Everything here is a COUNT
 *
 * No amounts, no ids, no currencies attached to a party. Issue #50 requires that
 * metrics carry no raw email, address, token or payment-method data, and the
 * cheapest way to guarantee that is a surface whose values are all integers and
 * whose dimensions are all closed enum sets. The one exception is the timestamps
 * — an oldest-open instant is not personal data and is the field that turns a
 * count into a decision.
 */

import { getDb } from '../../../db/postgres.js';
import { config } from '../../../config/index.js';
import {
  paymentCountsByStatus,
  payoutCountsByStatus,
  transferCountsByStatus,
} from '../../../db/payments/paymentRepository.js';
import { paymentOutboxCounts } from '../../../db/payments/paymentOutboxRepository.js';
import {
  discrepancyStats,
  type DiscrepancyStats,
} from '../../../db/payments/discrepancyRepository.js';
import { listReconciliationCursors } from '../../../db/payments/reconciliationCursorRepository.js';
import { ledgerImbalanceAttempts } from '../../../db/payments/ledgerRepository.js';
import { countRefundsByProviderState, countDisputesByState } from './metrics-queries.js';
import type { ProviderEventStats } from '../../../db/payments/paymentRepository.js';

/** The whole operator metrics payload. */
export interface PaymentMetrics {
  /** Metric 1: payment counts by provider, currency and status. */
  payments: { provider: string; currency: string; status: string; count: number }[];
  /**
   * Metrics 2 and 3: inbound event queue depth, processing lag and dead letters.
   *
   * Reused verbatim from #48's `stripeWebhookStats` — the same figures `/health`
   * reports, so an operator comparing the two is never looking at two
   * definitions of "lag". Absent when the rail is not configured.
   */
  webhooks?: ProviderEventStats;
  /**
   * Metric 4, and the outbox's own health beside it. `payment_succeeded_after_release`
   * is the late-success count and `transfer_withheld` the reservation-side one;
   * both are outbox event types, so they are dimensions here rather than
   * bespoke counters.
   */
  outbox: { eventType: string; status: string; count: number }[];
  /** Metric 5: reconciliation mismatch counts and the age of the oldest. */
  reconciliation: DiscrepancyStats & {
    /** Where each sweep stands. A stale `lastCompletedAt` is the alert. */
    cursors: {
      job: string;
      lastRunAt: string | null;
      lastCompletedAt: string | null;
      inFlight: boolean;
      lastError: string | null;
    }[];
  };
  /** Metric 6: refund money-state counts and dispute counts. */
  refunds: { providerState: string; count: number }[];
  disputes: { state: string; count: number }[];
  /** Metric 7: transfer and payout counts by status. */
  transfers: { status: string; count: number }[];
  payouts: { status: string; count: number }[];
  /**
   * Metric 8: ledger imbalance attempts. **This must stay zero.**
   *
   * Process-local and per task — see `ledgerImbalanceAttempts`. A non-zero
   * reading is a posting builder producing entries that do not balance, which
   * means a money movement has no accounting at all.
   */
  ledgerImbalanceAttempts: number;
}

/**
 * Collect every number, in parallel.
 *
 * One round of independent aggregates rather than a sequence: they touch
 * different tables and none depends on another, so the endpoint costs one
 * round trip's latency instead of eight.
 */
export async function collectPaymentMetrics(): Promise<PaymentMetrics> {
  const db = getDb();

  const [payments, outbox, reconciliation, cursors, refunds, disputes, transfers, payouts] =
    await Promise.all([
      paymentCountsByStatus(db),
      paymentOutboxCounts(db),
      discrepancyStats(db),
      listReconciliationCursors(db),
      countRefundsByProviderState(db),
      countDisputesByState(db),
      transferCountsByStatus(db),
      payoutCountsByStatus(db),
    ]);

  return {
    payments: payments.map((row) => ({
      provider: row.provider,
      currency: row.currency,
      status: row.status,
      count: row.total,
    })),
    ...(await webhookStats()),
    outbox: outbox.map((row) => ({
      eventType: row.eventType,
      status: row.status,
      count: row.total,
    })),
    reconciliation: {
      ...reconciliation,
      cursors: cursors.map((row) => ({
        job: row.id,
        lastRunAt: row.lastRunAt?.toISOString() ?? null,
        lastCompletedAt: row.lastCompletedAt?.toISOString() ?? null,
        // A live lease means a sweep is running RIGHT NOW. Reported rather than
        // the owner id, which names a task nobody can act on.
        inFlight: row.leaseUntil !== null && row.leaseUntil.getTime() > Date.now(),
        lastError: row.lastError,
      })),
    },
    refunds: refunds.map((row) => ({ providerState: row.providerState, count: row.total })),
    disputes: disputes.map((row) => ({ state: row.state, count: row.total })),
    transfers: transfers.map((row) => ({ status: row.status, count: row.total })),
    payouts: payouts.map((row) => ({ status: row.status, count: row.total })),
    ledgerImbalanceAttempts: ledgerImbalanceAttempts(),
  };
}

/**
 * The inbound event queue's figures, or nothing.
 *
 * Absent rather than zeroed when the rail is off: a deployment with no Stripe
 * has no inbound stream, and reporting `pending: 0` for a queue that does not
 * exist would make a dashboard say the integration is healthy.
 */
async function webhookStats(): Promise<{ webhooks?: ProviderEventStats }> {
  if (!config.payments.stripe.enabled) return {};
  const { stripeWebhookStats } = await import('../stripe/event-processor.js');
  return { webhooks: await stripeWebhookStats() };
}
