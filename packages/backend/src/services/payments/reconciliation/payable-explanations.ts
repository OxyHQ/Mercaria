/**
 * Whether an order's open `merchant_payable` is EXPLAINED.
 *
 * The discriminator behind `merchant_payable_unexplained` (#50, jobs 5(c)), and
 * the one piece of that audit that could not be a single aggregate: an open
 * payable is ORDINARY whenever the seller genuinely has not been paid, or has
 * not paid Mercaria back, and both of those are states elsewhere in the domain.
 *
 * ## It reads the CURRENT state, never the announcement
 *
 * The tempting version asks `payment_outboxes` whether a `transfer_withheld` or
 * `reversal_failed` row exists for the order. That is wrong twice, and both ways
 * produce a FALSE NEGATIVE in exactly the case this audit exists for:
 *
 *  - An outbox row ANNOUNCES something that happened and is never deleted when
 *    the condition is fixed. An order whose withheld transfer was later repaired
 *    keeps its row forever, so a genuinely new payable problem on that same
 *    order would be suppressed by a resolved one.
 *  - `payment_outboxes` is SWEPT at 14 days, so that suppression would also be
 *    time-bounded — the same order explained for a fortnight and unexplained
 *    afterwards, with nothing having changed.
 *
 * Reading the live rows has neither problem. A withheld transfer stops being
 * withheld the moment it carries a provider object; a failed reversal stops
 * being failed the moment one succeeds. The explanation appears and disappears
 * with the condition, which is what an explanation should do.
 *
 * It lives here rather than in a repository for the reason `metrics-queries.ts`
 * does: it spans the payment domain and the order domain, and it is a question
 * only reconciliation asks.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { disputes, transfers } from '../../../db/schema/payments.js';
import { refunds } from '../../../db/schema/orders.js';
import type { DatabaseOrTransaction } from '../../../db/postgres.js';

/**
 * Does anything in the domain account for this order's payable being open?
 *
 * Called per CANDIDATE, against a bounded page of genuinely open payables — so
 * three indexed single-row probes rather than one composite query, which reads
 * as what it is and lets each stop at the first hit.
 *
 * @returns The explanation, or `undefined` when there is none — which IS the
 *   finding. The string is safe to render: it names a state, never a payload.
 */
export async function explainOpenPayable(
  db: DatabaseOrTransaction,
  orderId: string,
): Promise<string | undefined> {
  // ADR 0001 D4's withheld transfer. `provider_object_id IS NULL` is the durable
  // statement of it: the row exists because settlement ran, and carries no rail
  // object because the rail was never asked or refused.
  const [withheld] = await db
    .select({ id: transfers.id })
    .from(transfers)
    .where(and(eq(transfers.orderId, orderId), isNull(transfers.providerObjectId)))
    .limit(1);
  if (withheld) {
    return 'a transfer for this order is withheld, so the seller has not been paid';
  }

  // #49's reversal-failure policy: the buyer has their money and the seller's
  // share could not be recovered, so the payable sits in DEBIT by exactly that.
  const [refundGap] = await db
    .select({ id: refunds.id })
    .from(refunds)
    .where(and(eq(refunds.orderId, orderId), eq(refunds.reversalState, 'failed')))
    .limit(1);
  if (refundGap) {
    return "a refund reversal for this order failed, so the seller's share was never recovered";
  }

  const [disputeGap] = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(and(eq(disputes.orderId, orderId), eq(disputes.recoveryState, 'failed')))
    .limit(1);
  if (disputeGap) {
    return 'a lost dispute for this order could not be recovered from the seller';
  }

  return undefined;
}
