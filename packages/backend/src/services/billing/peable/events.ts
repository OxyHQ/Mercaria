/**
 * Merchant billing's events (#89), as Peable delivers them.
 *
 * They ride the Peable payment-event infrastructure — the same signature check,
 * the same `payment_provider_events` dedupe key, lease, backoff and operator
 * replay — and share nothing with `payments`: a subscription invoice has no
 * checkout group, orders, seller or transfer, so its correlation lives on
 * `merchant_subscription_events`.
 *
 * No handler applies a PAYLOAD. Deliveries are unordered, so every handler
 * re-reads the object through the registered billing provider and applies what
 * the gateway says NOW.
 *
 * ## The fee gap, stated rather than defaulted
 *
 * A paid invoice books what the payer paid, in the invoice's currency, to
 * `provider_clearing` and `subscription_revenue`, with no processor-fee leg:
 * the gateway's invoice carries no settlement detail, and which settlement
 * figure Mercaria books, at what rate, is the same ledger decision the Peable
 * payment rail is still waiting on (`payments/peable/event-router.ts`). The
 * ledger still balances — the fee line is absent rather than unbalanced — and
 * every such booking says so on its event row.
 */

import { ALL_CURRENCY_CODES, type CurrencyCode } from '@mercaria/shared-types';
import { findSubscriptionByProviderId } from '../../../db/merchantPlans/subscriptionRepository.js';
import { getDb } from '../../../db/postgres.js';
import { PaymentProviderError } from '../../payments/provider.js';
import type {
  PeableEventContext,
  PeableEventHandler,
  PeableEventOutcome,
} from '../../payments/peable/event-router.js';
import { getBillingProvider, type BillingProvider } from '../provider.js';
import {
  applyProviderSubscriptionState,
  recordSubscriptionInvoicePaid,
  type ProviderSubscriptionEventKind,
  type SubscriptionApplyOutcome,
} from '../subscription.service.js';

/** An event naming an object this handler cannot work from — never retryable. */
function malformed(message: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'peable',
    stage: 'verifyEvent',
    message,
    retryable: false,
  });
}

/**
 * A correlation this task cannot make YET — retryable on purpose: the gateway
 * can deliver a subscription event before the transaction that recorded the
 * billing customer is visible here.
 */
function unresolved(message: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'peable',
    stage: 'verifyEvent',
    message,
    retryable: true,
  });
}

/** An invoice currency as a `CurrencyCode`, or a refusal naming it. Never coerced. */
function currencyOf(code: string, context: string): CurrencyCode {
  const match = ALL_CURRENCY_CODES.find((candidate) => candidate === code);
  if (!match) throw malformed(`${context} was paid in ${code}, which Mercaria does not model.`);
  return match;
}

const NO_RAIL: PeableEventOutcome = {
  kind: 'ignored',
  note: 'no billing rail is registered on this deployment, so nothing consumes this event',
};

/**
 * Which audit kind a subscription event appends to an EXISTING row — a new row
 * always records `created` itself.
 */
function eventKindFor(type: string): ProviderSubscriptionEventKind {
  if (type === 'customer.subscription.deleted') return 'expired';
  if (type === 'customer.subscription.paused') return 'paused';
  if (type === 'customer.subscription.resumed') return 'resumed';
  return 'reconciled';
}

/** Turn what applying a snapshot did into the event's outcome. */
function outcomeOf(subscriptionId: string, outcome: SubscriptionApplyOutcome): PeableEventOutcome {
  switch (outcome.outcome) {
    case 'applied':
      return { kind: 'applied', note: `subscription ${outcome.subscription.status}` };
    case 'already_applied':
      return { kind: 'applied', note: 'this event had already been applied' };
    case 'unknown_customer':
      throw unresolved(`No Mercaria store is bound to the customer of ${subscriptionId}.`);
    case 'unknown_price':
      return {
        kind: 'ignored',
        note: 'no plan version on this deployment publishes the price this subscription is on',
      };
    case 'no_acceptance':
      return {
        kind: 'ignored',
        note:
          'no store at this deployment accepted that plan, so the subscription was NOT recorded ' +
          '— Mercaria does not write down a paid plan nobody agreed to',
      };
  }
}

/** Re-read one subscription and apply it, checking it is the customer the event named. */
async function applySubscription(
  provider: BillingProvider,
  context: PeableEventContext,
  subscriptionId: string,
  eventKind: ProviderSubscriptionEventKind,
  note: string,
): Promise<PeableEventOutcome> {
  const snapshot = await provider.retrieveSubscription(subscriptionId);
  if (
    context.objectIds.customer !== undefined &&
    snapshot.providerCustomerId !== context.objectIds.customer
  ) {
    throw malformed('The subscription belongs to a different customer than the event named.');
  }
  return outcomeOf(
    subscriptionId,
    await applyProviderSubscriptionState({
      snapshot,
      note,
      providerEventId: context.providerEventId,
      eventKind,
    }),
  );
}

/** `customer.subscription.*` — re-read the subscription and apply it. */
async function handleSubscription(context: PeableEventContext): Promise<PeableEventOutcome> {
  const provider = getBillingProvider('peable');
  if (!provider) return NO_RAIL;
  const subscriptionId = context.objectIds.subscription;
  if (!subscriptionId) throw malformed(`${context.type} named no subscription id.`);
  return applySubscription(
    provider,
    context,
    subscriptionId,
    eventKindFor(context.type),
    `applied ${context.type}`,
  );
}

/**
 * `invoice.paid` — the one event that books to the ledger, from the invoice as
 * the gateway reads it now (see the file docblock for the fee gap).
 */
async function handleInvoicePaid(context: PeableEventContext): Promise<PeableEventOutcome> {
  const provider = getBillingProvider('peable');
  if (!provider) return NO_RAIL;
  const invoiceId = context.objectIds.invoice;
  if (!invoiceId) throw malformed('invoice.paid named no invoice id.');

  const invoice = await provider.retrieveInvoice(invoiceId);
  if (invoice.providerInvoiceId !== invoiceId) throw malformed('The gateway read another invoice.');
  if (!invoice.providerSubscriptionId) {
    return { kind: 'ignored', note: 'this invoice is not for a subscription' };
  }
  if (invoice.status !== 'paid') {
    // The event asserted a payment the invoice no longer shows; whatever moved
    // it arrives as its own event.
    return { kind: 'ignored', note: `the invoice is '${invoice.status}', not paid` };
  }

  const subscription = await findSubscriptionByProviderId(getDb(), {
    provider: 'peable',
    livemode: invoice.livemode,
    providerSubscriptionId: invoice.providerSubscriptionId,
  });
  if (!subscription) {
    // Retryable: the subscription may not be recorded yet — deliveries are unordered.
    throw unresolved(`Invoice ${invoiceId} names a subscription Mercaria has not recorded.`);
  }

  const settlement =
    invoice.amountPaidMinor > 0
      ? {
          netMinor: invoice.amountPaidMinor,
          feeMinor: 0,
          currency: currencyOf(invoice.currency, `Invoice ${invoiceId}`),
        }
      : undefined;
  const outcome = await recordSubscriptionInvoicePaid({
    subscriptionId: subscription.id,
    expectedSubscription: subscription,
    providerEventId: context.providerEventId,
    providerInvoiceId: invoiceId,
    ...(settlement ? { settlement } : {}),
    note: settlement
      ? `paid invoice ${invoiceId}; the gateway supplies no processor-fee detail, so no fee expense was booked`
      : 'the invoice settled no money, so nothing was booked',
  });
  return {
    kind: 'applied',
    note: outcome.booked
      ? 'booked to subscription_revenue; no processor-fee detail, so no fee expense was booked'
      : settlement
        ? 'already booked'
        : 'no money moved, so nothing was booked',
  };
}

/**
 * `invoice.payment_failed` — re-read the SUBSCRIPTION and apply it. The failure
 * itself changes nothing: the engine moves the subscription to `past_due` and
 * that is what Mercaria applies, so the grace deadline is stamped from a state
 * the rail reports rather than from an event Mercaria interpreted.
 */
async function handleInvoicePaymentFailed(
  context: PeableEventContext,
): Promise<PeableEventOutcome> {
  const provider = getBillingProvider('peable');
  if (!provider) return NO_RAIL;
  const invoiceId = context.objectIds.invoice;
  if (!invoiceId) throw malformed('invoice.payment_failed named no invoice id.');

  const invoice = await provider.retrieveInvoice(invoiceId);
  if (!invoice.providerSubscriptionId) {
    return { kind: 'ignored', note: 'this invoice is not for a subscription' };
  }
  return applySubscription(
    provider,
    context,
    invoice.providerSubscriptionId,
    'past_due',
    `applied ${context.type} for invoice ${invoiceId}`,
  );
}

/**
 * The handlers this domain contributes to the Peable event router — a record
 * rather than a registration side effect, so the router's lookup stays the ONE
 * place a reader sees every type this deployment acts on.
 */
export const PEABLE_BILLING_EVENT_HANDLERS: Readonly<Record<string, PeableEventHandler>> = {
  'customer.subscription.created': handleSubscription,
  'customer.subscription.updated': handleSubscription,
  'customer.subscription.deleted': handleSubscription,
  'customer.subscription.paused': handleSubscription,
  'customer.subscription.resumed': handleSubscription,
  'invoice.paid': handleInvoicePaid,
  'invoice.payment_failed': handleInvoicePaymentFailed,
};
