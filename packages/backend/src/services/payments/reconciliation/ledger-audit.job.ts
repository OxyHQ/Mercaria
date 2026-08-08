/**
 * The ledger against itself, and against the payments it describes — issue #50,
 * jobs 5.
 *
 * Three checks, and what unites them is that all three detect an ABSENCE. The
 * repository refuses an unbalanced transaction before issuing SQL, and a
 * `BEFORE UPDATE OR DELETE` trigger refuses an edit afterwards — so nothing that
 * IS in the book can be wrong in these ways. What neither guard can do is notice
 * a transaction that was never written at all, and under ADR 0001 D3 that is the
 * expensive kind of mistake: Mercaria's commission exists nowhere but this
 * ledger, so a missing `charge_succeeded` is revenue with no record anywhere in
 * the world.
 *
 * ## Why the balance check is audited even though it cannot fail
 *
 * `ledger_unbalanced` should be structurally impossible. It is checked on a
 * timer anyway, because "structurally impossible" and "nobody has ever looked"
 * are indistinguishable from outside the code, and this is the cheapest check in
 * the package — one grouped aggregate over one column whose healthy answer is no
 * rows at all. The day somebody adds a second writer to `ledger_entries`, this
 * is what says so.
 *
 * ## The payable check needs a discriminator, not just an aggregate
 *
 * An open `merchant_payable` is ORDINARY. It is credited when a charge succeeds
 * and closed when the transfer settles, so every order in the system passes
 * through the state this check looks for. Two things separate a normal window
 * from a real finding: TIME (the payable has not moved recently) and an
 * EXPLANATION — a withheld transfer or a failed recovery, which is exactly what
 * an open payable MEANS in accounts (#47's withheld transfer, #49's
 * reversal-failure policy).
 *
 * Without the second, this check would report every withheld transfer twice: as
 * an outbox exception, which is where an operator resolves it, and as a
 * discrepancy nobody can close because the condition is correct.
 *
 * The explanation is read from the LIVE rows and NOT from the outbox row that
 * announced it — `payable-explanations.ts` states the two false negatives the
 * announcement version would produce.
 */

import { getDb } from '../../../db/postgres.js';
import {
  findGlobalLedgerImbalances,
  findOpenMerchantPayables,
  paymentsMissingLedgerKind,
} from '../../../db/payments/ledgerRepository.js';
import { findSettledPaymentsForReconciliation } from '../../../db/payments/paymentRepository.js';
import { explainOpenPayable } from './payable-explanations.js';
import { config } from '../../../config/index.js';
import { reportDiscrepancy, resolveDetectedDiscrepancy } from './discrepancy.service.js';
import { listDiscrepanciesOfKind } from '../../../db/payments/discrepancyRepository.js';

/**
 * The rails whose payments MUST have booked a charge.
 *
 * The same set `PROVIDER_BOOKS_LEDGER` marks `true` in `payment.service.ts`, and
 * it is restated rather than imported because that table is private to the state
 * machine — but it is restated as an ASSERTION, not a copy: a rail that books
 * and is missing here would make this audit silently skip it, so the two lists
 * being one line apart in meaning is worth the explicit mention. `external` and
 * `manual_pos` book nothing by design (ADR 0001 D12), so an absent transaction
 * for one of them is correct rather than missing.
 */
const BOOKING_PROVIDERS = ['stripe', 'mock'] as const;

/** What one page of this job did. */
export interface LedgerAuditPageResult {
  /** Payments checked for a missing charge transaction. Zero ends the pass. */
  scanned: number;
  discrepancies: number;
  nextCursor: string | null;
}

/**
 * Run one bounded page of the ledger audit.
 *
 * The two GLOBAL checks (balance, and open payables) run only on the FIRST page
 * of a pass — when the cursor is null. They are aggregates over the whole table
 * rather than a page of it, so running them per page would repeat identical work
 * for every page of the payment scan and produce identical findings each time.
 */
export async function auditLedgerPage(input: {
  cursor: string | null;
  limit: number;
  now?: Date;
}): Promise<LedgerAuditPageResult> {
  const now = input.now ?? new Date();
  const result: LedgerAuditPageResult = { scanned: 0, discrepancies: 0, nextCursor: null };

  if (input.cursor === null) {
    result.discrepancies += await auditGlobalBalance();
    result.discrepancies += await auditOpenPayables({ now, limit: input.limit });
  }

  const audited = await auditMissingChargeTransactions({ cursor: input.cursor, limit: input.limit, now });
  result.scanned = audited.scanned;
  result.discrepancies += audited.discrepancies;
  result.nextCursor = audited.nextCursor;
  return result;
}

/**
 * Every currency's ledger entries must sum to zero, globally.
 *
 * Also RESOLVES its own previous findings, which is unusual in this package and
 * is right for exactly this check: the condition is a single SQL aggregate with
 * no ambiguity, so if a currency no longer appears in the imbalance list then
 * the imbalance is definitively gone. Every other detector reports a state a
 * person has to interpret; this one reports arithmetic.
 */
async function auditGlobalBalance(): Promise<number> {
  const db = getDb();
  const imbalances = await findGlobalLedgerImbalances(db);
  const unbalanced = new Set(imbalances.map((entry) => entry.currency));

  for (const entry of imbalances) {
    await reportDiscrepancy({
      kind: 'ledger_unbalanced',
      provider: 'stripe',
      // The CURRENCY is the whole identity of this finding: the ledger balances
      // per currency (ADR 0001's cross-currency rule), so EUR being out by two
      // cents and USD being out by a dollar are two independent problems.
      correlationKey: entry.currency,
      detail: { currency: entry.currency, totalMinor: entry.totalMinor.toString() },
    });
  }

  // A currency previously reported and no longer imbalanced. Closing it here is
  // safe because the aggregate above IS the condition — see the docblock.
  const previous = await listDiscrepanciesOfKind(db, {
    kind: 'ledger_unbalanced',
    status: ['open', 'acknowledged'],
  });
  for (const row of previous) {
    if (unbalanced.has(row.correlationKey)) continue;
    await resolveDetectedDiscrepancy({
      discrepancyId: row.id,
      reason: 'balance_restored',
      note: `${row.correlationKey} now sums to zero across every ledger entry.`,
    });
  }

  return imbalances.length;
}

/** Orders whose payable is open with no exception accounting for it. */
async function auditOpenPayables(input: { now: Date; limit: number }): Promise<number> {
  const db = getDb();
  // The same buffer the open-payment sweep uses. A payable that moved inside it
  // is a settlement in flight or an operator mid-repair, and neither is a
  // finding.
  const settledBefore = new Date(
    input.now.getTime() - config.payments.reconciliation.openPaymentMinAgeMs,
  );

  const open = await findOpenMerchantPayables(db, { settledBefore, limit: input.limit });
  let discrepancies = 0;

  for (const payable of open) {
    // A withheld transfer or a failed recovery IS what an open payable means in
    // accounts, so either makes the balance correct rather than wrong. Read from
    // the LIVE rows rather than from the outbox announcement — see
    // `payable-explanations.ts` for the two false negatives that would cause.
    if (await explainOpenPayable(db, payable.orderId)) continue;

    await reportDiscrepancy({
      kind: 'merchant_payable_unexplained',
      provider: 'stripe',
      // Per order AND per currency, because the aggregate groups by both and one
      // order can legitimately carry a payable in more than one.
      correlationKey: `${payable.orderId}:${payable.currency}`,
      orderId: payable.orderId,
      detail: {
        currency: payable.currency,
        // NEGATIVE means Mercaria owes the seller; POSITIVE means the seller
        // owes Mercaria (the sign convention: positive is a debit). Both are
        // findings and the sign is what tells an operator which way to look.
        balanceMinor: payable.totalMinor.toString(),
        owed: payable.totalMinor < 0n ? 'seller' : 'mercaria',
        lastMovedAt: payable.lastMovedAt.toISOString(),
      },
    });
    discrepancies += 1;
  }
  return discrepancies;
}

/** Succeeded payments with no `charge_succeeded` transaction behind them. */
async function auditMissingChargeTransactions(input: {
  cursor: string | null;
  limit: number;
  now: Date;
}): Promise<LedgerAuditPageResult> {
  const db = getDb();
  const payments = await findSettledPaymentsForReconciliation(db, {
    providers: BOOKING_PROVIDERS,
    // The same buffer again: a payment that succeeded seconds ago is inside the
    // window where its ledger transaction commits with the status change, and
    // reading it mid-transaction would report a gap that closes itself.
    createdBefore: new Date(
      input.now.getTime() - config.payments.reconciliation.openPaymentMinAgeMs,
    ),
    ...(input.cursor ? { afterId: input.cursor } : {}),
    limit: input.limit,
  });

  const result: LedgerAuditPageResult = {
    scanned: payments.length,
    discrepancies: 0,
    nextCursor: null,
  };
  if (payments.length === 0) return result;

  const missing = await paymentsMissingLedgerKind(db, {
    paymentIds: payments.map((payment) => payment.id),
    kind: 'charge_succeeded',
  });

  for (const payment of payments) {
    if (!missing.has(payment.id)) continue;
    await reportDiscrepancy({
      kind: 'ledger_transaction_missing',
      provider: payment.provider,
      correlationKey: `${payment.id}:charge_succeeded`,
      paymentId: payment.id,
      checkoutGroupId: payment.checkoutGroupId,
      ...(payment.providerObjectId ? { providerObjectId: payment.providerObjectId } : {}),
      detail: {
        expectedKind: 'charge_succeeded',
        paymentStatus: payment.status,
        presentmentAmountMinor: payment.presentmentAmount,
        presentmentCurrency: payment.presentmentCurrency,
      },
    });
    result.discrepancies += 1;
  }

  result.nextCursor =
    payments.length < input.limit ? null : (payments[payments.length - 1]?.id ?? null);
  return result;
}
