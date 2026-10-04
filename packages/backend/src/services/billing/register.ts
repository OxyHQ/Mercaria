import { Peable } from '@peable.to/sdk';
import { config } from '../../config/index.js';
import { getStripeClient } from '../payments/stripe/client.js';
import { registerBillingProvider } from './provider.js';
import { StripeBillingProvider } from './stripe/stripe-billing.js';
import { billingCohortSchema, CohortBillingProvider } from './peable/adapter.js';

/** No action flag here: disabling upgrades must not strand existing subscriptions. */
export async function registerMerchantBillingProvider(): Promise<void> {
  if (!config.payments.stripe.enabled) return;
  const legacy = new StripeBillingProvider();
  const raw = config.merchantBilling.peableCohortJson;
  if (!raw) { registerBillingProvider(legacy); return; }
  // Parse errors never include the raw configuration; do not register a legacy fallback.
  let cohort;
  try { cohort = billingCohortSchema.parse(JSON.parse(raw)); }
  catch { throw new Error('Invalid merchant billing cohort configuration.'); }
  const stripe = getStripeClient();
  const account = await stripe.accounts.retrieve(null);
  if (account.id !== cohort.platformAccountId || legacy.livemode !== cohort.livemode) {
    throw new Error('Merchant billing platform account or mode differs from the cohort.');
  }
  const { publicKey, secret, baseUrl, oxyApiUrl } = config.payments.peable;
  const client = new Peable({ publicKey, secret, baseURL: baseUrl, oxyApiUrl });
  // Namespace must resolve through existing credentials; never register a merchant here.
  const merchant = await client.merchants.retrieve();
  if (merchant.id !== cohort.merchantId || merchant.oxyAppId !== cohort.applicationId || merchant.environment !== cohort.environment) {
    throw new Error('Merchant billing credential resolves to a different namespace.');
  }
  registerBillingProvider(new CohortBillingProvider(legacy, client, cohort, async (ref) => {
    const subscription = await stripe.subscriptions.retrieve(ref);
    return { id: subscription.id, customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id, livemode: subscription.livemode };
  }));
}
