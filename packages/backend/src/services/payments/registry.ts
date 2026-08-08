/**
 * Which adapter serves which rail.
 *
 * `external` and `manual_pos` have no adapter and never will: they are payments
 * Mercaria RECORDS rather than makes, so `resolvePaymentProvider` answers
 * `undefined` for them and that is their defining property rather than a
 * failure. The two rails that DO have adapters — the dev-only synthetic one and
 * Stripe — are resolved here, each gated on its own configuration.
 *
 * ## Why the Stripe resolver is gated, and why it returns `undefined`
 *
 * `getStripeClient()` THROWS without a secret key, and most deployments (and
 * every test that does not exercise the rail) have none. A resolver that
 * constructed the adapter anyway would move that throw from "asked for a rail
 * that is off" to "took a checkout and blew up mid-request", which is the same
 * bug the webhook mount's 404 avoids. The adapter itself is cheap and holds no
 * connection — the SDK client it calls is the lazy singleton — so one instance
 * per process is enough and a fresh one per call would be waste, not safety.
 */

import type { PaymentProviderId } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import type { PaymentProvider } from './provider.js';
import { StripePaymentProvider } from './stripe/stripe-provider.js';
import { SyntheticPaymentProvider } from './synthetic-provider.js';

let instance: SyntheticPaymentProvider | undefined;
let stripeInstance: StripePaymentProvider | undefined;

/**
 * The process-wide synthetic rail.
 *
 * One instance, because its payment state is in memory and a second would not
 * recognise the first's objects — a `capture` after a `createPayment` would fail
 * with `resource_missing`, which is exactly the bug a fresh instance per call
 * would produce and exactly the one that only shows up under a real flow.
 */
export function getMockPaymentProvider(): SyntheticPaymentProvider {
  instance ??= new SyntheticPaymentProvider();
  return instance;
}

/** Drop the instance. Test support — a suite must not inherit another's state. */
export function resetMockPaymentProvider(): void {
  instance = undefined;
}

/**
 * The adapter for a rail, if it has one and it is available.
 *
 * The ONE lookup, and it is provider-neutral on purpose: every caller knows a
 * payment's `provider` and needs whatever can act on it, without any of them
 * naming Stripe. `undefined` is an ordinary answer with three ordinary causes —
 * a rail that records rather than makes payments, a card rail this deployment
 * has not configured, and the dev seam in production — and a caller that needs
 * an adapter says so itself rather than being handed a throw.
 *
 * Each rail is gated on its OWN configuration here rather than at its call
 * sites, so "is this rail available" has one answer. `mock` is gated for the
 * same reason as Stripe: a rail production refuses to fund must not be reachable
 * through a lookup either.
 */
export function resolvePaymentProvider(provider: PaymentProviderId): PaymentProvider | undefined {
  if (provider === 'stripe') {
    if (!config.payments.stripe.enabled) return undefined;
    // One instance per process. The adapter is cheap and holds no connection —
    // the SDK client it calls is the lazy singleton — but constructing it when
    // the rail is OFF would move `getStripeClient`'s throw from "asked for a
    // rail that is off" to "took a checkout and blew up mid-request".
    stripeInstance ??= new StripePaymentProvider();
    return stripeInstance;
  }
  if (provider === 'mock') return config.orders.mockPayEnabled ? getMockPaymentProvider() : undefined;
  // `external` and `manual_pos`: payments Mercaria records, never makes.
  return undefined;
}
