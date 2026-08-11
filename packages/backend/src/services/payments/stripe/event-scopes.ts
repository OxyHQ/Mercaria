/**
 * The two webhook endpoints and what each is subscribed to.
 *
 * ADR 0001 "Stripe configuration" names both lists, and they are reproduced here
 * VERBATIM rather than summarised. Two endpoints and not one because Stripe's
 * Connect-scope endpoint (`connect=true`) is the only way to receive events
 * about connected accounts, and its deliveries are signed with a DIFFERENT
 * secret — so the split is a property of Stripe's API, not an organisational
 * preference.
 *
 * ## Why the lists are also a runtime check
 *
 * They are what makes "wrong scope" a thing this ingress can detect. Each
 * endpoint has its own secret, so an event of the other endpoint's type arriving
 * with a VALID signature means the Stripe dashboard is misconfigured — one
 * endpoint subscribed to the other's events — and the delivery must be refused
 * loudly rather than stored under the wrong scope's assumptions. A connect-scope
 * event carries a connected account and a platform-scope one does not; storing
 * one as the other silently corrupts the `(provider, account, event)` dedupe key
 * that the whole idempotency story rests on.
 *
 * ## A type in NEITHER list is ACCEPTED, not refused
 *
 * That asymmetry is deliberate and follows #45's own rule for an event it cannot
 * act on: "evidence of something Mercaria could not interpret is worth more than
 * a dropped request". An unrecognised type is stored, marked processed with a
 * note saying no handler exists, and acknowledged — so an endpoint someone
 * subscribed to `*` shows up as visible noise in the trace instead of an
 * endpoint Stripe keeps retrying into a 400 and eventually disables.
 */

import { STRIPE_BILLING_EVENT_TYPES } from '../../billing/stripe/subscription-events.js';

/** Which of the two endpoints a delivery arrived at. */
export type StripeWebhookScope = 'platform' | 'connect';

/**
 * Platform-scope subscriptions (`connect=false`) — ADR 0001.
 *
 * Everything about Mercaria's OWN Stripe account: the charges it takes as
 * merchant of record (D1), the transfers it makes to sellers (D3), and the
 * refunds and disputes that act on them (D7).
 */
export const STRIPE_PLATFORM_EVENT_TYPES: readonly string[] = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.canceled',
  'charge.succeeded',
  'charge.updated',
  'charge.refunded',
  'charge.refund.updated',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'transfer.created',
  'transfer.updated',
  'transfer.reversed',
];

/**
 * Connect-scope subscriptions (`connect=true`) — ADR 0001.
 *
 * Everything about a SELLER's connected account: whether it is payment-ready
 * (D9, consumed by #46) and whether its payouts are landing (D7, #49).
 */
export const STRIPE_CONNECT_EVENT_TYPES: readonly string[] = [
  'account.updated',
  'account.application.deauthorized',
  'account.external_account.updated',
  'payout.paid',
  'payout.failed',
];

/**
 * Everything the PLATFORM endpoint is subscribed to on this deployment.
 *
 * ADR 0001's list plus #89's merchant-billing types, and the union rather than a
 * widened `STRIPE_PLATFORM_EVENT_TYPES` on purpose: the ADR's list is
 * transcribed by hand in a test and its value is that it can be checked against
 * the ADR, which a list somebody has since appended to cannot be. #89's four are
 * a later decision recorded in their own tuple, in the domain that consumes
 * them.
 *
 * This is also what gets typed into the Stripe dashboard when the platform
 * endpoint is registered.
 */
export function platformScopeEventTypes(): readonly string[] {
  return [...STRIPE_PLATFORM_EVENT_TYPES, ...STRIPE_BILLING_EVENT_TYPES];
}

/**
 * Whether this event type belongs to the OTHER endpoint.
 *
 * The only condition that refuses an authentically-signed delivery. A type in
 * this endpoint's own list is handled; a type in neither is stored as evidence;
 * a type in the other endpoint's list is a dashboard misconfiguration.
 */
export function isWrongScope(scope: StripeWebhookScope, eventType: string): boolean {
  return scope === 'platform'
    ? STRIPE_CONNECT_EVENT_TYPES.includes(eventType)
    : platformScopeEventTypes().includes(eventType);
}
