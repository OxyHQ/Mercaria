/**
 * Turning a recognized surplus into money the buyer actually has (#128
 * "Customer adjustment path").
 *
 * ## It calls no rail, and that is the same rule every refund in this codebase
 * follows
 *
 * `refund.service` decides what is refundable and commits the commerce record;
 * `refund-execution.service` moves the money from a `payment_refunded` outbox
 * row (ADR 0001 D7). This module writes the refund and the outbox row in ONE
 * transaction and stops. A provider call living in the request that created the
 * obligation would evaporate on a restart, leaving a record claiming money went
 * back to a buyer who never received it.
 *
 * ## Nothing is restocked, and that is not an omission
 *
 * #128 item 6. A price adjustment is money moving, not goods: the buyer keeps
 * what they bought. `restockedAt` is deliberately left NULL rather than stamped
 * — stamping it would tell a merchant surface that units returned to a shelf,
 * and the refund is written with NO line items at all, so there is nothing for a
 * restock to act on even if somebody added one later.
 *
 * ## A duplicate refund is impossible in three independent places
 *
 * #128 item 7. The adjustment's `UNIQUE(reconciliation_id)` means one obligation
 * per revision; `attachAdjustmentRefund` is a compare-and-swap that refuses a
 * second refund on an obligation that already has one; and the refund itself
 * carries a DERIVED idempotency key, so `refund.service`'s own claim converges a
 * retry that got past both.
 *
 * ## Guest and authenticated buyers get the same rights
 *
 * #128 acceptance 9, and it is an absence: nothing in this file reads a buyer
 * origin, a guest session or an Oxy account. The obligation is keyed on the
 * ORDER, the refund goes back down the original rail, and the only thing that
 * differs is which channel the notification takes — which is #108's decision,
 * made in `notifications.ts`, and not a difference in what is owed.
 */

import { isUniqueViolation } from '@oxyhq/db';
import { getDb } from '../../db/postgres.js';
import { insertLedgerTransaction } from '../../db/payments/ledgerRepository.js';
import { findPaymentById } from '../../db/payments/paymentRepository.js';
import { insertRefund } from '../../db/orders/refundRepository.js';
import {
  attachAdjustmentRefund,
  findRetailCustomerAdjustment,
  setAdjustmentState,
  type RetailCustomerAdjustmentRow,
} from '../../db/retailReconciliation/adjustmentRepository.js';
import { raiseReconciliationException } from '../../db/retailReconciliation/exceptionRepository.js';
import {
  claimLedgerRecognition,
  isLedgerRecognitionClaimed,
} from '../../db/retailReconciliation/supplierCreditRepository.js';
import { findReconcilableOrder } from '../../db/retailReconciliation/evidenceSourceRepository.js';
import { customerAdjustmentRefunded } from '../payments/ledger-postings.js';
import { enqueuePaymentEvent, paymentRefundedEventId } from '../payments/payment-outbox.service.js';
import { log } from '../../lib/logger.js';
import { notifyRetailCostAdjustment } from './notifications.js';

/** What one attempt to pay an obligation did. */
export interface AdjustmentSettlementOutcome {
  /** The obligation as it now stands. */
  adjustment: RetailCustomerAdjustmentRow;
  /** The refund this attempt committed, when it committed one. */
  refundId?: string;
  /** Why the rail was not used, when it was not. */
  blocked?: string;
}

/**
 * `retail-adjustment:<adjustmentId>` — the refund's idempotency key.
 *
 * Derived from the OBLIGATION and never from the attempt, so an operator retry,
 * a redelivered sweep and a concurrent pass all converge on one refund. The
 * obligation is itself unique per reconciliation revision, so the chain from
 * "this revision found this surplus" to "this refund paid it" has no step at
 * which a second row could appear.
 */
export function adjustmentRefundIdempotencyKey(adjustmentId: string): string {
  return `retail-adjustment:${adjustmentId}`;
}

/**
 * Pay one recognized adjustment, if it can be paid.
 *
 * Idempotent at every step: an obligation that already has a refund returns it,
 * an obligation the rail cannot serve is moved to `payable_recorded` with a
 * reason an operator can act on, and a settled one is returned untouched.
 */
export async function settleRetailCustomerAdjustment(input: {
  adjustmentId: string;
  now?: Date;
}): Promise<AdjustmentSettlementOutcome | undefined> {
  const now = input.now ?? new Date();
  const db = getDb();

  const adjustment = await findRetailCustomerAdjustment(input.adjustmentId, db);
  if (!adjustment) return undefined;
  if (adjustment.state === 'refund_settled' || adjustment.state === 'closed_at_finality') {
    return { adjustment };
  }
  if (adjustment.refundId) {
    // The commerce record has already committed and the rail is #49's to drive.
    // Re-committing would be a second refund for one obligation.
    return { adjustment, refundId: adjustment.refundId };
  }
  if (adjustment.supersededById) {
    // A later revision replaced this obligation with a different figure. Paying
    // the superseded one would pay a surplus the evidence no longer supports.
    return { adjustment, blocked: 'superseded_by_a_later_revision' };
  }

  const order = await findReconcilableOrder(adjustment.orderId, db);
  if (!order) return { adjustment, blocked: 'order_not_found' };

  const blocked = await refundBlockReason({ order, adjustment });
  if (blocked) {
    const moved = await setAdjustmentState(
      {
        id: adjustment.id,
        state: 'payable_recorded',
        from: ['owed', 'refund_failed', 'payable_recorded'],
        method: 'recorded_payable',
        blockReason: blocked,
      },
      db,
    );
    log.general.info(
      { adjustmentId: adjustment.id, orderId: adjustment.orderId, blocked },
      '[RetailReconciliation] adjustment recorded as a payable; the rail could not serve it',
    );
    return { adjustment: moved ?? adjustment, blocked };
  }

  const paymentId = order.paymentId;
  if (!paymentId) return { adjustment, blocked: 'payment_not_settled' };

  // The commerce record and its outbox row commit together (#49). The ledger
  // posting that closes the liability goes in the SAME transaction: the
  // obligation and the accounting for it must not be able to disagree, and a
  // separate transaction is exactly the window in which they would.
  try {
    const refundId = await db.transaction(async (tx) => {
      const refund = await insertRefund(
        {
          orderId: adjustment.orderId,
          type: 'refund',
          // `refunded` is the commerce lifecycle's committed state (#49): the
          // obligation is decided and the money's own state lives on
          // `providerState`.
          status: 'refunded',
          reason:
            'Cost reconciliation: the order cost less to fulfil than the buyer was charged.',
          // NO line items and NO restock: a price adjustment moves money, not
          // goods (#128 item 6).
          lineItems: [],
          totalRefunded: {
            shop: {
              amount: adjustment.adjustmentAmount,
              currency: adjustment.adjustmentCurrency,
            },
            presentment: {
              amount: adjustment.adjustmentAmount,
              currency: adjustment.adjustmentCurrency,
            },
          },
          idempotencyKey: adjustmentRefundIdempotencyKey(adjustment.id),
          // The provider operation is written AT INSERT and always as pending,
          // so the row and the promise that its money will move commit
          // together — a task dying before it calls the rail leaves a refund
          // that is visibly unfinished rather than one that silently never had
          // a provider side.
          providerOperation: { provider: 'stripe', paymentId },
        },
        tx,
      );

      const attached = await attachAdjustmentRefund({ id: adjustment.id, refundId: refund.id }, tx);
      if (!attached) {
        // A concurrent attempt attached a refund between the read above and
        // here. Rolling back discards this one rather than leaving two refunds
        // for one obligation.
        throw new Error(
          `Adjustment ${adjustment.id} acquired a refund concurrently; discarding this attempt.`,
        );
      }

      const held = await isLedgerRecognitionClaimed(
        { kind: 'adjustment_refunded', claimKey: adjustment.id },
        tx,
      );
      if (!held) {
        const posting = customerAdjustmentRefunded({
          orderId: adjustment.orderId,
          refundId: refund.id,
          currency: adjustment.adjustmentCurrency,
          amountMinor: BigInt(adjustment.adjustmentAmount),
        });
        const written = await insertLedgerTransaction(tx, posting.transaction, posting.entries);
        const claim = await claimLedgerRecognition(
          {
            kind: 'adjustment_refunded',
            claimKey: adjustment.id,
            ledgerTransactionId: written.id,
            orderId: adjustment.orderId,
            booked: {
              amount: adjustment.adjustmentAmount,
              currency: adjustment.adjustmentCurrency,
            },
            bookedAt: now,
          },
          tx,
        );
        if (!claim) {
          throw new Error(
            `The 'adjustment_refunded' posting for ${adjustment.id} was claimed concurrently; ` +
              'rolling back so the duplicate entries are discarded.',
          );
        }
      }

      await enqueuePaymentEvent(tx, {
        id: paymentRefundedEventId(refund.id),
        eventType: 'payment_refunded',
        payload: { refundId: refund.id, orderId: adjustment.orderId, paymentId },
      });
      return refund.id;
    });

    notifyRetailCostAdjustment(
      { id: adjustment.orderId, checkoutGroupId: order.checkoutGroupId },
      adjustment.id,
    );
    const settled = await findRetailCustomerAdjustment(adjustment.id, db);
    log.general.info(
      { adjustmentId: adjustment.id, orderId: adjustment.orderId, refundId },
      '[RetailReconciliation] cost adjustment refund committed',
    );
    return { adjustment: settled ?? adjustment, refundId };
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      // `refund.service`'s own idempotency claim converged a retry that got past
      // the compare-and-swap. Nothing is wrong and no second refund exists.
      const converged = await findRetailCustomerAdjustment(adjustment.id, db);
      return {
        adjustment: converged ?? adjustment,
        ...(converged?.refundId ? { refundId: converged.refundId } : {}),
      };
    }
    await setAdjustmentState(
      { id: adjustment.id, state: 'refund_failed', from: ['owed', 'refund_committed'] },
      db,
    );
    await raiseReconciliationException(
      {
        kind: 'adjustment_refund_failed',
        orderId: adjustment.orderId,
        detail:
          `The cost adjustment ${adjustment.id} could not be committed: ` +
          `${error instanceof Error ? error.message : String(error)}. The amount is still owed ` +
          'and the retry drives the same idempotent path.',
        at: now,
      },
      db,
    );
    throw error;
  }
}

/**
 * Why the rail cannot serve this obligation, or `undefined` when it can.
 *
 * Several reason codes rather than one, unlike a buyer-facing refusal: this is
 * an operator surface behind an allow-list and its whole purpose is to say what
 * to do next. The house rule that a refusal spanning several conditions gets ONE
 * code defends against a CLIENT reading out a switchboard by varying inputs, and
 * there is no client here to do that.
 */
async function refundBlockReason(input: {
  order: { paymentStatus: string; paymentId: string | null };
  adjustment: RetailCustomerAdjustmentRow;
}): Promise<
  | 'payment_not_settled'
  | 'provider_refund_unavailable'
  | 'dispute_open'
  | 'below_automation_threshold'
  | undefined
> {
  const { order, adjustment } = input;
  if (adjustment.method === 'recorded_payable' && adjustment.blockReason === 'below_automation_threshold') {
    // ADR 0004 D8.2: at or below the threshold the surplus stays on
    // `customer_adjustment`, refundable on request. An operator pressing retry
    // is that request, and it arrives through the operator surface with its own
    // audited action — so this branch only holds back the AUTOMATIC sweep.
    return 'below_automation_threshold';
  }
  if (order.paymentStatus !== 'paid' || !order.paymentId) return 'payment_not_settled';

  const payment = await findPaymentById(getDb(), order.paymentId);
  if (!payment) return 'payment_not_settled';
  if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') {
    return 'provider_refund_unavailable';
  }
  return undefined;
}

/**
 * Pay an obligation because an OPERATOR asked, bypassing the automation floor.
 *
 * ADR 0004 D8.3's "refundable on request until finality". The floor decides
 * whether Mercaria refunds unasked; it never decides whether the money is the
 * buyer's, so an explicit request clears it — and the request is audited by the
 * operator surface that made it.
 */
export async function settleRetailCustomerAdjustmentOnRequest(input: {
  adjustmentId: string;
  now?: Date;
}): Promise<AdjustmentSettlementOutcome | undefined> {
  const db = getDb();
  const adjustment = await findRetailCustomerAdjustment(input.adjustmentId, db);
  if (!adjustment) return undefined;
  if (adjustment.blockReason === 'below_automation_threshold') {
    await setAdjustmentState(
      {
        id: adjustment.id,
        state: 'owed',
        from: ['payable_recorded', 'owed'],
        method: 'provider_refund',
        // Clearing the reason is what distinguishes "nobody has asked" from
        // "the rail cannot serve it": the second is re-derived on the attempt.
        // An EXPLICIT clear, not an omitted optional — the two are different
        // intentions and the repository's spread cannot tell them apart.
        clearBlockReason: true,
      },
      db,
    );
  }
  return settleRetailCustomerAdjustment(input);
}
