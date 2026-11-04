import { config } from '../../config/index.js';
import { getBillingProvider } from './provider.js';

/**
 * Whether a merchant may open a checkout, the portal or a cancellation here:
 * `MERCHANT_BILLING_ENABLED` and a registered rail. The projection and the three
 * action entry points read this ONE answer, so a button is never shown for an
 * action the server would refuse. It gates actions only — entitlements,
 * existing subscriptions and provider events never read it.
 */
export function merchantBillingAvailable(): boolean {
  return config.merchantBilling.enabled && getBillingProvider('peable') !== undefined;
}
