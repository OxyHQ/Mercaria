/**
 * The marketplace's events beyond a payment's status, as Peable delivers them:
 * a seller's connected account changing, a seller's payout moving, a refund's
 * money moving after its answer, and a card network disputing a charge.
 *
 * They ride the same signed ingress, dedupe key, lease and replay as the
 * payment events (`event-router.ts` merges this table), and like every handler
 * there none applies a PAYLOAD: deliveries are unordered and a snapshot is the
 * state that WAS, so each handler takes the object id the verifier stored
 * unredacted and re-reads the gateway.
 *
 * Peable emits no transfer events and none are needed: a transfer and its
 * reversals are Mercaria's own calls, whose answers `settlement.service` and
 * the refund/dispute recovery record synchronously.
 */

import type { CurrencyCode, RefundProviderState } from '@mercaria/shared-types';
import type { Refund } from '@peable.to/sdk';
import { findRefundByProviderRefundId } from '../../../db/orders/refundRepository.js';
import { findPaymentByProviderObjectId } from '../../../db/payments/paymentRepository.js';
import { getDb } from '../../../db/postgres.js';
import { log } from '../../../lib/logger.js';
import { enqueuePaymentEvent, refundUnmatchedEventId } from '../payment-outbox.service.js';
import { recordDispute } from '../dispute.service.js';
import { recordPayout } from '../payout.service.js';
import { PaymentProviderError } from '../provider.js';
import { applyRailRefundState } from '../refund-execution.service.js';
import { peableGateway, redactAccountId, syncPeableAccount } from './accounts.js';
import { fromGatewayAmount } from './amounts.js';
import { callPeable } from './errors.js';
import type { PeableEventContext, PeableEventHandler, PeableEventOutcome } from './event-router.js';
import { settledMovement } from './settlement.js';

/** An event naming an object this handler cannot work from — never retryable. */
function malformed(message: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'peable',
    stage: 'verifyEvent',
    message,
    retryable: false,
  });
}

/** A provider failure CODE, or nothing — a code shape is all a seller surface may show. */
function safeCode(code: string | null): string | undefined {
  return code !== null && /^[a-z][a-z0-9_]*$/.test(code) ? code : undefined;
}

/**
 * A seller's connected account changed: requirements, capabilities, payouts.
 *
 * An account Mercaria has no row for is `ignored`: one the gateway opened for
 * another environment, or one whose create answer this task has not finished
 * recording — and that create applies its own read, so nothing is lost.
 */
async function handleConnectedAccount(context: PeableEventContext): Promise<PeableEventOutcome> {
  const accountId = context.objectIds.connected_account;
  if (accountId === undefined) {
    throw malformed(`Peable event ${context.providerEventId} names no connected account.`);
  }
  const row = await syncPeableAccount(accountId);
  if (!row) {
    return {
      kind: 'ignored',
      note: `${redactAccountId(accountId)} is not a seller account Mercaria opened`,
    };
  }
  return {
    kind: 'applied',
    note: `seller account ${redactAccountId(accountId)} re-read; it is '${row.onboardingState}'`,
  };
}

/**
 * Payout health — Peable mirroring a SELLER's balance moving to their bank.
 *
 * It books nothing (ADR 0001 D6 settles the receivable when the TRANSFER is
 * made; a failed payout must not reopen it, or Mercaria would owe a seller
 * twice). The payout is re-read as the seller's account (`Peable-Account`),
 * because a payout belongs to that account and the platform does not own it.
 */
async function handlePayout(context: PeableEventContext): Promise<PeableEventOutcome> {
  const payoutId = context.objectIds.payout;
  const accountId = context.objectIds.connected_account;
  if (payoutId === undefined || accountId === undefined) {
    throw malformed(`Peable event ${context.providerEventId} names no payout and account.`);
  }
  const payout = await callPeable('getStatus', () =>
    peableGateway().payouts.retrieve(payoutId, {}, { peableAccount: accountId }),
  );
  const failureCode = safeCode(payout.failure_code);
  const recorded = await recordPayout({
    provider: 'peable',
    providerAccountId: accountId,
    providerObjectId: payout.id,
    amount: {
      amount: fromGatewayAmount(payout.amount, 'getStatus'),
      // NOT narrowed to Mercaria's currencies: a seller settles in their
      // account's own currency, which `payouts.amount_currency` leaves unCHECKed.
      currency: payout.currency as CurrencyCode,
    },
    status: payout.status,
    ...(payout.arrival_date === null ? {} : { arrivalAt: new Date(payout.arrival_date * 1_000) }),
    ...(failureCode ? { failureCode } : {}),
  });
  if (payout.status === 'failed') {
    log.general.error(
      { payoutId: recorded.row.id, sellerKey: recorded.sellerKey, failureCode },
      '[Payments] a seller payout failed at the rail; their balance is unchanged and the rail ' +
        'will usually retry, but this is what a support request will be about (#50)',
    );
  }
  return {
    kind: 'applied',
    note:
      `payout ${recorded.row.id} is '${recorded.row.status}' for ` +
      `${recorded.sellerKey ?? 'an account Mercaria has no row for'}`,
  };
}

/**
 * A refund Mercaria did not make — one made at the acquirer (`origin:
 * 'provider'`) or naming no refund of Mercaria's.
 *
 * Recorded as an operator exception and NOT as a refund: no local refund is
 * created and no stock is restocked, because whether these goods come back is
 * a commerce decision the rail cannot make. Keyed on the gateway's refund id,
 * the only durable id this condition has, so every redelivery converges on one
 * case.
 */
async function recordUnmatchedRefund(refund: Refund): Promise<string | undefined> {
  const id = refundUnmatchedEventId('peable', refund.id);
  const created = await getDb().transaction(
    async (tx) =>
      await enqueuePaymentEvent(tx, {
        id,
        eventType: 'refund_unmatched',
        payload: {
          provider: 'peable',
          providerRefundId: refund.id,
          amountMinor: fromGatewayAmount(refund.amount, 'refund'),
          currency: refund.currency,
          status: refund.status,
        },
      }),
  );
  return created ? id : undefined;
}

/**
 * A refund's money moved: `refund.created|updated|failed`.
 *
 * Re-read, then matched to Mercaria's refund by the gateway's `external_ref`
 * (Mercaria's refund id, which closes the window before the executor recorded
 * the gateway's id) or by that recorded id. The payment's own status is the
 * `charge.refunded` handler's; this one owns the REFUND's state.
 *
 * Scoped to refunds of a MARKETPLACE payment. Mercaria's Peable merchant also
 * collects merchant-plan invoices (#89), whose refunds are billing's and must
 * not be raised here as marketplace refunds nobody made.
 */
async function handleRefund(context: PeableEventContext): Promise<PeableEventOutcome> {
  const refundId = context.objectIds.refund;
  const intentId = context.objectIds.payment_intent;
  if (refundId === undefined || intentId === undefined) {
    throw malformed(`Peable event ${context.providerEventId} names no refund and payment.`);
  }
  const payment = await findPaymentByProviderObjectId(getDb(), 'peable', intentId);
  if (!payment) {
    return { kind: 'ignored', note: `${intentId} is not a marketplace payment` };
  }
  const refund = await callPeable('refund', () => peableGateway().refunds.retrieve(refundId));
  const local =
    (refund.external_ref === null ? undefined : refund.external_ref) ??
    (await findRefundByProviderRefundId('peable', refund.id))?.id;
  const state: RefundProviderState = refund.status;
  const failureCode = safeCode(refund.failure_code);
  const applied =
    local === undefined
      ? undefined
      : await applyRailRefundState({
          refundId: local,
          state,
          ...(failureCode ? { failureCode } : {}),
        });

  if (!applied) {
    const raised = await recordUnmatchedRefund(refund);
    return {
      kind: 'applied',
      paymentId: payment.id,
      note:
        `EXCEPTION: Peable refund ${refund.id} of payment ${payment.id} matches no Mercaria ` +
        'refund; NO local refund was ' +
        `created and NO stock was restocked${raised ? ` — raised as ${raised}` : ' — already raised'}`,
    };
  }
  return {
    kind: 'applied',
    ...(applied.paymentId ? { paymentId: applied.paymentId } : {}),
    note: applied.changed
      ? `refund ${String(local)} is now '${state}' at the rail`
      : `refund ${String(local)} was already '${state}'; nothing applied twice`,
  };
}

/**
 * A dispute: record where it stands, book what it withdrew, recover on a loss.
 *
 * Every `charge.dispute.*` type lands here, because they are observations of
 * ONE object and nothing orders them — a `closed` can arrive before a
 * `created` Mercaria never received. `dispute.service` upserts the row and
 * gates each ledger transition on a compare-and-swap, so any arrival order
 * converges on the same books (ADR 0001 D7).
 *
 * The amount and the fee are the dispute's WITHDRAWAL as the acquirer recorded
 * it (`disputes.settlement`), never the dispute's own `amount`: that is
 * populated for an inquiry too, and booking it would debit the ledger for a
 * chargeback that has not happened. No withdrawal (`unknown`) is recorded as an
 * inquiry — zero, nothing booked — and the next observation (the
 * `funds_withdrawn` that follows a real chargeback, an update, the close)
 * re-reads it and books then.
 */
async function handleDispute(context: PeableEventContext): Promise<PeableEventOutcome> {
  const disputeId = context.objectIds.dispute;
  const intentId = context.objectIds.payment_intent;
  if (disputeId === undefined || intentId === undefined) {
    throw malformed(`Peable event ${context.providerEventId} names no dispute and payment.`);
  }
  const payment = await findPaymentByProviderObjectId(getDb(), 'peable', intentId);
  if (!payment) {
    // A marketplace dispute always names a payment Mercaria recorded long
    // before; one that names none is not the marketplace's (a merchant-plan
    // invoice payment is billing's).
    return { kind: 'ignored', note: `${intentId} is not a marketplace payment` };
  }

  const dispute = await callPeable('getStatus', () => peableGateway().disputes.retrieve(disputeId));
  const settlement = await callPeable('getStatus', () =>
    peableGateway().disputes.settlement(disputeId),
  );
  const disputeCurrency = dispute.currency as CurrencyCode;
  const withdrawal = settledMovement(settlement, disputeCurrency, 'getStatus');
  const outcome =
    dispute.status === 'won' || dispute.status === 'lost' ? dispute.status : undefined;
  if (outcome === 'lost' && !withdrawal) {
    // A LOST dispute withdrew money — an inquiry never ends lost — so a missing
    // figure here is the gateway not reaching the acquirer, not a zero. Closing
    // it now would recover nothing from the seller; retry until it is reported.
    throw new PaymentProviderError({
      provider: 'peable',
      stage: 'verifyEvent',
      message: `Peable has not reported what lost dispute ${disputeId} withdrew yet`,
      retryable: true,
    });
  }

  const summary = await recordDispute(
    {
      provider: 'peable',
      providerDisputeId: dispute.id,
      amount: withdrawal?.amount ?? { amount: 0, currency: disputeCurrency },
      feeMinor: withdrawal?.feeMinor ?? 0,
      reason: dispute.reason,
      status: dispute.status,
      ...(dispute.evidence_details.due_by === null
        ? {}
        : { evidenceDueBy: new Date(dispute.evidence_details.due_by * 1_000) }),
      ...(outcome ? { outcome, closedAt: new Date(dispute.updated_at * 1_000) } : {}),
    },
    payment.id,
  );

  const parts = [`dispute ${summary.disputeId} is '${dispute.status}'`];
  if (summary.booked) parts.push('opening debit booked');
  if (summary.closed) parts.push('closed');
  if (summary.recovery) parts.push(`seller recovery: ${summary.recovery}`);
  if (!withdrawal) parts.push('no withdrawal on the balance yet — an inquiry, nothing booked');
  return { kind: 'applied', paymentId: payment.id, note: parts.join('; ') };
}

/** The marketplace's event types and their handlers. */
export const PEABLE_MARKETPLACE_EVENT_HANDLERS: Readonly<Record<string, PeableEventHandler>> = {
  'connected_account.updated': handleConnectedAccount,
  'payout.created': handlePayout,
  'payout.updated': handlePayout,
  'payout.paid': handlePayout,
  'payout.failed': handlePayout,
  'payout.canceled': handlePayout,
  'refund.created': handleRefund,
  'refund.updated': handleRefund,
  'refund.failed': handleRefund,
  'charge.dispute.created': handleDispute,
  'charge.dispute.updated': handleDispute,
  'charge.dispute.closed': handleDispute,
  'charge.dispute.funds_withdrawn': handleDispute,
  'charge.dispute.funds_reinstated': handleDispute,
};
