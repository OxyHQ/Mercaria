import { Peable } from '@peable.to/sdk';
import { createHash } from 'node:crypto';
import { log } from '../../lib/logger.js';
import { config } from '../../config/index.js';
import { registerBillingProvider } from './provider.js';
import { StripeBillingProvider } from './stripe/stripe-billing.js';
import { billingCohortSchema, CohortBillingProvider } from './peable/adapter.js';
import { createBillingCohortStripeReader } from './stripe/cohort-reader.js';

/** No action flag here: disabling upgrades must not strand existing subscriptions. */
export async function registerMerchantBillingProvider(): Promise<void> {
  const legacy = new StripeBillingProvider();
  const raw = config.merchantBilling.peableCohortJson;
  if (!raw) {
    if (config.payments.stripe.enabled) registerBillingProvider(legacy);
    return;
  }
  // Parse errors never include the raw configuration; do not register a legacy fallback.
  let cohort;
  try { cohort = billingCohortSchema.parse(JSON.parse(raw)); }
  catch { throw new Error('Invalid merchant billing cohort configuration.'); }
  const { publicKey, secret, baseUrl, oxyApiUrl } = config.payments.peable;
  // An explicit cohort must be completely configured before any remote reads.
  if (!publicKey.trim() || !secret.trim()) {
    throw new Error('Merchant billing requires a complete Peable application credential.');
  }
  const reader = createBillingCohortStripeReader(cohort);
  const accountId = await reader.platformAccountId();
  if (accountId !== cohort.platformAccountId || legacy.livemode !== cohort.livemode) {
    throw new Error('Merchant billing platform account or mode differs from the cohort.');
  }
  const client = new Peable({ publicKey, secret, baseURL: baseUrl, oxyApiUrl });
  // Namespace must resolve through existing credentials; never register a merchant here.
  const merchant = await client.merchants.retrieve();
  if (merchant.id !== cohort.merchantId || merchant.oxyAppId !== cohort.applicationId || merchant.environment !== cohort.environment) {
    throw new Error('Merchant billing credential resolves to a different namespace.');
  }
  registerBillingProvider(new CohortBillingProvider(legacy, client, cohort, async (ref) => {
    const subscription = await reader.subscription(ref);
    return { id: subscription.id, customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id, livemode: subscription.livemode };
  }));
  // Positive serving-task evidence only after both remote namespace checks and
  // provider installation. Parsed schema fixes object-key order; no credentials
  // or raw deployment configuration enter logs.
  log.general.info({ cohortSha256: createHash('sha256').update(JSON.stringify(cohort)).digest('hex'),
    mode: cohort.livemode ? 'live' : 'test', environment: cohort.environment, storeCount: cohort.storeIds.length,
  }, 'Merchant billing cohort registered');
}
