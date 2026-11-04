import { config } from '../../config/index.js';
import { createPeableClient } from '../payments/peable/client.js';
import { PeableBillingProvider } from './peable/native-billing.js';
import { registerBillingProvider } from './provider.js';

/**
 * Register merchant billing's one rail: Peable's native engine.
 *
 * Gated on the Peable webhook secret — a deployment that cannot hear the
 * gateway's subscription and invoice events must not open a subscription it
 * would never learn the outcome of — and deliberately NOT on
 * `MERCHANT_BILLING_ENABLED`: that flag gates a merchant's actions, while the
 * adapter is what applies events and reconciles subscriptions that already
 * exist. No call is made here; the adapter is cheap and the SDK client lazy.
 */
export function registerMerchantBillingProvider(): void {
  if (!config.payments.peable.webhooksEnabled) return;
  registerBillingProvider(
    new PeableBillingProvider(createPeableClient(), config.payments.peable.livemode),
  );
}
