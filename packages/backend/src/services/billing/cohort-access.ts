import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { findBillingCustomerByProviderId } from '../../db/merchantPlans/subscriptionRepository.js';
import { getBillingProvider } from './provider.js';
import { PaymentProviderError } from '../payments/provider.js';
import { parseBillingCohort } from './cohort-config.js';

/** An existing SQL customer binding, never event metadata, selects cohort ownership. */
export async function billingCohortBindingForCustomer(customerId: string | undefined) {
  const cohort = parseBillingCohort(config.merchantBilling.peableCohortJson);
  if (!cohort || !customerId || !/^cus_[A-Za-z0-9]+$/.test(customerId)) return undefined;
  const customer = await findBillingCustomerByProviderId(getDb(), {
    provider: 'stripe', livemode: cohort.livemode, providerCustomerId: customerId,
  });
  return customer && cohort.storeIds.includes(customer.storeId) ? { cohort, storeId: customer.storeId } : undefined;
}

export async function billingCohortForCustomer(customerId: string | undefined) {
  return (await billingCohortBindingForCustomer(customerId))?.cohort;
}

/** Registration completed only after live account and gateway namespace checks.
 * During bootstrap/provider failure, retry genuine deliveries instead of dropping them. */
export function requireRegisteredBillingCohort(binding: NonNullable<Awaited<ReturnType<typeof billingCohortBindingForCustomer>>>) {
  const provider = getBillingProvider('stripe');
  if (!provider || provider.livemode !== binding.cohort.livemode || !provider.requiresExplicitIntent?.(binding.storeId)) {
    throw new PaymentProviderError({ provider: 'stripe', stage: 'verifyEvent', retryable: true,
      message: 'The billing cohort is not registered on this deployment.' });
  }
}
