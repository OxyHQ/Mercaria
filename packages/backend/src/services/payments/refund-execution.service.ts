/**
 * Moving the money a refund record promised — ADR 0001 D7.
 *
 * `refund.service` decides WHAT is refundable (per-line quantities, the
 * discounted net, no double restock) and commits that decision. This module is
 * the money: it returns the buyer's share out of the group's charge and recovers
 * the seller's proportional share off their connected account, and it books both
 * legs.
 *
 * It runs from the `payment_refunded` outbox handler and never from a request.
 * That is not layering for its own sake — a refund whose provider call lives in
 * the request that created it evaporates when the task restarts, and the
 * commerce record has ALREADY restocked by then, so what would be left is an
 * order claiming money went back to a buyer who never received it.
 *
 * ## Two movements, and only one of them may block
 *
 * ADR 0001 D7 is explicit: a transfer reversal can fail where the refund did
 * not — an insufficient seller balance with no reserve behind it — and the
 * buyer's refund is NOT blocked on it. So the two are executed in that order,
 * the second one catches its own permanent failures, and the gap is booked
 * honestly rather than hidden: the refund posting debits the order's
 * `merchant_payable` and, with no reversal to credit it back, that account sits
 * in debit for exactly the amount the seller still owes Mercaria. An operator
 * exception (`reversal_failed`) names it, and `debit_negative_balances` or a
 * future transfer is what eventually recovers it.
 *
 * ## The three amounts, and why none of them is derived from another
 *
 *  - **What the buyer gets back** is the refund record's own presentment total.
 *    It is authoritative and is never recomputed here (issue #49, invariant 5):
 *    the commerce decision has been made and this module does not get to
 *    re-litigate it.
 *  - **What the platform balance actually lost** is read from the rail's own
 *    record of the movement, in the platform's settlement currency. A refund
 *    converts at the REFUND-time rate, so on a converted charge it is NOT the
 *    proportional share of what came in — and ADR 0001 D7 says to record it at
 *    its own captured amount rather than derive it.
 *  - **What the seller bears** is their NET share of the order (gross split
 *    minus the order's marketplace-fee snapshot, #88), prorated by how much of
 *    that order has now been refunded, from `deriveSellerNetShares` — the SAME
 *    net the ledger credited at charge time and the settlement transferred.
 *    Three readers of one definition; computing it a fourth way is how a
 *    `merchant_payable` account stops returning to zero.
 *
 * Mercaria's own residual is the difference between the second and the third,
 * and it is not a rate: it carries the commission returned on the refunded
 * amount (ADR 0001 D5 — the fee schedule's `proportional` refund policy, which
 * is exactly what "the seller bears only their net share" implements) and the
 * conversion asymmetry Mercaria bears by the same decision. Computing it as a
 * residual is what keeps the seller's leg exactly closable by the reversal,
 * which is the property that makes a failed recovery visible as an open payable
 * instead of a rounding difference nobody can attribute.
 */

import type { LedgerOwnerType, Money, PaymentProviderId } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  applyRefundProviderState,
  claimRefundProviderObject,
  claimRefundReversal,
  findRefundById,
  setRefundReversalState,
  sumRecoverableRefundedPresentment,
  type RefundRecord,
} from '../../db/orders/refundRepository.js';
import {
  findPaymentById,
  findTransferForOrder,
  updateTransferFromProvider,
  type PaymentRow,
  type TransferRow,
} from '../../db/payments/paymentRepository.js';
import { insertLedgerTransaction } from '../../db/payments/ledgerRepository.js';
import { refundPosting, transferReversal } from './ledger-postings.js';
import { deriveSellerNetShares } from './seller-net-shares.js';
import { findLinkedOrder, findOrdersInCheckoutGroup, type LinkedOrder } from './order-linkage.js';
import { applyPaymentStatus, settlementBasis } from './payment.service.js';
import {
  enqueuePaymentEvent,
  refundFailedEventId,
  reversalFailedEventId,
} from './payment-outbox.service.js';
import {
  isRetryableProviderError,
  isSettlingProvider,
  PaymentProviderError,
  type SettlingPaymentProvider,
} from './provider.js';
import { resolvePaymentProvider } from './registry.js';
import { redactProviderMessage } from './redact.js';
import { log } from '../../lib/logger.js';

/** What one execution did, for the handler's log line and its tests. */
export interface RefundExecutionOutcome {
  /** Whether the rail returned money to the buyer in this call or an earlier one. */
  refunded: boolean;
  /** Where the seller-side recovery stands. */
  reversal: 'succeeded' | 'failed' | 'not_required' | 'already_done';
  /** Why nothing happened, when nothing did. */
  note?: string;
}

/** A condition no retry can fix — the row is wrong, not the moment. */
function permanent(message: string, code: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'stripe',
    stage: 'refund',
    message,
    retryable: false,
    code,
  });
}

/** A condition that will resolve on its own — the rail, or a race with a write. */
function transient(message: string, code: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'stripe',
    stage: 'refund',
    message,
    retryable: true,
    code,
  });
}

/** The ledger's owner vocabulary, from the order's seller type. */
function ownerTypeOf(order: LinkedOrder): LedgerOwnerType {
  return order.sellerType === 'store' ? 'store' : 'user';
}

/**
 * The seller's cumulative liability once `refundedPresentment` of the order has
 * been given back — a floor proration of their whole share of it.
 *
 * Cumulative, and that is the design rather than a convenience: each refund
 * reverses the DIFFERENCE between this figure and the previous one, so a
 * sequence of partial refunds sums to exactly the seller's whole share once the
 * order is fully refunded, with no drift and no unit lost to rounding. Prorating
 * each refund independently would floor each one separately and leave the last
 * few units of a fully-refunded order sitting on the seller's balance forever.
 *
 * Flooring is the conservative direction — never take more off a seller than
 * their proportional share — and the equality case is exact: a fully refunded
 * order has `refunded === total`, which returns the whole share with no rounding
 * at all.
 */
function sellerLiabilityAt(
  shareMinor: bigint,
  refundedPresentment: number,
  orderPresentmentTotal: number,
): bigint {
  if (orderPresentmentTotal <= 0) return shareMinor;
  if (refundedPresentment >= orderPresentmentTotal) return shareMinor;
  if (refundedPresentment <= 0) return 0n;
  return (shareMinor * BigInt(refundedPresentment)) / BigInt(orderPresentmentTotal);
}

/**
 * Execute the provider side of one committed refund.
 *
 * Idempotent throughout, because the outbox is at-least-once: the rail's key
 * (`re:<refundId>`) makes a repeated call converge on the refund it already
 * made, and the two compare-and-swaps on the refund row make the two ledger
 * postings happen once each even when two tasks both got an answer.
 *
 * @throws When the rail fails in a way a retry could fix, or when a fact this
 *   needs is not visible yet. The outbox row is released with backoff and the
 *   execution resumes where it stopped.
 */
export async function executeRefundAtProvider(refundId: string): Promise<RefundExecutionOutcome> {
  const db = getDb();
  const refund = await findRefundById(refundId);
  if (!refund) {
    // Nothing deletes a refund, so this is a row that was never visible to this
    // task rather than one that went away — but a refund whose commerce record
    // cannot be read must not be paid out on the strength of an outbox payload.
    throw transient(`Refund ${refundId} is not visible yet.`, 'refund_not_found');
  }
  if (!refund.provider || !refund.paymentId) {
    return {
      refunded: false,
      reversal: 'not_required',
      note: 'the refund carries no provider operation; nothing was ever going to move at a rail',
    };
  }
  if (refund.providerState === 'failed' || refund.providerState === 'canceled') {
    return {
      refunded: false,
      reversal: 'not_required',
      note: `the rail already reported this refund '${refund.providerState}'`,
    };
  }

  const payment = await findPaymentById(db, refund.paymentId);
  if (!payment) {
    throw permanent(
      `Refund ${refundId} names payment ${refund.paymentId}, which does not exist.`,
      'payment_not_found',
    );
  }
  const order = await findLinkedOrder(refund.orderId);
  if (!order) {
    throw permanent(
      `Refund ${refundId} names order ${refund.orderId}, which does not exist.`,
      'order_not_found',
    );
  }

  const provider = resolvePaymentProvider(payment.provider);
  if (!provider) {
    // The rail is switched off in this deployment. A retry is right: the refund
    // record is durable and the money is owed whether or not a flag is set.
    throw transient(
      `Refund ${refundId} is on ${payment.provider}, which is not available in this deployment.`,
      'rail_unavailable',
    );
  }
  if (!isSettlingProvider(provider)) {
    return {
      refunded: false,
      reversal: 'not_required',
      note: `${payment.provider} settles nothing, so it refunds nothing through this path`,
    };
  }
  if (!payment.providerObjectId) {
    throw permanent(
      `Payment ${payment.id} carries no provider object; a refund cannot name the charge it ` +
        'draws from.',
      'missing_provider_object',
    );
  }

  // The buyer's side, exactly as the refund record states it. ADR 0001 D7 makes
  // the refund domain authoritative for the amount, so nothing here recomputes
  // it — the one check is that it is drawn in the currency the charge was made
  // in, because a refund the rail cannot apply to that charge is a permanent
  // mistake rather than a slow one.
  const buyerAmount: Money = {
    amount: refund.totalRefundedPresentmentAmount,
    currency: refund.totalRefundedPresentmentCurrency,
  };
  if (buyerAmount.currency !== payment.presentmentCurrency) {
    throw permanent(
      `Refund ${refundId} is denominated in ${buyerAmount.currency} but payment ${payment.id} ` +
        `was charged in ${payment.presentmentCurrency}; a refund is drawn from its own charge.`,
      'currency_mismatch',
    );
  }

  const sellerShare = await sellerShareOfRefund({ payment, order, refund });

  const executed = await refundTheBuyer({
    refund,
    payment,
    order,
    provider,
    buyerAmount,
    sellerShareMinor: sellerShare.thisRefundMinor,
    currency: sellerShare.currency,
  });
  if (!executed.refunded) {
    return { refunded: false, reversal: 'not_required', ...(executed.note ? { note: executed.note } : {}) };
  }

  const reversal = await recoverFromSeller({
    refund,
    payment,
    order,
    provider,
    amountMinor: sellerShare.thisRefundMinor,
    currency: sellerShare.currency,
  });

  return { refunded: true, reversal };
}

/**
 * What this refund makes the seller liable for, in the platform's currency.
 *
 * Reads `deriveSellerNetShares` rather than the transfer row, deliberately: a
 * withheld transfer means the seller was never paid, and their receivable is
 * still OPEN — so the refund must still reduce it, and reading the amount from a
 * transfer that does not exist would silently make it zero and leave Mercaria
 * owing a seller for goods that came back.
 *
 * The share is the seller's NET (gross split minus the order's marketplace-fee
 * snapshot, #88) — which is what makes the schedule's `proportional` refund
 * policy fall out of the residual below: the seller only ever bears their net
 * share of a refunded amount, so Mercaria's commission on it comes back through
 * `mercariaShareMinor` with no second code path, prorated exactly as the
 * cumulative liability is.
 */
async function sellerShareOfRefund(input: {
  payment: PaymentRow;
  order: LinkedOrder;
  refund: RefundRecord;
}): Promise<{ thisRefundMinor: bigint; currency: Money['currency'] }> {
  const { payment, order, refund } = input;
  const orders = await findOrdersInCheckoutGroup(payment.checkoutGroupId);
  const settled = settlementBasis(payment);
  const allocation = deriveSellerNetShares({
    settled,
    presentmentGrossMinor: BigInt(payment.presentmentAmount),
    orders,
  });

  const share = allocation.shares.find((candidate) => candidate.orderId === order.id);
  if (!share) {
    throw permanent(
      `Order ${order.id} is not part of payment ${payment.id}'s checkout group, so it has no ` +
        'share of the charge to refund.',
      'order_not_in_group',
    );
  }

  // Cumulative INCLUDING this refund, because its row is already committed —
  // which is exactly why the execution runs after the commit rather than inside
  // it: the aggregate is what makes a sequence of partial refunds add up.
  const cumulative = await sumRecoverableRefundedPresentment(order.id);
  const prior = cumulative - refund.totalRefundedPresentmentAmount;
  const liabilityNow = sellerLiabilityAt(
    share.netMinor,
    cumulative,
    order.presentmentTotalMinor,
  );
  const liabilityBefore = sellerLiabilityAt(
    share.netMinor,
    prior,
    order.presentmentTotalMinor,
  );

  return {
    // Never negative: a refund can only ever increase what a seller has borne,
    // and a concurrent aggregate read that saw more than it should must not turn
    // into a CREDIT to the seller.
    thisRefundMinor: liabilityNow > liabilityBefore ? liabilityNow - liabilityBefore : 0n,
    currency: allocation.currency,
  };
}

/** Return the buyer's money, book it, and record what the rail said. */
async function refundTheBuyer(input: {
  refund: RefundRecord;
  payment: PaymentRow;
  order: LinkedOrder;
  provider: SettlingPaymentProvider;
  buyerAmount: Money;
  sellerShareMinor: bigint;
  currency: Money['currency'];
}): Promise<{ refunded: boolean; note?: string }> {
  const { refund, payment, order, provider, buyerAmount } = input;
  const db = getDb();

  if (refund.providerRefundId && refund.providerState === 'succeeded') {
    return { refunded: true };
  }

  let result;
  try {
    result = await provider.refund({
      paymentId: payment.id,
      providerObjectId: payment.providerObjectId ?? '',
      refundId: refund.id,
      amount: buyerAmount,
      // ADR 0001 D11, derived from Mercaria's durable refund id.
      idempotencyKey: `re:${refund.id}`,
      // Server-issued ids only, and `refundId` is the load-bearing one: an
      // inbound refund event carrying it resolves to this record even in the
      // window before the id below has been written back, which is what stops a
      // legitimate refund being reported as one made outside Mercaria.
      metadata: { refundId: refund.id, orderId: order.id, paymentId: payment.id },
    });
  } catch (error: unknown) {
    if (isRetryableProviderError(error)) throw error;
    // The row has to say so, not just the exception queue. `pending` on a refund
    // the rail refused would tell a merchant screen the money is on its way, and
    // would make the recovery aggregate treat it as a seller liability — so the
    // state is written FIRST and the operator case raised after it.
    const failureCode =
      error instanceof PaymentProviderError && error.code !== undefined
        ? safeFailureCode(error.code)
        : undefined;
    await applyRefundProviderState(db, {
      refundId: refund.id,
      providerState: 'failed',
      ...(failureCode ? { failureCode } : {}),
    });
    await recordRefundFailed({
      refund,
      payment,
      order,
      reason: `the rail refused the refund: ${redactProviderMessage(
        error instanceof Error ? error.message : String(error),
      )}`,
      ...(failureCode ? { failureCode } : {}),
    });
    return { refunded: false, note: 'the rail refused the refund; raised for an operator (#50)' };
  }

  // The rail took the request and then said the money did not go. Nothing is
  // booked — no funds left the platform balance — but the commerce record has
  // already restocked, so the two disagree and only a person can decide which
  // one moves (issue #49, scope 10).
  if (result.state === 'failed' || result.state === 'canceled') {
    await db.transaction(async (tx) => {
      await claimRefundProviderObject(tx, {
        refundId: refund.id,
        providerRefundId: result.providerObjectId,
        providerState: result.state,
        ...(result.failureCode ? { failureCode: safeFailureCode(result.failureCode) } : {}),
      });
    });
    await recordRefundFailed({
      refund,
      payment,
      order,
      reason: `the rail reported the refund '${result.state}'`,
      failureCode: result.failureCode,
    });
    return { refunded: false, note: `the rail reported the refund '${result.state}'` };
  }

  // The platform-currency figure is what every ledger leg of this refund is
  // denominated in, and it is never assumed. Retrying is the only honest answer
  // when the rail has not stated it: guessing the charge's rate would book a
  // conversion that did not happen, which is precisely the asymmetry ADR 0001 D7
  // says to record rather than derive.
  if (!result.platform) {
    throw transient(
      `The rail has not yet stated what refund ${refund.id} took off the platform balance; a ` +
        'refund must not be booked without it.',
      'refund_settlement_unavailable',
    );
  }
  if (result.platform.amount.currency !== input.currency) {
    throw permanent(
      `Refund ${refund.id} settled in ${result.platform.amount.currency} but order ${order.id} ` +
        `is settled in ${input.currency}; the refund and the payable cannot be booked together.`,
      'settlement_currency_mismatch',
    );
  }

  const refundedPlatformMinor = BigInt(result.platform.amount.amount);
  // Mercaria's residual: the commission returned on the refunded amount (ADR
  // 0001 D5 — the schedule's `proportional` refund policy) PLUS the conversion
  // asymmetry it bears by the same decision. Computed as a residual rather than
  // from a rate, so the seller's leg is exactly what the reversal will recover
  // — see the file docblock.
  const mercariaShareMinor = refundedPlatformMinor - input.sellerShareMinor;

  await db.transaction(async (tx) => {
    const claimed = await claimRefundProviderObject(tx, {
      refundId: refund.id,
      providerRefundId: result.providerObjectId,
      providerState: result.state,
    });
    // Another task executed this refund first. Its posting is the one in the
    // book; a second would double the refund in the accounts.
    if (!claimed) return;

    const posting = refundPosting({
      paymentId: payment.id,
      refundId: refund.id,
      orderId: order.id,
      ownerType: ownerTypeOf(order),
      ownerId: order.sellerOwnerId,
      currency: input.currency,
      amountMinor: refundedPlatformMinor,
      commissionShareMinor: mercariaShareMinor,
    });
    await insertLedgerTransaction(tx, posting.transaction, posting.entries);
  });

  // The payment aggregate's own lifecycle. The rail decides this from the
  // CHARGE's cumulative refunds, so refunding one seller's order out of a
  // multi-seller group reports `partially_refunded` rather than closing the
  // whole payment — and a duplicate execution finds the compare-and-swap
  // unsatisfiable and changes nothing.
  await applyPaymentStatus({
    paymentId: payment.id,
    next: result.status,
    providerObjectId: payment.providerObjectId ?? '',
  });

  log.general.info(
    {
      refundId: refund.id,
      paymentId: payment.id,
      orderId: order.id,
      buyerMinor: buyerAmount.amount,
      platformMinor: Number(refundedPlatformMinor),
      sellerMinor: Number(input.sellerShareMinor),
    },
    '[Payments] buyer refunded at the rail',
  );
  return { refunded: true };
}

/**
 * Take the seller's share back off their balance, and book the recovery.
 *
 * Never throws for a permanent failure: the buyer already has their money and
 * ADR 0001 D7 says that is not to be undone. A failure here is recorded, the
 * payable stays open in Mercaria's favour, and an operator resolves it.
 */
async function recoverFromSeller(input: {
  refund: RefundRecord;
  payment: PaymentRow;
  order: LinkedOrder;
  provider: SettlingPaymentProvider;
  amountMinor: bigint;
  currency: Money['currency'];
}): Promise<'succeeded' | 'failed' | 'not_required' | 'already_done'> {
  const { refund, payment, order, provider } = input;
  const db = getDb();

  if (refund.providerReversalId) return 'already_done';

  const transfer = await findTransferForOrder(db, payment.id, order.id);
  const recoverable = recoverableFrom(transfer, input.amountMinor);
  if (recoverable === undefined) {
    // No transfer, or nothing left on it. The seller was never paid this money —
    // their receivable is still open and the refund posting has just reduced it,
    // which is the whole of the recovery in that case.
    await setRefundReversalState(db, { refundId: refund.id, reversalState: 'not_required' });
    return 'not_required';
  }

  const amount: Money = { amount: Number(recoverable), currency: input.currency };
  let reversal;
  try {
    reversal = await provider.reverseTransfer({
      paymentId: payment.id,
      orderId: order.id,
      transferObjectId: transfer?.providerObjectId ?? '',
      amount,
      // ADR 0001 D11. Two reversals of one refund would take a seller's money
      // twice for goods returned once.
      idempotencyKey: `trr:${refund.id}:${order.id}`,
      metadata: { refundId: refund.id, orderId: order.id, paymentId: payment.id },
    });
  } catch (error: unknown) {
    // A retryable failure is the rail being unreachable, and the whole execution
    // is retried — the refund half converges on what it already did.
    if (isRetryableProviderError(error)) throw error;
    await setRefundReversalState(db, { refundId: refund.id, reversalState: 'failed' });
    await recordReversalFailed({
      subjectId: refund.id,
      subjectKind: 'refund',
      payment,
      order,
      amount,
      reason: `the rail refused the reversal: ${redactProviderMessage(
        error instanceof Error ? error.message : String(error),
      )}`,
    });
    return 'failed';
  }

  await db.transaction(async (tx) => {
    const claimed = await claimRefundReversal(tx, {
      refundId: refund.id,
      providerReversalId: reversal.providerObjectId,
      amount,
    });
    if (!claimed) return;

    const posting = transferReversal({
      paymentId: payment.id,
      transferId: transfer?.id ?? reversal.providerObjectId,
      orderId: order.id,
      ownerType: ownerTypeOf(order),
      ownerId: order.sellerOwnerId,
      currency: amount.currency,
      amountMinor: BigInt(amount.amount),
      refundId: refund.id,
    });
    await insertLedgerTransaction(tx, posting.transaction, posting.entries);

    if (transfer) {
      await updateTransferFromProvider(tx, {
        transferId: transfer.id,
        status:
          reversal.totalReversedMinor >= transfer.amountAmount ? 'reversed' : transfer.status,
        reversedAmount: reversal.totalReversedMinor,
      });
    }
  });

  return 'succeeded';
}

/**
 * How much of `wanted` this transfer can actually give back.
 *
 * `undefined` means none of it, and the three ways that happens are all ordinary
 * rather than errors: no transfer row (the payment never settled this order), a
 * transfer with no provider object (it was withheld — ADR 0001 D4), and one
 * already fully reversed. The clamp on what remains is what stops a second
 * partial refund asking a rail to reverse more than it transferred.
 */
function recoverableFrom(transfer: TransferRow | undefined, wanted: bigint): bigint | undefined {
  if (wanted <= 0n) return undefined;
  if (!transfer?.providerObjectId) return undefined;
  const remaining = BigInt(transfer.amountAmount) - BigInt(transfer.reversedAmount);
  if (remaining <= 0n) return undefined;
  return wanted < remaining ? wanted : remaining;
}

/**
 * A provider failure CODE, or nothing.
 *
 * The same filter `provider_accounts.disabled_reason_codes` applies, and for the
 * same reason: a rail's failure field is a code today and nothing stops it
 * carrying a sentence tomorrow — one quoting a cardholder's bank, their name or
 * part of a card number. A code shape is what a merchant surface can safely
 * render, so anything a sentence could fit in is dropped rather than shown.
 */
function safeFailureCode(code: string): string | undefined {
  return /^[a-z][a-z0-9_]*$/.test(code) ? code : undefined;
}

/**
 * The buyer's refund did not happen and the commerce record says it did.
 *
 * A durable outbox row rather than a log line, the same shape `transfer_withheld`
 * uses: the order has been restocked and its status moved, so a person has to
 * decide between re-attempting the refund and undoing the commerce record.
 * Neither is a decision the payment domain gets to take.
 */
async function recordRefundFailed(input: {
  refund: RefundRecord;
  payment: PaymentRow;
  order: LinkedOrder;
  reason: string;
  failureCode?: string;
}): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await enqueuePaymentEvent(tx, {
      id: refundFailedEventId(input.refund.id),
      eventType: 'refund_failed',
      payload: {
        refundId: input.refund.id,
        paymentId: input.payment.id,
        checkoutGroupId: input.payment.checkoutGroupId,
        orderId: input.order.id,
        amountMinor: input.refund.totalRefundedPresentmentAmount,
        currency: input.refund.totalRefundedPresentmentCurrency,
        reason: input.reason,
        ...(input.failureCode ? { failureCode: input.failureCode } : {}),
      },
    });
  });
}

/**
 * The seller-side recovery did not happen.
 *
 * Shared by the refund path and the lost-dispute path, because the condition and
 * the resolution are identical: Mercaria is out money it is owed by one seller
 * on one order, and recovering it is a decision (wait for their next transfer,
 * debit the negative balance, write it off) rather than a retry.
 */
export async function recordReversalFailed(input: {
  subjectId: string;
  subjectKind: 'refund' | 'dispute';
  payment: PaymentRow;
  order: LinkedOrder;
  amount: Money;
  reason: string;
}): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await enqueuePaymentEvent(tx, {
      id: reversalFailedEventId(input.subjectId, input.order.id),
      eventType: 'reversal_failed',
      payload: {
        subjectKind: input.subjectKind,
        ...(input.subjectKind === 'refund'
          ? { refundId: input.subjectId }
          : { disputeId: input.subjectId }),
        paymentId: input.payment.id,
        checkoutGroupId: input.payment.checkoutGroupId,
        orderId: input.order.id,
        amountMinor: input.amount.amount,
        currency: input.amount.currency,
        reason: input.reason,
      },
    });
  });
}

/** Re-exported so the dispute path shares one definition of the owner mapping. */
export { ownerTypeOf, recoverableFrom };

/** Re-exported for the dispute path's own proration and for the tests that pin it. */
export { sellerLiabilityAt };

/** The provider ids whose refunds go through this module at all. */
export function refundGoesThroughProvider(provider: PaymentProviderId): boolean {
  // A rail that can settle a seller order is a rail that can un-settle one, and
  // those are exactly the payments whose refunds move Mercaria's money. The two
  // that record rather than make payments (`external`, `manual_pos`) refund
  // wherever they were captured — issue #49, scope 9 — and `mock` resolves to a
  // rail that holds no seller accounts.
  const adapter = resolvePaymentProvider(provider);
  return adapter !== undefined && isSettlingProvider(adapter);
}
