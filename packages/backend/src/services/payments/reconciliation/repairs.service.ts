/**
 * The four named repairs an operator may run — issue #50, operator surface 6
 * and the repair invariants.
 *
 * ## A CLOSED set is the security property, not a convenience
 *
 * Every action here is a named path through code that already exists and is
 * already idempotent. This module adds a TRIGGER for those paths and no new way
 * to move money. The alternative anybody reaches for first — an endpoint taking
 * a table, a row and a patch — would be a second, unreviewed write path into the
 * financial record, reachable by whoever holds an operator credential, carrying
 * none of the compare-and-swaps the real paths carry.
 *
 * ## The acceptance-5 rule, and how it is STRUCTURAL rather than reviewed
 *
 * "No recovery action can mark a payment successful without verified provider
 * evidence." Nothing in this file calls `applyPaymentStatus`. Three of the four
 * actions reach a payment's status only through a service that calls it after a
 * live provider RESPONSE — `executeRefundAtProvider` moves a payment to
 * `partially_refunded` only once the rail has returned a succeeded refund — and
 * the fourth never touches a status at all.
 *
 * Two of the actions additionally REFUSE outright unless the payment is already
 * settled, so an operator cannot even attempt to settle a seller out of a charge
 * that has not been funded. That refusal is not defence in depth for the rule
 * above; it is a different rule (you cannot transfer money the platform has not
 * received) that happens to make the first one unreachable twice over.
 *
 * ## Idempotency comes from the services, EXCEPT for the ledger one
 *
 * The three retries derive their provider idempotency keys from Mercaria's own
 * durable ids (ADR 0001 D11 — `tr:<paymentId>:<orderId>`, `re:<refundId>`,
 * `trr:<refundId>:<orderId>`), so a second attempt converges on the movement the
 * first one made. Recording a claim HERE would be worse than useless: it would
 * refuse the legitimate second attempt after a failure, which is precisely the
 * case an operator reaches for a repair in.
 *
 * `book_reconciling_entry` has no underlying key — a correcting transaction
 * booked twice is simply booked twice — so its claim lives in
 * `payment_repairs`'s partial unique index and is taken in the SAME transaction
 * as the posting it guards.
 *
 * ## Every attempt is recorded, including the refusals
 *
 * A refusal is a decision the surface made about somebody's money, and issue
 * #50's repair invariant 9 asks for a complete audit event per action rather
 * than per successful action. So `refuse()` writes a row too, and the reason an
 * operator gave is stored with it.
 */

import type {
  CurrencyCode,
  LedgerAccount,
  LedgerOwnerType,
  PaymentRepairAction,
  PaymentRepairOutcome,
} from '@mercaria/shared-types';
import { getDb } from '../../../db/postgres.js';
import {
  findPaymentById,
  findTransferForOrder,
  type PaymentRow,
} from '../../../db/payments/paymentRepository.js';
import { applyRefundProviderState, findRefundById } from '../../../db/orders/refundRepository.js';
import {
  findProviderAccountByOwner,
  type ProviderAccountRow,
} from '../../../db/payments/providerAccountRepository.js';
import {
  insertLedgerTransaction,
  type LedgerEntryInput,
} from '../../../db/payments/ledgerRepository.js';
import { recordRepair } from '../../../db/payments/repairRepository.js';
import {
  closeDiscrepancy,
  findDiscrepancyById,
} from '../../../db/payments/discrepancyRepository.js';
import { findLinkedOrder } from '../order-linkage.js';
import { settlePaymentTransfers } from '../settlement.service.js';
import { executeRefundAtProvider } from '../refund-execution.service.js';
import { retryDisputeRecovery } from '../dispute.service.js';
import { syncAccountRow } from '../stripe/account.service.js';
import { adjustment } from '../ledger-postings.js';
import { log } from '../../../lib/logger.js';

/**
 * Raised when a repair cannot be run as asked.
 *
 * A distinct class so the HTTP surface can answer 409 rather than 500: the
 * request was understood and the state refused it, which is a different thing
 * from the repair failing. The message is written for an operator and is safe to
 * render — it names ids and states, never a provider payload.
 */
export class RepairRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepairRefusedError';
  }
}

/** What every repair request carries. */
export interface RepairRequestBase {
  actorOxyUserId: string;
  /** Required by issue #50's repair invariant 9. Stored verbatim. */
  reason: string;
  /**
   * The finding this answers. Optional for the three retries — a
   * `transfer_withheld` outbox row is a perfectly good reason to retry a
   * transfer and has no discrepancy behind it — and MANDATORY for
   * `book_reconciling_entry`, where the database enforces it.
   */
  discrepancyId?: string;
  /** Resolve the discrepancy when the repair applies. Default true. */
  resolveDiscrepancy?: boolean;
}

/** The four requests, discriminated by `action`. */
export type RepairRequest =
  | (RepairRequestBase & {
      action: 'retry_withheld_transfer';
      paymentId: string;
      orderId: string;
    })
  | (RepairRequestBase & {
      action: 'retry_transfer_reversal';
      subjectKind: 'refund' | 'dispute';
      subjectId: string;
    })
  | (RepairRequestBase & { action: 'retry_provider_refund'; refundId: string })
  | (RepairRequestBase & {
      action: 'book_reconciling_entry';
      discrepancyId: string;
      currency: CurrencyCode;
      entries: readonly ReconcilingEntry[];
    });

/** One leg of a correcting transaction, as an operator states it. */
export interface ReconcilingEntry {
  account: LedgerAccount;
  /** SIGNED minor units — positive debit, negative credit. Never zero. */
  amountMinor: bigint;
  ownerType?: LedgerOwnerType;
  ownerId?: string;
  orderId?: string;
}

/** What running a repair produced. */
export interface RepairResult {
  action: PaymentRepairAction;
  outcome: PaymentRepairOutcome;
  /** One sentence for the operator. Safe to render — ids and states only. */
  note: string;
  repairId: string;
  ledgerTransactionId?: string;
}

/**
 * Run one named repair.
 *
 * @throws {RepairRefusedError} When the state makes the repair unsafe or
 *   meaningless. The refusal is RECORDED first, so a 409 an operator sees has an
 *   audit row behind it.
 */
export async function runRepair(request: RepairRequest): Promise<RepairResult> {
  switch (request.action) {
    case 'retry_withheld_transfer':
      return await retryWithheldTransfer(request);
    case 'retry_transfer_reversal':
      return await retryTransferReversal(request);
    case 'retry_provider_refund':
      return await retryProviderRefund(request);
    case 'book_reconciling_entry':
      return await bookReconcilingEntry(request);
  }
}

/**
 * Re-attempt a transfer ADR 0001 D4 withheld.
 *
 * ## The account is RE-READ from the rail before anything is attempted
 *
 * `settlePaymentTransfers` checks readiness itself, from the local
 * `provider_accounts` row — which is refreshed by a sweep on a six-hour clock.
 * That is right for the automatic path and wrong for this one: an operator runs
 * this repair BECAUSE a seller has just fixed their account, and a stale local
 * `restricted` would refuse a transfer the rail would now accept, while a stale
 * local `ready` would send money at an account the rail will refuse. The
 * re-read makes "requires readiness NOW" literal.
 */
async function retryWithheldTransfer(
  request: Extract<RepairRequest, { action: 'retry_withheld_transfer' }>,
): Promise<RepairResult> {
  const db = getDb();
  const subjectKey = `${request.paymentId}:${request.orderId}`;

  const payment = await requireSettledPayment(request, subjectKey, request.paymentId);
  const order = await findLinkedOrder(request.orderId);
  if (!order) {
    return await refuse(request, subjectKey, `Order ${request.orderId} does not exist.`, {
      paymentId: payment.id,
    });
  }

  const existing = await findTransferForOrder(db, payment.id, order.id);
  if (existing?.providerObjectId) {
    return await settle(request, {
      subjectKey,
      outcome: 'no_op',
      note: `Order ${order.id} was already settled; the transfer exists at the rail.`,
      detail: { transferId: existing.id, providerObjectId: existing.providerObjectId },
      paymentId: payment.id,
      orderId: order.id,
    });
  }

  const account = await refreshSellerAccount(order.sellerType === 'store' ? 'store' : 'user', order.sellerOwnerId);
  if (!account) {
    return await refuse(
      request,
      subjectKey,
      `The seller of order ${order.id} has no connected account on this rail, so there is ` +
        'nowhere to transfer to.',
      { paymentId: payment.id, orderId: order.id },
    );
  }
  if (account.onboardingState !== 'ready') {
    return await refuse(
      request,
      subjectKey,
      `The seller's account is '${account.onboardingState}' at the rail right now, not 'ready'. ` +
        'Re-run this once they have finished; retrying against an unready account produces the ' +
        'same withheld transfer.',
      { paymentId: payment.id, orderId: order.id, onboardingState: account.onboardingState },
    );
  }

  // The whole payment, not just this order. `settlePaymentTransfers` is
  // idempotent per order (`UNIQUE(payment_id, order_id)` plus the rail's own
  // `tr:` key), so its siblings are skipped — and running the real settlement
  // means the ledger posting, the transfer row and the rail call stay one code
  // path rather than becoming a second one only operators exercise.
  const outcome = await settlePaymentTransfers(payment.id);
  const settled = await findTransferForOrder(db, payment.id, order.id);
  const applied = settled?.providerObjectId != null;

  return await settle(request, {
    subjectKey,
    outcome: applied ? 'applied' : 'no_op',
    note: applied
      ? `Transfer created for order ${order.id}.`
      : `The settlement ran and order ${order.id} is still withheld; read the transfer_withheld ` +
        'exception for the rail’s own reason.',
    detail: { ...outcome, ...(settled?.providerObjectId ? { providerObjectId: settled.providerObjectId } : {}) },
    paymentId: payment.id,
    orderId: order.id,
  });
}

/**
 * Re-attempt the seller-side recovery of a refund or a lost dispute.
 *
 * The buyer is never touched. ADR 0001 D7 is explicit that their refund is not
 * undone by a failed recovery, so what is at stake here is only whether Mercaria
 * has got its own share back — which is why this can be retried freely and why a
 * failure leaves the order's `merchant_payable` open rather than reversing
 * anything.
 */
async function retryTransferReversal(
  request: Extract<RepairRequest, { action: 'retry_transfer_reversal' }>,
): Promise<RepairResult> {
  const subjectKey = `${request.subjectKind}:${request.subjectId}`;

  if (request.subjectKind === 'dispute') {
    const result = await retryDisputeRecovery(request.subjectId);
    if (result.refusedBecause !== undefined) {
      return await refuse(request, subjectKey, result.refusedBecause, {
        disputeId: request.subjectId,
      });
    }
    return await settle(request, {
      subjectKey,
      outcome: result.recovery === 'succeeded' ? 'applied' : 'no_op',
      note: `Dispute recovery reported '${result.recovery}'.`,
      detail: { disputeId: request.subjectId, recovery: result.recovery },
    });
  }

  const refund = await findRefundById(request.subjectId);
  if (!refund) {
    return await refuse(request, subjectKey, `Refund ${request.subjectId} does not exist.`, {});
  }
  if (refund.providerState !== 'succeeded') {
    return await refuse(
      request,
      subjectKey,
      `The buyer's refund is '${String(refund.providerState)}', not 'succeeded'. There is no ` +
        'seller share to recover until the buyer has actually been paid.',
      { refundId: refund.id, providerState: refund.providerState },
    );
  }

  // `executeRefundAtProvider` short-circuits the buyer half (the refund already
  // carries its provider id and a succeeded state) and re-runs the recovery.
  // Running the whole executor rather than reaching for the private recovery
  // step is what keeps the proration, the reversal key and the ledger posting on
  // one path — three readers of one definition, exactly as #49 designed.
  const result = await executeRefundAtProvider(refund.id);
  return await settle(request, {
    subjectKey,
    outcome: result.reversal === 'succeeded' ? 'applied' : 'no_op',
    note: `Refund recovery reported '${result.reversal}'.`,
    detail: { refundId: refund.id, reversal: result.reversal, ...(result.note ? { railNote: result.note } : {}) },
    ...(refund.paymentId ? { paymentId: refund.paymentId } : {}),
    orderId: refund.orderId,
  });
}

/**
 * Re-issue a BUYER refund the rail refused.
 *
 * The one repair that undoes a terminal state before acting, and it is the
 * reason it is an operator action rather than a retry loop: `refund.provider_state
 * = 'failed'` is what stops the outbox trying for ever, so re-opening it is a
 * decision that the condition which caused the refusal has passed. The runbook
 * says to read `provider_failure_code` first — `charge_already_refunded` means
 * somebody refunded in the dashboard, and re-issuing then would refund a buyer
 * twice.
 *
 * The rail's own idempotency key (`re:<refundId>`) is what makes that survivable
 * rather than catastrophic: a second create for one Mercaria refund converges on
 * the refund object the first one made. It is not a licence to run this blind —
 * the key expires after 24 hours — which is why the reason field is mandatory.
 */
async function retryProviderRefund(
  request: Extract<RepairRequest, { action: 'retry_provider_refund' }>,
): Promise<RepairResult> {
  const db = getDb();
  const subjectKey = request.refundId;

  const refund = await findRefundById(request.refundId);
  if (!refund) {
    return await refuse(request, subjectKey, `Refund ${request.refundId} does not exist.`, {});
  }
  if (refund.providerState === 'succeeded') {
    return await settle(request, {
      subjectKey,
      outcome: 'no_op',
      note: 'The buyer has already been refunded at the rail.',
      detail: { refundId: refund.id, providerState: refund.providerState },
      ...(refund.paymentId ? { paymentId: refund.paymentId } : {}),
      orderId: refund.orderId,
    });
  }
  if (refund.providerState !== 'failed' && refund.providerState !== 'canceled') {
    return await refuse(
      request,
      subjectKey,
      `The refund's money is '${String(refund.providerState)}'; it has not been refused, so the ` +
        'outbox is still going to move it. Re-issuing now would race that.',
      { refundId: refund.id, providerState: refund.providerState },
    );
  }

  // Re-open the terminal state so the executor will act, and clear the code the
  // operator has just read and decided about — leaving it would show a merchant
  // a failure code for a refund that is now in flight.
  await applyRefundProviderState(db, {
    refundId: refund.id,
    providerState: 'pending',
    clearFailureCode: true,
  });

  const result = await executeRefundAtProvider(refund.id);
  return await settle(request, {
    subjectKey,
    outcome: result.refunded ? 'applied' : 'no_op',
    note: result.refunded
      ? `The rail returned the buyer's money; the seller-side recovery reported '${result.reversal}'.`
      : 'The rail refused the refund again; a new refund_failed exception has been raised.',
    detail: {
      refundId: refund.id,
      refunded: result.refunded,
      reversal: result.reversal,
      previousFailureCode: refund.providerFailureCode,
      ...(result.note ? { railNote: result.note } : {}),
    },
    ...(refund.paymentId ? { paymentId: refund.paymentId } : {}),
    orderId: refund.orderId,
  });
}

/**
 * Book a balanced correcting transaction against a discrepancy.
 *
 * The ONLY way this surface writes the ledger, and it writes it the one way the
 * ledger permits: a NEW `adjustment` transaction whose entries the operator
 * supplies, validated by `insertLedgerTransaction` — the same repository every
 * automatic posting goes through, which refuses an unbalanced set before issuing
 * SQL. There is no path here that edits an existing transaction, and the
 * append-only trigger would refuse one anyway.
 *
 * ## The claim and the posting commit together
 *
 * The audit row's partial unique index (`WHERE action = 'book_reconciling_entry'
 * AND outcome = 'applied'`) is the only thing stopping a correction being booked
 * twice for one discrepancy. Committed separately, a crash between them would
 * leave either a correction nothing recorded or a claim on a correction that
 * never happened — so they are one transaction, and a duplicate loses the index
 * race and rolls the whole thing back.
 */
async function bookReconcilingEntry(
  request: Extract<RepairRequest, { action: 'book_reconciling_entry' }>,
): Promise<RepairResult> {
  const db = getDb();
  const subjectKey = request.discrepancyId;

  const discrepancy = await findDiscrepancyById(db, request.discrepancyId);
  if (!discrepancy) {
    return await refuse(
      request,
      subjectKey,
      `Discrepancy ${request.discrepancyId} does not exist. A correcting ledger entry must name ` +
        'the finding it answers — an unexplained movement is the one thing the ledger may not hold.',
      {},
    );
  }
  if (request.entries.length < 2) {
    return await refuse(
      request,
      subjectKey,
      'A correcting transaction needs at least two entries to balance.',
      { discrepancyId: discrepancy.id },
    );
  }

  const posting = adjustment({
    description: request.reason,
    ...(discrepancy.paymentId ? { paymentId: discrepancy.paymentId } : {}),
    ...(discrepancy.orderId ? { orderId: discrepancy.orderId } : {}),
    entries: request.entries.map((entry) => ({
      account: entry.account,
      currency: request.currency,
      amountMinor: entry.amountMinor,
      ...(entry.ownerType ? { ownerType: entry.ownerType } : {}),
      ...(entry.ownerId ? { ownerId: entry.ownerId } : {}),
      ...(entry.orderId ? { orderId: entry.orderId } : {}),
    })) satisfies LedgerEntryInput[],
  });

  let repairId: string;
  let ledgerTransactionId: string;
  try {
    ({ repairId, ledgerTransactionId } = await db.transaction(async (tx) => {
      const inserted = await insertLedgerTransaction(tx, posting.transaction, posting.entries);
      const repair = await recordRepair(tx, {
        action: request.action,
        subjectKey,
        discrepancyId: discrepancy.id,
        actorOxyUserId: request.actorOxyUserId,
        reason: request.reason,
        outcome: 'applied',
        detail: {
          currency: request.currency,
          entries: request.entries.map((entry) => ({
            account: entry.account,
            amountMinor: entry.amountMinor.toString(),
            ...(entry.orderId ? { orderId: entry.orderId } : {}),
          })),
        },
        ...(discrepancy.paymentId ? { paymentId: discrepancy.paymentId } : {}),
        ...(discrepancy.orderId ? { orderId: discrepancy.orderId } : {}),
        ledgerTransactionId: inserted.id,
      });
      return { repairId: repair.id, ledgerTransactionId: inserted.id };
    }));
  } catch (error: unknown) {
    // A UNIQUE violation on the claim means this correction is already in the
    // book. That is the idempotent answer, not a failure — and it is reported as
    // `no_op` rather than raised, so an operator re-running a repair after a
    // timeout is told what happened rather than shown an error.
    if (isDuplicateRepairClaim(error)) {
      log.general.info(
        { discrepancyId: discrepancy.id, actor: request.actorOxyUserId },
        '[Reconciliation] a reconciling entry for this discrepancy was already booked',
      );
      return await settle(request, {
        subjectKey,
        outcome: 'no_op',
        note: 'A reconciling entry for this discrepancy has already been booked.',
        detail: { discrepancyId: discrepancy.id },
      });
    }
    // Unbalanced entries land here. The repository names the offending currency
    // and its total; that message is safe to show an operator and is what tells
    // them which leg they got wrong.
    throw new RepairRefusedError(error instanceof Error ? error.message : String(error));
  }

  auditLog(request, subjectKey, 'applied', { ledgerTransactionId });
  await maybeResolveDiscrepancy(request, 'applied', `Booked reconciling entry ${ledgerTransactionId}.`);
  return {
    action: request.action,
    outcome: 'applied',
    note: `Booked a balanced ${request.currency} correction against discrepancy ${discrepancy.id}.`,
    repairId,
    ledgerTransactionId,
  };
}

/**
 * The payment a settlement repair acts on, or a refusal.
 *
 * Refuses anything that is not already settled, which is the second of the two
 * guards behind acceptance 5 — see the file docblock. Transferring a seller
 * their share of a charge the platform has not received would create money.
 */
async function requireSettledPayment(
  request: RepairRequest,
  subjectKey: string,
  paymentId: string,
): Promise<PaymentRow> {
  const payment = await findPaymentById(getDb(), paymentId);
  if (!payment) {
    return await refuse(request, subjectKey, `Payment ${paymentId} does not exist.`, {});
  }
  if (
    payment.status !== 'succeeded' &&
    payment.status !== 'partially_refunded' &&
    payment.status !== 'refunded'
  ) {
    return await refuse(
      request,
      subjectKey,
      `Payment ${paymentId} is '${payment.status}'. A seller cannot be settled out of a charge ` +
        'the platform has not received — nothing here may mark a payment successful, so re-run ' +
        'this once the payment has actually settled.',
      { paymentId, status: payment.status },
    );
  }
  return payment;
}

/**
 * Re-read a seller's connected account from the rail before trusting it.
 *
 * Best effort on the READ and strict on the answer: if the rail cannot be
 * reached the local row is used, which is the same row `settlePaymentTransfers`
 * would have consulted anyway — so a Stripe outage makes this repair no worse
 * than the automatic path rather than impossible.
 */
async function refreshSellerAccount(
  ownerType: 'store' | 'user',
  ownerId: string,
): Promise<ProviderAccountRow | undefined> {
  const row = await findProviderAccountByOwner(getDb(), { provider: 'stripe', ownerType, ownerId });
  if (!row) return undefined;
  try {
    return await syncAccountRow(row);
  } catch (error: unknown) {
    log.general.warn(
      { err: error, accountRowId: row.id },
      '[Reconciliation] could not re-read a connected account before a repair; using the ' +
        'stored row, which is what the automatic settlement would have used',
    );
    return row;
  }
}

/** Record an applied or no-op attempt, and close the finding when asked. */
async function settle(
  request: RepairRequest,
  input: {
    subjectKey: string;
    outcome: Exclude<PaymentRepairOutcome, 'refused'>;
    note: string;
    detail: Record<string, unknown>;
    paymentId?: string;
    orderId?: string;
  },
): Promise<RepairResult> {
  const repair = await recordRepair(getDb(), {
    action: request.action,
    subjectKey: input.subjectKey,
    actorOxyUserId: request.actorOxyUserId,
    reason: request.reason,
    outcome: input.outcome,
    detail: input.detail,
    ...(request.discrepancyId ? { discrepancyId: request.discrepancyId } : {}),
    ...(input.paymentId ? { paymentId: input.paymentId } : {}),
    ...(input.orderId ? { orderId: input.orderId } : {}),
  });
  auditLog(request, input.subjectKey, input.outcome, input.detail);
  if (input.outcome === 'applied') {
    await maybeResolveDiscrepancy(request, 'applied', input.note);
  }
  return { action: request.action, outcome: input.outcome, note: input.note, repairId: repair.id };
}

/**
 * Record a refusal and raise it.
 *
 * The row is written BEFORE the throw, so a 409 an operator sees always has an
 * audit entry behind it — issue #50's repair invariant 9 asks for an audit event
 * per ACTION, and declining to act on somebody's money is an action.
 *
 * @throws {RepairRefusedError} Always. The return type is a lie the callers rely
 *   on for control flow, so it is declared `never` and every call site reads as
 *   a terminal statement.
 */
async function refuse(
  request: RepairRequest,
  subjectKey: string,
  message: string,
  detail: Record<string, unknown>,
): Promise<never> {
  await recordRepair(getDb(), {
    action: request.action,
    subjectKey,
    actorOxyUserId: request.actorOxyUserId,
    reason: request.reason,
    outcome: 'refused',
    detail: { ...detail, refusedBecause: message },
    ...(request.discrepancyId ? { discrepancyId: request.discrepancyId } : {}),
  });
  auditLog(request, subjectKey, 'refused', { ...detail, refusedBecause: message });
  throw new RepairRefusedError(message);
}

/**
 * One structured line per attempt, at a level that reflects what happened.
 *
 * Beside the durable row rather than instead of it: the row is the audit and the
 * log is what an aggregated store alerts on. Neither carries a contact value or
 * a token (issue #50, repair invariant 10) — the fields are ids, states and the
 * operator's own reason.
 */
function auditLog(
  request: RepairRequest,
  subjectKey: string,
  outcome: PaymentRepairOutcome,
  detail: Record<string, unknown>,
): void {
  const context = {
    action: request.action,
    subjectKey,
    outcome,
    actor: request.actorOxyUserId,
    reason: request.reason,
    discrepancyId: request.discrepancyId,
    detail,
  };
  if (outcome === 'applied') {
    log.general.warn(context, '[Reconciliation] operator repair applied');
  } else {
    log.general.info(context, '[Reconciliation] operator repair did not change anything');
  }
}

/** Close the finding a successful repair answered, unless the operator said not to. */
async function maybeResolveDiscrepancy(
  request: RepairRequest,
  outcome: PaymentRepairOutcome,
  note: string,
): Promise<void> {
  if (request.discrepancyId === undefined) return;
  if (request.resolveDiscrepancy === false) return;
  if (outcome !== 'applied') return;
  await closeDiscrepancy(getDb(), {
    discrepancyId: request.discrepancyId,
    status: 'resolved',
    actorOxyUserId: request.actorOxyUserId,
    reason: `repair:${request.action}`,
    note,
  });
}

/**
 * Whether a thrown error is the partial unique index refusing a second applied
 * `book_reconciling_entry`.
 *
 * ## The CONSTRAINT NAME, never the class or the message
 *
 * The ledger insert runs in this same transaction, so a unique violation here
 * could also be one of its constraints — and misreading that as "already
 * booked" would swallow a real failure and report a correction that never
 * landed. The name is the only discriminator that cannot be confused.
 *
 * ## It walks the CAUSE chain, and that is not defensive padding
 *
 * drizzle wraps a driver error in its own `Failed query: …` error and puts the
 * `PostgresError` — the only object carrying `code` and `constraint_name` — on
 * `cause`. Reading the outer error alone finds neither field, so the duplicate
 * is reported as an unexplained failure and the operator is told their
 * correction did not happen when it already had. Measured: the first version of
 * this function inspected only the top-level error and turned the idempotent
 * second call into a 409.
 */
function isDuplicateRepairClaim(error: unknown): boolean {
  for (let candidate: unknown = error; candidate !== undefined && candidate !== null; ) {
    if (typeof candidate !== 'object') return false;
    const shaped = candidate as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (
      shaped.code === '23505' &&
      (shaped.constraint_name ?? shaped.constraint) === 'payment_repairs_reconciling_entry_key'
    ) {
      return true;
    }
    candidate = shaped.cause;
  }
  return false;
}
