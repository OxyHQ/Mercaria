/**
 * A store that satisfies everything, plus a deep override.
 *
 * The base is deliberately the BEST case, so a requirement that refuses in a
 * test refuses because of the one fact that case changed. A fixture that started
 * half-broken would let a derivation bug hide behind a fixture gap — the census
 * in `requirements.test.ts` asserts the base blocks NOTHING, which is the
 * positive control that makes the rest of the file mean something.
 *
 * NOT a `*.test.ts` file: importing a test file registers its suites in the
 * importer, which reports somebody else's cases as your own.
 */

import type { ChannelReadiness } from '@mercaria/shared-types';
import type { MerchantActivationFacts } from '../facts.js';

/** A channel readiness result with nothing wrong with it. */
const READY_CHANNELS: ChannelReadiness = {
  storeId: 'store-1',
  catalog: {
    state: 'healthy',
    connectedChannelTypes: ['native'],
    nativeCheckoutCapableCount: 1,
    lastSuccessfulSyncAt: '2026-08-14T00:00:00.000Z',
  },
  payments: { state: 'healthy', railEnabled: true },
  nativeCheckout: { state: 'healthy', blockers: [] },
};

/** A recursive override that reaches the three nested objects by name. */
export interface ActivationFactsOverride {
  store?: Partial<MerchantActivationFacts['store']>;
  settings?: Partial<MerchantActivationFacts['settings']>;
  fulfilment?: Partial<MerchantActivationFacts['fulfilment']>;
  guest?: Partial<MerchantActivationFacts['guest']>;
  channelReadiness?: ChannelReadiness;
  merchant?: MerchantActivationFacts['merchant'];
  railEnabled?: boolean;
  paymentsReady?: boolean;
  presentmentCurrencies?: MerchantActivationFacts['presentmentCurrencies'];
  paymentMethods?: readonly string[];
  markets?: readonly string[];
  fulfilmentMethods?: readonly string[];
  applicableFeeSchedule?: MerchantActivationFacts['applicableFeeSchedule'];
  feeScheduleAccepted?: boolean;
  feeScheduleAcceptedVersionCurrent?: boolean;
  acceptedPolicies?: MerchantActivationFacts['acceptedPolicies'];
  completedOrderCount?: number;
  refundPermissionAssigned?: boolean;
  buyerDataPermissionAssigned?: boolean;
  nativeSatisfied?: boolean;
}

/** Build the facts. */
export function activationFacts(override: ActivationFactsOverride = {}): MerchantActivationFacts {
  const acceptedAt = new Date('2026-08-14T00:00:00.000Z');
  return {
    store: {
      id: 'store-1',
      name: 'Tienda Uno',
      description: 'Everything for the kitchen.',
      status: 'active',
      defaultCurrency: 'EUR',
      policiesRefundPolicy: 'Thirty days, no questions.',
      policiesPrivacyPolicy: 'We keep what we must and nothing else.',
      ...override.store,
    },
    settings: {
      exists: true,
      nativeCheckoutIntent: 'enabled',
      guestCheckoutIntent: 'enabled',
      supportEmail: 'help@tienda.example',
      supportUrl: null,
      platformHeld: false,
      ...override.settings,
    },
    merchant: override.merchant === undefined ? { id: 'm1', claimState: 'verified' } : override.merchant,
    channelReadiness: override.channelReadiness ?? READY_CHANNELS,
    railEnabled: override.railEnabled ?? true,
    paymentsReady: override.paymentsReady ?? true,
    presentmentCurrencies: override.presentmentCurrencies ?? ['EUR', 'USD'],
    paymentMethods: override.paymentMethods ?? ['card'],
    markets: override.markets ?? ['ES', 'FR'],
    fulfilmentMethods: override.fulfilmentMethods ?? ['standard', 'express'],
    applicableFeeSchedule:
      override.applicableFeeSchedule === undefined ? null : override.applicableFeeSchedule,
    feeScheduleAccepted: override.feeScheduleAccepted ?? true,
    feeScheduleAcceptedVersionCurrent: override.feeScheduleAcceptedVersionCurrent ?? true,
    acceptedPolicies: override.acceptedPolicies ?? {
      returns_and_fulfilment_responsibilities: {
        policyVersion: '2026-08-14',
        acceptedByOxyUserId: 'owner-1',
        acceptedAt,
        current: true,
      },
      guest_data_and_contact_handling: {
        policyVersion: '2026-08-14',
        acceptedByOxyUserId: 'owner-1',
        acceptedAt,
        current: true,
      },
    },
    completedOrderCount: override.completedOrderCount ?? 3,
    refundPermissionAssigned: override.refundPermissionAssigned ?? true,
    buyerDataPermissionAssigned: override.buyerDataPermissionAssigned ?? true,
    // The BEST case, like every other field here: collection is on, and this
    // store has somewhere to collect from. A base that left pickup off would
    // make `pickup_checkout` withheld in the census below, which is the
    // permissive direction for a test — the inversion would be invisible.
    fulfilment: {
      shippingMethods: ['standard', 'express'],
      storePickupEnabled: true,
      guestPickupEnabled: true,
      collectableLocationCount: 1,
      ...override.fulfilment,
    },
    guest: {
      commerceEnabled: true,
      cartEnabled: true,
      inlineDestinationEnabled: true,
      presentmentCurrencies: ['EUR', 'USD'],
      paymentMethods: ['card'],
      markets: ['ES', 'FR'],
      blockedMarkets: [],
      // Coherent with the `fulfilment` block above, which is what the real
      // composer would produce: collection is on and this store has a desk, so
      // the guest set carries it too.
      fulfilmentMethods: ['standard', 'express', 'pickup'],
      sellerBlockedByOperator: false,
      transactionalTransportConfigured: true,
      buyerRequestsEnabled: true,
      ...override.guest,
    },
    nativeSatisfied: override.nativeSatisfied ?? true,
  };
}
