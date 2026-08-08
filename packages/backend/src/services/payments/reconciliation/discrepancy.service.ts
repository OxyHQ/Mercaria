/**
 * Recording what a sweep found, and how loudly.
 *
 * Thin over `db/payments/discrepancyRepository`, and it exists for exactly two
 * things the repository must not own: the severity TABLE, and the log line.
 *
 * ## Severity is a table, not an argument
 *
 * Every detector could pass its own severity, and within a week two of them
 * would disagree about the same kind. It is a property of the KIND — "money is
 * wrong now" versus "money will be wrong if nobody acts" — so it is decided once
 * here, beside the reasoning, and a detector cannot get it wrong because it is
 * never asked.
 *
 * ## Only a NEW finding is logged, and that is the whole point of the dedupe
 *
 * A sweep runs every few minutes and re-derives the same unresolved findings
 * every time. Logging each sighting would make the log a worse copy of the queue
 * and would bury the one line that matters — a critical discrepancy appearing
 * for the first time — under its own repetitions. So the log fires on creation
 * only, and the queue is what says a problem is still true.
 */

import type {
  PaymentDiscrepancyKind,
  PaymentDiscrepancySeverity,
  PaymentProviderId,
} from '@mercaria/shared-types';
import { getDb } from '../../../db/postgres.js';
import {
  recordDiscrepancy,
  resolveDiscrepancyAutomatically,
  type PaymentDiscrepancyRow,
} from '../../../db/payments/discrepancyRepository.js';
import { log } from '../../../lib/logger.js';

/**
 * How loudly each kind asks to be looked at.
 *
 * `critical` is money that is wrong NOW: a charge nobody can attribute, a
 * payment Mercaria believes in and the rail does not, an amount that does not
 * match, a ledger that does not balance, a commission that exists nowhere.
 *
 * `warning` is money that will be wrong if nobody acts: an object Mercaria has
 * no row for (the money is where the rail says, but no Mercaria surface can
 * explain it), a payable nothing accounts for, a seller whose readiness lagged.
 *
 * `info` is a record kept because its absence would be worse than its noise. A
 * payout Mercaria has no row for is the only one: Mercaria is not a party to a
 * payout (ADR 0001 D6) and books nothing for it, so a missing row costs a
 * dashboard line and no money at all — but a seller asking why their payout is
 * not shown needs somebody to be able to answer.
 *
 * A `Record` over the union rather than a lookup with a default, so adding a
 * kind to `PAYMENT_DISCREPANCY_KINDS` and forgetting its severity does not
 * compile.
 */
const SEVERITY: Record<PaymentDiscrepancyKind, PaymentDiscrepancySeverity> = {
  payment_provider_paid_local_unpaid: 'critical',
  payment_local_paid_provider_unpaid: 'critical',
  payment_missing_locally: 'critical',
  payment_amount_mismatch: 'critical',
  transfer_missing_locally: 'warning',
  transfer_amount_mismatch: 'critical',
  refund_missing_locally: 'warning',
  refund_amount_mismatch: 'critical',
  payout_missing_locally: 'info',
  ledger_transaction_missing: 'critical',
  ledger_unbalanced: 'critical',
  merchant_payable_unexplained: 'warning',
  account_state_drift: 'warning',
  account_sync_failed: 'warning',
};

/** What a detector reports. Severity is not among the fields — see the docblock. */
export interface DiscrepancyReport {
  kind: PaymentDiscrepancyKind;
  provider: PaymentProviderId;
  /** Composed from durable ids only. A clock here defeats the dedupe silently. */
  correlationKey: string;
  paymentId?: string;
  orderId?: string;
  checkoutGroupId?: string;
  providerObjectId?: string;
  /** Mercaria's own ids, amounts, currencies and statuses. Never a rail payload. */
  detail: Record<string, unknown>;
}

/**
 * Record a finding, or note that a known one is still true.
 *
 * @returns The row as it now stands. Callers that go on to CONVERGE the
 *   condition need it, so they can resolve the row they just opened rather than
 *   leaving an operator to close something the system has already fixed.
 */
export async function reportDiscrepancy(
  report: DiscrepancyReport,
): Promise<PaymentDiscrepancyRow> {
  const severity = SEVERITY[report.kind];
  const { row, created } = await recordDiscrepancy(getDb(), { ...report, severity });

  if (created) {
    const context = {
      discrepancyId: row.id,
      kind: report.kind,
      severity,
      correlationKey: report.correlationKey,
      paymentId: report.paymentId,
      orderId: report.orderId,
      providerObjectId: report.providerObjectId,
    };
    // A `critical` finding is money that is wrong now and needs a person, so it
    // must not be discoverable only in a warn-level line — the same rule the
    // outbox's dead letters follow.
    if (severity === 'critical') {
      log.general.error(context, '[Reconciliation] discrepancy detected');
    } else {
      log.general.warn(context, '[Reconciliation] discrepancy detected');
    }
  }
  return row;
}

/**
 * Close a discrepancy the sweep has itself satisfied is gone.
 *
 * Only ever called with the evidence in hand — a live provider read that
 * converged, or an aggregate that now nets to zero. Never on a timer and never
 * because a row is old: an unresolved discrepancy that ages is not a resolved
 * one, and a queue that quietened itself would be the most dangerous possible
 * version of this feature.
 *
 * It will not overwrite a PERSON's resolution (the repository's own guard). An
 * operator who has already closed a row decided something; a sweep agreeing with
 * them later is not a reason to restate it in the machine's name.
 */
export async function resolveDetectedDiscrepancy(input: {
  discrepancyId: string;
  reason: string;
  note?: string;
}): Promise<void> {
  const resolved = await resolveDiscrepancyAutomatically(getDb(), input);
  if (resolved) {
    log.general.info(
      { discrepancyId: input.discrepancyId, reason: input.reason },
      '[Reconciliation] discrepancy resolved by the sweep that raised it',
    );
  }
}
