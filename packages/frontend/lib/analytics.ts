/**
 * The storefront analytics client (#111).
 *
 * ## Why this exists at all, and why it is #111's rather than #107's or #109's
 *
 * Six event types were deferred across two issues because they are facts only a
 * browser or a payment sheet knows: which methods a sheet OFFERED, which one
 * was pressed, whether the issuer demanded a step-up, whether the confirmation
 * failed on the client, whether a claim screen was RENDERED, and whether it was
 * explicitly dismissed. #107 and #109 declined to fabricate server-side
 * substitutes for them and said so; what they were waiting for is a client, and
 * building one is rollout instrumentation rather than payment or claim work.
 *
 * ## It cannot block anything, and the SIGNATURE is the guarantee
 *
 * `track()` returns `void`, not a promise — the backend sink's device, applied
 * one layer out. A caller has nothing to await, so an analytics call can never
 * join the path between a buyer pressing "Pay" and the payment sheet opening,
 * and a caller who tried would get a `tsc` error. The POST is fire-and-forget
 * with its rejection swallowed: an analytics beacon that failed is worth
 * nothing at all to the person whose payment is in flight.
 *
 * ## It sends BOUNDED values and nothing else
 *
 * There is no `properties` parameter and no way to add one: the input type
 * names an event, an optional bounded payment-method CATEGORY, an optional
 * bounded reason code, and nothing more. A card brand, a last four, a Stripe
 * Customer, a wallet identity and an email have no field here — and would be
 * refused by the server's allow-list even if one were invented, because
 * `analytics_events` has no column for any of them.
 *
 * The endpoint answers 202 and the events may be dropped. That is the contract
 * (#77), and it is why nothing here retries: an analytics write that failed
 * once will usually fail again, and a retry turns a transient outage into a
 * growing buffer on somebody's phone.
 */

import type { GuestPaymentMethodCategory } from '@mercaria/shared-types';
import apiClient from './api/client';

/**
 * The event types a storefront may assert.
 *
 * A local literal union rather than an import of
 * `ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES`, and deliberately NARROWER than it:
 * that tuple is what the SERVER accepts, which includes the discovery events
 * other surfaces emit. This is what THIS module sends, and keeping it narrow
 * means a typo names a type that does not compile rather than one the server
 * silently counts as rejected.
 */
export type StorefrontAnalyticsEvent =
  | 'guest_payment_methods_shown'
  | 'guest_payment_method_selected'
  | 'guest_payment_action_required'
  | 'guest_payment_client_failed'
  | 'guest_claim_offered'
  | 'guest_claim_declined';

/** What a call site may say. There is deliberately no open property bag. */
export interface StorefrontAnalyticsInput {
  /** The bounded method category, on the four payment events only. */
  readonly paymentMethodCategory?: GuestPaymentMethodCategory;
  /**
   * How many methods a sheet offered, on `guest_payment_methods_shown`.
   *
   * `itemCount` is one of the five typed MEASURES the envelope admits. A sixth
   * measure is a schema change with a migration, which is the friction that
   * keeps this from becoming a property bag by accretion.
   */
  readonly itemCount?: number;
}

/**
 * Emit one event. Returns immediately, whatever happens.
 *
 * Every dimension that identifies anything — the actor, the pseudonymous
 * session, the traffic class, the market, the surface — is derived by the
 * SERVER from the request. This function cannot set one and does not try, which
 * is what makes "a client cannot forge an identity" a property of the payload
 * rather than of a check on the far side.
 */
export function track(event: StorefrontAnalyticsEvent, input: StorefrontAnalyticsInput = {}): void {
  void apiClient
    .post('/analytics/events', {
      events: [
        {
          eventType: event,
          ...(input.paymentMethodCategory === undefined
            ? {}
            : { paymentMethodCategory: input.paymentMethodCategory }),
          ...(input.itemCount === undefined ? {} : { measures: { itemCount: input.itemCount } }),
        },
      ],
    })
    .catch(() => {
      // Deliberately silent. The endpoint answers 202 precisely because these
      // events may be dropped, and a console line on every offline beacon
      // would train everybody to ignore the console.
    });
}

/**
 * Map a Stripe payment-method type to Mercaria's BOUNDED category.
 *
 * The provider's own string is never sent: its vocabulary changes with their
 * API, and an unbounded value in an analytics column is how a wallet identity
 * or an issuer name eventually arrives in one. An unrecognised type becomes
 * `other` rather than being dropped — dropping it would make the denominators
 * disagree with `guest_payment_methods_shown`, which counts what the sheet
 * offered.
 */
export function paymentMethodCategoryFor(stripeType: string): GuestPaymentMethodCategory {
  switch (stripeType) {
    case 'card':
      return 'card';
    case 'apple_pay':
      return 'wallet_apple_pay';
    case 'google_pay':
      return 'wallet_google_pay';
    case 'ideal':
    case 'bancontact':
    case 'eps':
    case 'p24':
    case 'blik':
      return 'bank_redirect';
    case 'sepa_debit':
    case 'customer_balance':
      return 'bank_transfer';
    case 'klarna':
    case 'afterpay_clearpay':
      return 'buy_now_pay_later';
    default:
      return 'other';
  }
}
