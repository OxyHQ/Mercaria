/**
 * The four subscription and invoice events Mercaria applies (#89 billing rule 4).
 *
 * ## They ride the EXISTING payment-event infrastructure, deliberately
 *
 * Issue #89 billing rule 3: "Persist provider events idempotently through the
 * payment-event infrastructure where compatible." These are platform-scope
 * Stripe events on Mercaria's own account, verified by the same signature check,
 * stored in the same `payment_provider_events` table under the same dedupe key,
 * claimed by the same lease, retried on the same backoff and replayable from the
 * same operator surface. Building a second ingress would mean a second signature
 * check, a second dedupe key and a second replay path — three more places for a
 * subscription event to be lost.
 *
 * What they do NOT share is `payments`. A subscription invoice is not a
 * marketplace charge: it has no checkout group, no orders, no seller and no
 * transfer, so `payment_provider_events.payment_id` stays NULL for every one of
 * them and the correlation lives on `merchant_subscription_events` instead.
 *
 * ## No handler applies a PAYLOAD
 *
 * #46's rule, and the reasoning generalizes: deliveries are unordered, so the
 * snapshot in an event that arrived second may be older than the one that
 * arrived first. Every handler here re-reads from Stripe and applies THAT, so
 * the last write is the current truth rather than the last delivery.
 */

import type Stripe from 'stripe';
import { ALL_CURRENCY_CODES, type CurrencyCode } from '@mercaria/shared-types';
import { getStripeClient } from '../../payments/stripe/client.js';
import { PaymentProviderError } from '../../payments/provider.js';
import type {
  StripeEventContext,
  StripeEventHandler,
  StripeEventOutcome,
} from '../../payments/stripe/stripe-event-router.js';
import { findSubscriptionByProviderId } from '../../../db/merchantPlans/subscriptionRepository.js';
import { getDb } from '../../../db/postgres.js';
import { config } from '../../../config/index.js';
import {
  applyProviderSubscriptionState,
  recordSubscriptionInvoicePaid,
  type ProviderSubscriptionEventKind,
} from '../subscription.service.js';
import { getBillingProvider } from '../provider.js';

/**
 * The four types #89 subscribes to on the PLATFORM endpoint, transcribed once.
 *
 * A separate tuple from `STRIPE_PLATFORM_EVENT_TYPES`, which is ADR 0001's own
 * list reproduced verbatim and is worth keeping auditable against the ADR. These
 * are #89's, added under #89's decision, and `platformScopeEventTypes()` is the
 * union both the scope check and the dashboard configuration read.
 */
export const STRIPE_BILLING_EVENT_TYPES: readonly string[] = [
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

/** An event naming an object this handler cannot work from — never retryable. */
function malformed(message: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'stripe',
    stage: 'verifyEvent',
    message,
    retryable: false,
  });
}

/**
 * A correlation this version cannot make YET — retryable on purpose.
 *
 * Stripe can deliver `customer.subscription.updated` before the transaction that
 * recorded the billing customer is visible to this task, and discarding it then
 * would throw away the relationship rather than wait a second for it (#48's
 * ordering rule, one domain over).
 */
function unresolved(message: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'stripe',
    stage: 'verifyEvent',
    message,
    retryable: true,
  });
}

/**
 * A Stripe currency as a `CurrencyCode`, or a refusal naming it.
 *
 * NEVER coerced. A settlement in a currency Mercaria does not model would post a
 * ledger entry whose `currency` CHECK refuses it anyway; refusing here names the
 * code instead of surfacing as a constraint violation three frames away.
 */
function currencyOf(code: string, context: string): CurrencyCode {
  const upper = code.toUpperCase();
  const match = ALL_CURRENCY_CODES.find((candidate) => candidate === upper);
  if (!match) {
    throw malformed(`${context} settled in ${upper}, which Mercaria does not model.`);
  }
  return match;
}

/** Which audit kind a Stripe subscription event should append. */
function eventKindFor(type: string): ProviderSubscriptionEventKind {
  return type === 'customer.subscription.deleted' ? 'expired' : 'reconciled';
}

/** A Stripe reference that may be an id or an expanded object. */
function referenceId(value: string | { id: string } | null | undefined): string | undefined {
  if (!value) return undefined;
  return typeof value === 'string' ? value : value.id;
}

/**
 * The subscription an invoice belongs to, or `undefined`.
 *
 * Read from the invoice's PARENT rather than a top-level `subscription` field:
 * the pinned API version models an invoice's origin as a `parent` discriminated
 * on `type`, and reading a property the response does not carry would silently
 * make every subscription invoice look like a one-off charge.
 */
function subscriptionIdOf(invoice: Stripe.Invoice): string | undefined {
  return referenceId(invoice.parent?.subscription_details?.subscription);
}

/**
 * The charge an invoice settled through, or `undefined` when it settled none.
 *
 * The pinned API version puts an invoice's settlement under `payments`, each
 * entry naming either a charge directly or the PaymentIntent that produced one —
 * so this walks the expanded list rather than reading a `charge` field that no
 * longer exists. `undefined` is an ordinary answer: a fully-discounted period
 * and one paid from a credit balance both move no money.
 */
function chargeIdOf(invoice: Stripe.Invoice): string | undefined {
  for (const entry of invoice.payments?.data ?? []) {
    const payment = entry.payment;
    const direct = referenceId(payment.charge);
    if (direct) return direct;
    const intent = payment.payment_intent;
    if (intent && typeof intent !== 'string') {
      const latest = referenceId(intent.latest_charge);
      if (latest) return latest;
    }
  }
  return undefined;
}

/**
 * `customer.subscription.updated` and `.deleted`.
 *
 * Both re-read and apply, because both mean the same thing to Mercaria: the
 * rail's current opinion of a subscription. A deletion goes through the same
 * path so `expired`, `ended_at` and the audit row are written by ONE piece of
 * code rather than two that could disagree about what "ended" means.
 */
async function handleSubscription(context: StripeEventContext): Promise<StripeEventOutcome> {
  const provider = getBillingProvider('stripe');
  if (!provider) {
    return {
      kind: 'ignored',
      note: 'no billing rail is registered on this deployment, so nothing consumes this event',
    };
  }
  const subscriptionId = context.objectIds['subscription'];
  if (!subscriptionId) throw malformed(`${context.type} named no subscription id.`);

  const snapshot = await provider.retrieveSubscription(subscriptionId);
  const outcome = await applyProviderSubscriptionState({
    snapshot,
    note: `applied ${context.type}`,
    providerEventId: context.providerEventId,
    eventKind: eventKindFor(context.type),
  });

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

/**
 * `invoice.paid` — the one event that books to the ledger.
 *
 * The amount comes from the CHARGE's balance transaction, not from the invoice:
 * #47's rule that a charge is booked in the currency the money LANDED in applies
 * unchanged, and an invoice's own total is what was billed rather than what
 * arrived. An unavailable balance transaction is RETRYABLE and never guessed.
 */
async function handleInvoicePaid(context: StripeEventContext): Promise<StripeEventOutcome> {
  const invoiceId = context.objectIds['invoice'];
  if (!invoiceId) throw malformed('invoice.paid named no invoice id.');

  const invoice = await getStripeClient().invoices.retrieve(invoiceId, {
    expand: ['payments.data.payment.payment_intent'],
  });
  const subscriptionId = subscriptionIdOf(invoice);
  if (!subscriptionId) {
    return { kind: 'ignored', note: 'this invoice is not for a subscription' };
  }

  const subscription = await findSubscriptionByProviderId(getDb(), {
    provider: 'stripe',
    livemode: config.payments.stripe.livemode,
    providerSubscriptionId: subscriptionId,
  });
  if (!subscription) {
    // Retryable: the subscription may not have been recorded yet, and Stripe
    // does not order its deliveries.
    throw unresolved(`Invoice ${invoiceId} names a subscription Mercaria has not recorded.`);
  }

  const chargeId = chargeIdOf(invoice);
  if (!chargeId) {
    const outcome = await recordSubscriptionInvoicePaid({
      subscriptionId: subscription.id,
      providerEventId: context.providerEventId,
      providerInvoiceId: invoiceId,
      note: 'the invoice settled no money, so nothing was booked',
    });
    return {
      kind: 'applied',
      note: outcome.booked ? 'booked' : 'no money moved, so nothing was booked',
    };
  }

  const charge = await getStripeClient().charges.retrieve(chargeId, {
    expand: ['balance_transaction'],
  });
  const balance = charge.balance_transaction;
  if (!balance || typeof balance === 'string') {
    throw unresolved(
      `Charge ${chargeId} has no available balance transaction yet, so what landed on the ` +
        'platform balance is not known. Never guessed.',
    );
  }

  const outcome = await recordSubscriptionInvoicePaid({
    subscriptionId: subscription.id,
    providerEventId: context.providerEventId,
    providerInvoiceId: invoiceId,
    settlement: {
      netMinor: balance.net,
      feeMinor: balance.fee,
      currency: currencyOf(balance.currency, `Invoice ${invoiceId}`),
    },
    note: `settled invoice ${invoiceId}`,
  });
  return {
    kind: 'applied',
    note: outcome.booked ? 'booked to subscription_revenue' : 'already booked',
  };
}

/**
 * `invoice.payment_failed` — re-read the subscription and apply.
 *
 * The FAILURE itself is not what changes anything: Stripe moves the subscription
 * to `past_due` (or `unpaid`) and that is what Mercaria applies, so the grace
 * deadline is stamped from a state the rail actually reports rather than from an
 * event Mercaria interpreted.
 */
async function handleInvoicePaymentFailed(
  context: StripeEventContext,
): Promise<StripeEventOutcome> {
  const provider = getBillingProvider('stripe');
  if (!provider) {
    return {
      kind: 'ignored',
      note: 'no billing rail is registered on this deployment, so nothing consumes this event',
    };
  }
  const invoiceId = context.objectIds['invoice'];
  if (!invoiceId) throw malformed('invoice.payment_failed named no invoice id.');

  const invoice = await getStripeClient().invoices.retrieve(invoiceId);
  const subscriptionId = subscriptionIdOf(invoice);
  if (!subscriptionId) {
    return { kind: 'ignored', note: 'this invoice is not for a subscription' };
  }

  const snapshot = await provider.retrieveSubscription(subscriptionId);
  const outcome = await applyProviderSubscriptionState({
    snapshot,
    note: `applied ${context.type} for invoice ${invoiceId}`,
    providerEventId: context.providerEventId,
    eventKind: 'past_due',
  });
  if (outcome.outcome === 'applied') {
    return { kind: 'applied', note: `subscription ${outcome.subscription.status}` };
  }
  if (outcome.outcome === 'already_applied') {
    return { kind: 'applied', note: 'this event had already been applied' };
  }
  if (outcome.outcome === 'unknown_customer') {
    throw unresolved(`No Mercaria store is bound to the customer of ${subscriptionId}.`);
  }
  return { kind: 'ignored', note: `nothing to apply (${outcome.outcome})` };
}

/**
 * The handlers this domain contributes to the shared Stripe event router.
 *
 * Exported as a record rather than registered by a side effect, so the router's
 * own `HANDLERS` table stays the ONE place a reader can see every type this
 * deployment routes.
 */
export const STRIPE_BILLING_EVENT_HANDLERS: Readonly<Record<string, StripeEventHandler>> = {
  'customer.subscription.updated': handleSubscription,
  'customer.subscription.deleted': handleSubscription,
  'invoice.paid': handleInvoicePaid,
  'invoice.payment_failed': handleInvoicePaymentFailed,
};
