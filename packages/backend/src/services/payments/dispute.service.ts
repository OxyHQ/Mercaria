/**
 * The dispute lifecycle — ADR 0001 D7, issue #49.
 *
 * A buyer's bank reverses a charge through the card network. Under separate
 * charges and transfers Mercaria is the merchant of record (D1), so the PLATFORM
 * balance is what the network debits and Mercaria is who answers for it; the
 * seller bears the principal only once the dispute is actually lost.
 *
 * ## This is not moderation, and the two never meet
 *
 * Issue #49 scope 7. Mercaria already has a case system — reports, a randomly
 * drawn jury, signed decisions, catalogue enforcement — and "a buyer says this
 * transaction was not theirs" reads like something it should hear about. It must
 * not. CrowdSource decides whether CONTENT breaks a rule; a card network decides
 * a dispute, on evidence Mercaria submits, against a deadline nobody here sets.
 * Wiring one into the other would put a bank's chargeback rate into a seller's
 * reputation and a jury's verdict into a financial ledger. Nothing in this file
 * imports `services/moderation`, and nothing there imports this.
 *
 * ## The recovery happens on LOSS, not on creation — and the ADR's diagram says
 * otherwise for a reason that no longer holds
 *
 * ADR 0001's sequence diagram reverses the seller's transfer when the dispute
 * OPENS and re-transfers on a win. That shape is not implementable against the
 * domain #45 built, and the obstacle is structural rather than a preference:
 * "re-transfer the recovered principal to the seller" is a NEW transfer for an
 * order that already has one, and `UNIQUE(transfers.payment_id, order_id)`
 * exists precisely to make a second transfer for one order impossible — it is
 * the constraint standing between a settlement retry and money leaving twice.
 *
 * So the recovery is executed when the outcome is `lost`, which is also when the
 * loss is real. Until then the principal sits in the `disputes` holding account,
 * which is what a holding account is for: a dispute is not yet a loss, and
 * booking it as one would make a won dispute look like a windfall. The prose of
 * D7 — "a lost dispute stays a seller-side loss; a won dispute reverses the
 * recovery" — is satisfied either way; only the timing differs, and this timing
 * is the one that does not take a seller's money for a dispute they go on to
 * win.
 *
 * ## What is read from the rail, and what is never assumed
 *
 * The amount and the fee come from the dispute's own balance movement on the
 * platform balance — never from the order, never from the charge. An INQUIRY
 * (some networks raise one before a chargeback) reports NO movement: it carries
 * a deadline and needs evidence, and no money has left. Booking one would debit
 * a balance nothing debited and would recover a principal from a seller for a
 * dispute that does not exist yet, so the empty movement is what gates the
 * ledger rather than the status string — statuses that mean "inquiry" differ by
 * network and grow on the rail's schedule.
 */

import type { DisputeOutcome, DisputeStatus, Money, PaymentProviderId } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  claimDisputeOpening,
  claimDisputeOutcome,
  claimDisputeRecovery,
  findDisputeById,
  findDisputeByProviderId,
  setDisputeRecoveryState,
  upsertDispute,
  type DisputeRow,
} from '../../db/payments/disputeRepository.js';
import {
  findPaymentById,
  findTransferForOrder,
  updateTransferFromProvider,
  type PaymentRow,
} from '../../db/payments/paymentRepository.js';
import { insertLedgerTransaction } from '../../db/payments/ledgerRepository.js';
import { disputeCreated, disputeLost, disputeWon, transferReversal } from './ledger-postings.js';
import { findLinkedOrder, findOrdersInCheckoutGroup, type LinkedOrder } from './order-linkage.js';
import { enqueuePaymentEvent, paymentDisputedEventId } from './payment-outbox.service.js';
import { ownerTypeOf, recordReversalFailed, recoverableFrom } from './refund-execution.service.js';
import { isRetryableProviderError, isSettlingProvider } from './provider.js';
import { resolvePaymentProvider } from './registry.js';
import { redactProviderMessage } from './redact.js';
import { log } from '../../lib/logger.js';

/** A dispute exactly as the rail reported it, in Mercaria's vocabulary. */
export interface ObservedDispute {
  provider: PaymentProviderId;
  providerDisputeId: string;
  /** What the rail took off the platform balance. Zero for an inquiry. */
  amount: Money;
  /** The rail's dispute fee, in the same currency. Zero for an inquiry. */
  feeMinor: number;
  reason?: string;
  status: DisputeStatus;
  evidenceDueBy?: Date;
  /** Present once the rail says it closed. */
  outcome?: DisputeOutcome;
  closedAt?: Date;
}

/** What recording one observation did. */
export interface DisputeOutcomeSummary {
  disputeId: string;
  /** `true` when THIS call booked the opening debit. */
  booked: boolean;
  /** `true` when THIS call closed it. */
  closed: boolean;
  /** Where the seller-side recovery of a lost dispute stands. */
  recovery?: 'succeeded' | 'failed' | 'not_required' | 'unattributed';
}

/**
 * Record where a dispute stands, and book whatever that movement causes.
 *
 * ONE entry point for `created`, `updated` and `closed`, because the rail's
 * three event types are three observations of one object and Stripe orders none
 * of them — a `closed` can arrive before the `created` that Mercaria never
 * received. Handling them separately would mean each handler assuming a row the
 * previous one made; handling them here means the row is upserted and the two
 * ledger transitions are compare-and-swaps, so any arrival order converges.
 *
 * @throws When the payment cannot be resolved yet. Retryable, because a dispute
 *   naming a charge Mercaria has not finished writing is a race and not an
 *   error — the same reasoning the PaymentIntent handler's correlation uses.
 */
export async function recordDispute(
  observed: ObservedDispute,
  paymentId: string,
): Promise<DisputeOutcomeSummary> {
  const db = getDb();
  const payment = await findPaymentById(db, paymentId);
  if (!payment) {
    throw new Error(`Dispute ${observed.providerDisputeId} names payment ${paymentId}, which does not exist.`);
  }

  // A single-seller group leaves no ambiguity about which order was disputed, so
  // it is attributed here. A multi-seller one is left UNATTRIBUTED on purpose:
  // the network gives no line detail, and guessing would reverse an innocent
  // seller's transfer for goods they shipped.
  const orders = await findOrdersInCheckoutGroup(payment.checkoutGroupId);
  const soleOrder = orders.length === 1 ? orders[0] : undefined;

  const { row, created } = await upsertDispute(db, {
    provider: observed.provider,
    providerDisputeId: observed.providerDisputeId,
    paymentId: payment.id,
    amount: observed.amount,
    feeMinor: observed.feeMinor,
    status: observed.status,
    ...(soleOrder ? { orderId: soleOrder.id } : {}),
    ...(observed.reason ? { reason: observed.reason } : {}),
    ...(observed.evidenceDueBy ? { evidenceDueBy: observed.evidenceDueBy } : {}),
  });

  const booked = await bookOpeningIfNeeded(row, payment);
  const summary: DisputeOutcomeSummary = { disputeId: row.id, booked, closed: false };

  if (observed.outcome) {
    const closure = await closeDispute({
      disputeId: row.id,
      outcome: observed.outcome,
      status: observed.status,
      ...(observed.closedAt ? { closedAt: observed.closedAt } : {}),
    });
    summary.closed = closure.closed;
    if (closure.recovery) summary.recovery = closure.recovery;
  }

  await announce(row, observed.status, created);
  return summary;
}

/**
 * Book the opening debit, if this observation is the one that may.
 *
 * The claim is what makes it exactly once: a redelivered `created` finds
 * `opened_booked_at` set and books nothing, while an inquiry finds a zero amount
 * and is refused until it escalates and gains one.
 */
async function bookOpeningIfNeeded(row: DisputeRow, payment: PaymentRow): Promise<boolean> {
  const db = getDb();
  return await db.transaction(async (tx) => {
    const claimed = await claimDisputeOpening(tx, row.id);
    if (!claimed) return false;

    const posting = disputeCreated({
      paymentId: payment.id,
      disputeRef: claimed.providerDisputeId,
      currency: claimed.amountCurrency,
      amountMinor: BigInt(claimed.amountAmount),
      feeMinor: BigInt(claimed.feeAmount),
      ...(claimed.orderId ? { orderId: claimed.orderId } : {}),
    });
    await insertLedgerTransaction(tx, posting.transaction, posting.entries);
    return true;
  });
}

/**
 * Close a dispute and settle its accounting.
 *
 * A won dispute reverses the holding entry and stops there — the FEE is not
 * returned and no leg reverses it, because a lost fee on a won dispute is a real
 * cost Mercaria bore (ADR 0001 D5) and booking it back would overstate revenue
 * by the amount of every dispute ever raised.
 *
 * A lost one moves the principal onto the seller's receivable and then recovers
 * it off their balance. Those are two transactions rather than one because the
 * second can fail where the first cannot: an insufficient seller balance leaves
 * the receivable open in Mercaria's favour, which is exactly what "the seller
 * still owes this" means in accounts, and an operator picks it up.
 */
export async function closeDispute(input: {
  disputeId: string;
  outcome: DisputeOutcome;
  status: DisputeStatus;
  closedAt?: Date;
}): Promise<{ closed: boolean; recovery?: DisputeOutcomeSummary['recovery'] }> {
  const db = getDb();
  const claimed = await claimDisputeOutcome(db, {
    disputeId: input.disputeId,
    outcome: input.outcome,
    status: input.status,
    ...(input.closedAt ? { closedAt: input.closedAt } : {}),
  });
  // A redelivered `closed` matches nothing, so neither closing transaction runs
  // a second time. That single fact is the whole of the convergence property for
  // the two postings that move a disputed amount out of the holding account.
  if (!claimed) return { closed: false };

  // Nothing was ever debited — an inquiry that closed. There is no holding entry
  // to release, and writing one would credit `disputes` for a debit that never
  // happened.
  if (claimed.openedBookedAt === null) {
    return { closed: true };
  }

  const payment = await findPaymentById(db, claimed.paymentId);
  if (!payment) {
    throw new Error(`Dispute ${claimed.id} names payment ${claimed.paymentId}, which does not exist.`);
  }

  if (input.outcome === 'won') {
    const posting = disputeWon({
      paymentId: payment.id,
      disputeRef: claimed.providerDisputeId,
      currency: claimed.amountCurrency,
      amountMinor: BigInt(claimed.amountAmount),
      ...(claimed.orderId ? { orderId: claimed.orderId } : {}),
    });
    await db.transaction(async (tx) => {
      await insertLedgerTransaction(tx, posting.transaction, posting.entries);
    });
    return { closed: true };
  }

  // Lost, and nobody has said which seller it was about. The principal stays in
  // the holding account — which is what a holding account is for — until an
  // operator attributes it. Charging it to an arbitrary seller of a multi-seller
  // group to close the books would be worse than leaving it visible.
  if (!claimed.orderId) {
    log.general.error(
      { disputeId: claimed.id, paymentId: payment.id, providerDisputeId: claimed.providerDisputeId },
      '[Payments] a dispute was lost on a multi-seller charge with no order attributed; the ' +
        'principal stays in the disputes account until an operator attributes it (#50)',
    );
    return { closed: true, recovery: 'unattributed' };
  }

  const order = await findLinkedOrder(claimed.orderId);
  if (!order) {
    throw new Error(`Dispute ${claimed.id} names order ${claimed.orderId}, which does not exist.`);
  }

  await db.transaction(async (tx) => {
    const posting = disputeLost({
      paymentId: payment.id,
      disputeRef: claimed.providerDisputeId,
      orderId: order.id,
      ownerType: ownerTypeOf(order),
      ownerId: order.sellerOwnerId,
      currency: claimed.amountCurrency,
      amountMinor: BigInt(claimed.amountAmount),
    });
    await insertLedgerTransaction(tx, posting.transaction, posting.entries);
  });

  const recovery = await recoverLostDispute({ dispute: claimed, payment, order });
  return { closed: true, recovery };
}

/**
 * Take the disputed principal back off the seller's balance.
 *
 * Never throws for a permanent failure, exactly like the refund path's recovery
 * and for the same reason: the network has already taken the money and that is
 * not undoable. What is at stake here is only whether Mercaria has recovered it,
 * and a failure leaves the seller's receivable open and raises the same
 * `reversal_failed` exception a failed refund reversal does — one condition, one
 * operator queue.
 */
async function recoverLostDispute(input: {
  dispute: DisputeRow;
  payment: PaymentRow;
  order: LinkedOrder;
}): Promise<'succeeded' | 'failed' | 'not_required'> {
  const { dispute, payment, order } = input;
  const db = getDb();

  if (dispute.providerReversalId) return 'succeeded';

  const provider = resolvePaymentProvider(payment.provider);
  if (!provider || !isSettlingProvider(provider)) {
    await setDisputeRecoveryState(db, { disputeId: dispute.id, recoveryState: 'not_required' });
    return 'not_required';
  }

  const transfer = await findTransferForOrder(db, payment.id, order.id);
  const recoverable = recoverableFrom(transfer, BigInt(dispute.amountAmount));
  if (recoverable === undefined || !transfer) {
    // The seller was never paid this money, so their receivable is still open
    // and `dispute_lost` has just charged it — which IS the recovery in that
    // case. There is nothing at the rail to reverse.
    await setDisputeRecoveryState(db, { disputeId: dispute.id, recoveryState: 'not_required' });
    return 'not_required';
  }

  const amount: Money = { amount: Number(recoverable), currency: dispute.amountCurrency };
  let reversal;
  try {
    reversal = await provider.reverseTransfer({
      paymentId: payment.id,
      orderId: order.id,
      transferObjectId: transfer.providerObjectId ?? '',
      amount,
      // ADR 0001 D11's dispute key. Distinct from a refund's on the same order,
      // because a disputed order can also have been partially refunded and the
      // two recoveries are different money.
      idempotencyKey: `trr:dispute:${dispute.id}:${order.id}`,
      metadata: { disputeId: dispute.id, orderId: order.id, paymentId: payment.id },
    });
  } catch (error: unknown) {
    if (isRetryableProviderError(error)) throw error;
    await setDisputeRecoveryState(db, { disputeId: dispute.id, recoveryState: 'failed' });
    await recordReversalFailed({
      subjectId: dispute.id,
      subjectKind: 'dispute',
      payment,
      order,
      amount,
      reason: `the rail refused the dispute recovery: ${redactProviderMessage(
        error instanceof Error ? error.message : String(error),
      )}`,
    });
    return 'failed';
  }

  await db.transaction(async (tx) => {
    const claimed = await claimDisputeRecovery(tx, {
      disputeId: dispute.id,
      providerReversalId: reversal.providerObjectId,
    });
    if (!claimed) return;

    const posting = transferReversal({
      paymentId: payment.id,
      transferId: transfer.id,
      orderId: order.id,
      ownerType: ownerTypeOf(order),
      ownerId: order.sellerOwnerId,
      currency: amount.currency,
      amountMinor: BigInt(amount.amount),
    });
    await insertLedgerTransaction(tx, posting.transaction, posting.entries);

    await updateTransferFromProvider(tx, {
      transferId: transfer.id,
      status: reversal.totalReversedMinor >= transfer.amountAmount ? 'reversed' : transfer.status,
      reversedAmount: reversal.totalReversedMinor,
    });
  });

  return 'succeeded';
}

/**
 * Tell the rest of Mercaria where this dispute now stands.
 *
 * The STATUS is in the outbox id, so each state a dispute reaches is announced
 * once and every redelivery of it is a genuine no-op — the same reasoning
 * `transfer_changed` uses. Consumers (the operator surface #50, the seller
 * notification #108) attach HERE and not to the rail's webhook, so neither ever
 * receives provider detail.
 */
async function announce(row: DisputeRow, status: DisputeStatus, created: boolean): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await enqueuePaymentEvent(tx, {
      id: paymentDisputedEventId(row.id, status),
      eventType: 'payment_disputed',
      payload: {
        disputeId: row.id,
        paymentId: row.paymentId,
        ...(row.orderId ? { orderId: row.orderId } : {}),
        status,
        amountMinor: row.amountAmount,
        currency: row.amountCurrency,
        ...(row.reason ? { reason: row.reason } : {}),
        ...(row.evidenceDueBy ? { evidenceDueBy: row.evidenceDueBy.toISOString() } : {}),
        opened: created,
      },
    });
  });
}

/**
 * Re-attempt the seller-side recovery of a dispute that was already LOST.
 *
 * #50's `retry_transfer_reversal` repair, for the dispute half. It reuses
 * `recoverLostDispute` rather than restating it, which is the whole point: the
 * proration, the reversal key (`trr:dispute:<disputeId>:<orderId>`), the
 * compare-and-swap on `provider_reversal_id` and the ledger posting are all
 * properties of one recovery, and an operator-triggered second attempt that had
 * its own copy of them would eventually recover a different amount than the
 * automatic one did.
 *
 * ## It refuses everything that is not a lost, attributed, unrecovered dispute
 *
 * Each refusal is a different operator mistake and each names itself:
 *
 *  - **not closed, or not lost** — recovering from a seller for a dispute they
 *    may still win is exactly what ADR 0001's corrected sequence 5 exists to
 *    prevent (the original diagram reversed at OPEN and had to be changed).
 *  - **no order attributed** — the multi-seller case. The principal sits in the
 *    `disputes` holding account until a person says which seller shipped the
 *    goods, and guessing would reverse an innocent seller's transfer.
 *  - **already recovered** — `recoverLostDispute` returns `succeeded` for this
 *    on its own, so it is not a refusal here; the repair reports `no_op`.
 *
 * @throws When the dispute, its payment or its order cannot be read. A repair
 *   that cannot see what it is repairing must not report success.
 */
export async function retryDisputeRecovery(disputeId: string): Promise<{
  recovery: 'succeeded' | 'failed' | 'not_required';
  refusedBecause?: string;
}> {
  const db = getDb();
  const dispute = await findDisputeById(db, disputeId);
  if (!dispute) {
    throw new Error(`Dispute ${disputeId} does not exist.`);
  }
  if (dispute.closedAt === null || dispute.outcome !== 'lost') {
    return {
      recovery: 'not_required',
      refusedBecause:
        `the dispute is ${dispute.closedAt === null ? 'still open' : `closed '${String(dispute.outcome)}'`}; ` +
        'a seller is only charged for a dispute that was LOST',
    };
  }
  if (!dispute.orderId) {
    return {
      recovery: 'not_required',
      refusedBecause:
        'no seller order is attributed to this dispute, so there is no transfer to reverse; ' +
        'attribute it first — guessing would reverse an innocent seller’s transfer',
    };
  }

  const payment = await findPaymentById(db, dispute.paymentId);
  if (!payment) {
    throw new Error(`Dispute ${disputeId} names payment ${dispute.paymentId}, which does not exist.`);
  }
  const order = await findLinkedOrder(dispute.orderId);
  if (!order) {
    throw new Error(`Dispute ${disputeId} names order ${dispute.orderId}, which does not exist.`);
  }

  return { recovery: await recoverLostDispute({ dispute, payment, order }) };
}

/** One dispute by the rail's own id — the correlation an inbound event starts from. */
export async function findDisputeForProviderId(
  provider: PaymentProviderId,
  providerDisputeId: string,
): Promise<DisputeRow | undefined> {
  return await findDisputeByProviderId(getDb(), provider, providerDisputeId);
}
