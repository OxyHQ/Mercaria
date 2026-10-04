import Stripe from 'stripe';
import { config } from '../../../config/index.js';
import { STRIPE_API_VERSION } from '../../payments/stripe/client.js';
import type { BillingCohort } from '../peable/adapter.js';

/** Only the transitional account/subscription/invoice/settlement GETs needed to verify an explicit billing cohort.
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
  async function verifyAccount() {
    if ((await stripe.accounts.retrieve(null)).id !== cohort.platformAccountId) {
      throw new Error('Merchant billing reader platform account differs from the cohort.');
    }
  }
  return Object.freeze({
    async platformAccountId(): Promise<string> {
      return (await stripe.accounts.retrieve(null)).id;
    },
    async invoice(ref: string, customerId: string): Promise<Stripe.Invoice> {
      if (!/^in_[A-Za-z0-9]+$/.test(ref)) throw new Error('Invalid merchant billing invoice reference.');
      await verifyAccount();
      const invoice = await stripe.invoices.retrieve(ref, { expand: ['payments.data.payment.payment_intent'] });
      const customer = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (invoice.id !== ref || invoice.livemode !== cohort.livemode || customer !== customerId) {
        throw new Error('Merchant billing invoice differs from the cohort customer or mode.');
      }
      return invoice;
    },
    async charge(ref: string, customerId: string): Promise<Stripe.Charge> {
      if (!/^ch_[A-Za-z0-9]+$/.test(ref)) throw new Error('Invalid merchant billing charge reference.');
      await verifyAccount();
      const charge = await stripe.charges.retrieve(ref, { expand: ['balance_transaction'] });
      const customer = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
      if (charge.id !== ref || charge.livemode !== cohort.livemode || customer !== customerId) {
        throw new Error('Merchant billing charge differs from the cohort customer or mode.');
      }
      return charge;
    },
    async subscription(ref: string): Promise<Stripe.Subscription> {
      if (!/^sub_[A-Za-z0-9]+$/.test(ref)) {
        throw new Error('Invalid merchant billing subscription reference.');
      }
      return await stripe.subscriptions.retrieve(ref);
    },
  });
}
