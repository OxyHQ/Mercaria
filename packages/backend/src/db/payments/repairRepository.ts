/**
 * `payment_repairs` — the append-only record of every operator action.
 *
 * One INSERT and two reads, and no update at all. That is the table's contract
 * (`CONVENTIONS.md`: the absence of `updated_at` IS the append-only contract),
 * and it is why a repair that was refused and then re-run is two rows rather
 * than one row that forgot the refusal.
 *
 * ## The insert is sometimes the CLAIM, and the caller decides when
 *
 * `recordRepair` takes a `DatabaseOrTransaction` for the same reason
 * `insertLedgerTransaction` does: `book_reconciling_entry` must write its audit
 * row and its ledger transaction TOGETHER, because the partial unique index on
 * `(action, subject_key) WHERE action = 'book_reconciling_entry' AND outcome =
 * 'applied'` is the only thing stopping a correcting entry being booked twice.
 * Committed separately, a crash between them would leave either a correction
 * nothing recorded or a claim on a correction that never happened.
 *
 * The three retry actions pass a plain handle: their idempotency lives in the
 * provider keys their services derive (ADR 0001 D11), so their audit row is
 * evidence rather than a claim, and holding a transaction open across a network
 * call to a payment rail is exactly what nothing here should do.
 */

import { desc, eq } from 'drizzle-orm';
import type { PaymentRepairAction, PaymentRepairOutcome } from '@mercaria/shared-types';
import { paymentRepairs } from '../schema/reconciliation.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One row of `payment_repairs`. */
export type PaymentRepairRow = typeof paymentRepairs.$inferSelect;

/** What one attempt was, and what it did. */
export interface RecordRepairInput {
  action: PaymentRepairAction;
  /** Composed per action from durable Mercaria ids — see the schema docblock. */
  subjectKey: string;
  discrepancyId?: string;
  actorOxyUserId: string;
  reason: string;
  outcome: PaymentRepairOutcome;
  /** Ids, amounts and currencies the services reported. Never a request payload. */
  detail: Record<string, unknown>;
  paymentId?: string;
  orderId?: string;
  ledgerTransactionId?: string;
}

/**
 * Append one attempt.
 *
 * @throws When `book_reconciling_entry` has already been APPLIED for this
 *   subject. The partial unique index raises, and the caller — which is holding
 *   the ledger insert in the same transaction — lets the whole thing roll back
 *   and reports `no_op`. That is the correct outcome: the correction the
 *   operator asked for is already in the book.
 */
export async function recordRepair(
  db: DatabaseOrTransaction,
  input: RecordRepairInput,
): Promise<PaymentRepairRow> {
  const [row] = await db
    .insert(paymentRepairs)
    .values({
      action: input.action,
      subjectKey: input.subjectKey,
      actorOxyUserId: input.actorOxyUserId,
      reason: input.reason,
      outcome: input.outcome,
      detail: input.detail,
      ...(input.discrepancyId ? { discrepancyId: input.discrepancyId } : {}),
      ...(input.paymentId ? { paymentId: input.paymentId } : {}),
      ...(input.orderId ? { orderId: input.orderId } : {}),
      ...(input.ledgerTransactionId ? { ledgerTransactionId: input.ledgerTransactionId } : {}),
    })
    .returning();
  if (!row) {
    throw new Error(`Recording a '${input.action}' repair for '${input.subjectKey}' returned no row.`);
  }
  return row;
}

/** Never return more than this, whatever a caller asks for. */
const MAX_REPAIR_PAGE = 100;

/** Every attempt against one discrepancy, newest first. */
export async function listRepairsForDiscrepancy(
  db: DatabaseOrTransaction,
  discrepancyId: string,
  limit = 20,
): Promise<PaymentRepairRow[]> {
  return await db
    .select()
    .from(paymentRepairs)
    .where(eq(paymentRepairs.discrepancyId, discrepancyId))
    .orderBy(desc(paymentRepairs.createdAt))
    .limit(Math.min(Math.max(1, limit), MAX_REPAIR_PAGE));
}

/**
 * Every attempt against one payment, newest first.
 *
 * The trace's own read. A repair naming no payment (a correcting entry booked
 * against a discrepancy that has none) is deliberately invisible here — it is
 * reachable from its discrepancy, which is the record it belongs to.
 */
export async function listRepairsForPayment(
  db: DatabaseOrTransaction,
  paymentId: string,
  limit = 20,
): Promise<PaymentRepairRow[]> {
  return await db
    .select()
    .from(paymentRepairs)
    .where(eq(paymentRepairs.paymentId, paymentId))
    .orderBy(desc(paymentRepairs.createdAt))
    .limit(Math.min(Math.max(1, limit), MAX_REPAIR_PAGE));
}
