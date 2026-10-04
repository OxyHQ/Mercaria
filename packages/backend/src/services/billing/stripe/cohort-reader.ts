import Stripe from 'stripe';
import { config } from '../../../config/index.js';
import { STRIPE_API_VERSION } from '../../payments/stripe/client.js';
import type { BillingCohort } from '../peable/adapter.js';

/** Only the two transitional GETs needed to verify an explicit billing cohort.
 * This object exposes no Stripe mutation, payment, Connect or webhook methods.
 * The general Stripe client keeps its independent STRIPE_ENABLED gate.
 */
export function createBillingCohortStripeReader(cohort: BillingCohort) {
  const key = config.payments.stripe.secretKey;
  if (!/^sk_(?:live|test)_[A-Za-z0-9]+$/.test(key) ||
      key.startsWith('sk_live_') !== cohort.livemode ||
      cohort.livemode !== (cohort.environment === 'production')) {
    throw new Error('Merchant billing reader key or mode differs from the cohort.');
  }
  const stripe = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    timeout: 20_000,
    maxNetworkRetries: 2,
    appInfo: { name: 'Mercaria', url: 'https://mercaria.co' },
  });
  return Object.freeze({
    async platformAccountId(): Promise<string> {
      return (await stripe.accounts.retrieve(null)).id;
    },
    async subscription(ref: string): Promise<Stripe.Subscription> {
      if (!/^sub_[A-Za-z0-9]+$/.test(ref)) {
        throw new Error('Invalid merchant billing subscription reference.');
      }
      return await stripe.subscriptions.retrieve(ref);
    },
  });
}
