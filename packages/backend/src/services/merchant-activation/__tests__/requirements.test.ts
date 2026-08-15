/**
 * The activation derivation (#85) over a plain facts object.
 *
 * The whole point of `facts.ts` being the only reader is that this file needs no
 * database: every requirement is a row in a table here, and a case that used a
 * fixture store would be measuring eleven other domains.
 *
 * The FIRST case is the census, and it is the one that keeps the rest honest: a
 * requirement published and never evaluated reads exactly like one that always
 * passes (#112's device), so the registry is walked rather than a list of
 * members somebody remembered to add.
 */

import { describe, expect, it } from 'vitest';
import {
  GUEST_ACTIVATION_REQUIREMENTS,
  MERCHANT_ACTIVATION_REQUIREMENTS,
  MERCHANT_ACTIVATION_REQUIREMENT_KEYS,
  type MerchantActivationRequirementKey,
} from '@mercaria/shared-types';
import {
  blockingRequirements,
  deriveGuestRequirements,
  deriveNativeRequirements,
  hasUnevaluable,
} from '../requirements.js';
import { activationFacts } from './facts-fixture.js';

/** Every requirement's outcome, in one map. */
function outcomes(facts = activationFacts()) {
  const results = [...deriveNativeRequirements(facts), ...deriveGuestRequirements(facts)];
  return new Map(results.map((result) => [result.requirement, result.outcome]));
}

describe('the census', () => {
  it('answers every published requirement, in both registries', () => {
    const answered = outcomes();
    // The vacuity floor: thirty is not a number worth asserting, but ZERO
    // requirements answered is what a broken fixture produces and it must not
    // read as a pass.
    expect(answered.size).toBeGreaterThan(20);
    for (const requirement of MERCHANT_ACTIVATION_REQUIREMENT_KEYS) {
      expect(answered.has(requirement), `${requirement} is published and never evaluated`).toBe(
        true,
      );
    }
    expect(answered.size).toBe(MERCHANT_ACTIVATION_REQUIREMENT_KEYS.length);
  });

  it('keeps the two registries DISJOINT', () => {
    // #85 says twice that guest readiness may not be inferred from native. The
    // registries being disjoint is what makes `MerchantActivationRequirementKey`
    // a real discriminated key — a shared member would be one requirement
    // deciding two conjunctions with one answer.
    const native = new Set<string>(MERCHANT_ACTIVATION_REQUIREMENTS);
    for (const requirement of GUEST_ACTIVATION_REQUIREMENTS) {
      expect(native.has(requirement), `${requirement} is in both registries`).toBe(false);
    }
    expect(MERCHANT_ACTIVATION_REQUIREMENT_KEYS.length).toBe(
      MERCHANT_ACTIVATION_REQUIREMENTS.length + GUEST_ACTIVATION_REQUIREMENTS.length,
    );
  });
});

describe('the ready store', () => {
  it('satisfies every native requirement', () => {
    const facts = activationFacts();
    const blocking = blockingRequirements(deriveNativeRequirements(facts), []);
    // The positive control. Without it every case below would pass against a
    // derivation that refused unconditionally.
    expect(blocking).toEqual([]);
  });

  it('satisfies every guest requirement', () => {
    const facts = activationFacts({ nativeSatisfied: true });
    expect(blockingRequirements(deriveGuestRequirements(facts), [])).toEqual([]);
  });
});

describe('each requirement refuses on its own fact', () => {
  const cases: {
    requirement: MerchantActivationRequirementKey;
    facts: Parameters<typeof activationFacts>[0];
    reason: string;
  }[] = [
    {
      requirement: 'merchant_claim_verified',
      facts: { merchant: { id: 'm1', claimState: 'unclaimed' } },
      reason: 'merchant_not_claimed',
    },
    {
      requirement: 'merchant_claim_verified',
      facts: { merchant: { id: 'm1', claimState: 'disputed' } },
      reason: 'merchant_claim_not_verified',
    },
    { requirement: 'native_store_link_valid', facts: { merchant: null }, reason: 'no_linked_merchant' },
    {
      requirement: 'support_contact_complete',
      facts: { settings: { supportEmail: null, supportUrl: null } },
      reason: 'support_contact_missing',
    },
    {
      requirement: 'store_policies_configured',
      facts: { store: { policiesRefundPolicy: '  ' } },
      reason: 'store_policies_incomplete',
    },
    { requirement: 'payment_provider_ready', facts: { railEnabled: false }, reason: 'payment_rail_disabled' },
    { requirement: 'payment_provider_ready', facts: { paymentsReady: false }, reason: 'payments_not_ready' },
    {
      requirement: 'market_currency_supported',
      facts: { presentmentCurrencies: ['USD'] },
      reason: 'currency_not_supported',
    },
    {
      requirement: 'fee_schedule_accepted',
      facts: {
        applicableFeeSchedule: { scheduleKey: 'standard', version: 3 },
        feeScheduleAccepted: false,
      },
      reason: 'fee_schedule_not_accepted',
    },
    {
      requirement: 'fee_schedule_accepted',
      facts: {
        applicableFeeSchedule: { scheduleKey: 'standard', version: 3 },
        feeScheduleAcceptedVersionCurrent: false,
      },
      reason: 'fee_schedule_version_superseded',
    },
    { requirement: 'no_platform_hold', facts: { settings: { platformHeld: true } }, reason: 'platform_hold' },
    {
      requirement: 'native_checkout_not_paused',
      facts: { settings: { nativeCheckoutIntent: 'paused' } },
      reason: 'merchant_paused_checkout',
    },
    { requirement: 'test_order_completed', facts: { completedOrderCount: 0 }, reason: 'no_completed_test_order' },
    { requirement: 'native_checkout_ready', facts: { nativeSatisfied: false }, reason: 'native_checkout_not_ready' },
    {
      requirement: 'guest_commerce_enabled',
      facts: { guest: { cartEnabled: false } },
      reason: 'guest_cart_disabled',
    },
    {
      requirement: 'guest_payment_method_available',
      facts: { guest: { paymentMethods: [] } },
      reason: 'guest_no_payment_surface',
    },
    {
      requirement: 'guest_fulfilment_deterministic',
      facts: { guest: { fulfilmentMethods: [] } },
      reason: 'guest_fulfilment_method_blocked',
    },
    {
      requirement: 'guest_buyer_data_permissions_scoped',
      facts: { buyerDataPermissionAssigned: false },
      reason: 'guest_buyer_data_permission_unassigned',
    },
    {
      requirement: 'guest_checkout_not_paused',
      facts: { settings: { guestCheckoutIntent: 'paused' } },
      reason: 'merchant_paused_guest_checkout',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.requirement} → ${testCase.reason}`, () => {
      const outcome = outcomes(activationFacts(testCase.facts)).get(testCase.requirement);
      expect(outcome?.state).toBe('unsatisfied');
      if (outcome && outcome.state !== 'satisfied') expect(outcome.reason).toBe(testCase.reason);
    });
  }
});

describe('a capability nobody built is UNEVALUABLE and names its owner', () => {
  it('reports the missing transactional transport as #108, not as the merchant', () => {
    const facts = activationFacts({
      nativeSatisfied: true,
      guest: { transactionalTransportConfigured: false },
    });
    const outcome = outcomes(facts).get('guest_transactional_contact_operational');
    expect(outcome?.state).toBe('unevaluable');
    if (outcome?.state === 'unevaluable') {
      expect(outcome.reason).toBe('transactional_transport_unconfigured');
      // The whole value of the third state: a merchant told to "fix" this would
      // go looking for a screen that does not exist.
      expect(outcome.owner).toBe('#108');
    }
    expect(hasUnevaluable(deriveGuestRequirements(facts), [])).toBe(true);
  });

  it('does not report unevaluable when the transport IS configured', () => {
    // The negative control for the case above: without it, a derivation that
    // answered `unevaluable` unconditionally would pass.
    const facts = activationFacts({ nativeSatisfied: true });
    expect(hasUnevaluable(deriveGuestRequirements(facts), [])).toBe(false);
  });
});

describe('the advisory list', () => {
  it('reports a failing advisory requirement and withholds nothing for it', () => {
    const facts = activationFacts({ completedOrderCount: 0 });
    const native = deriveNativeRequirements(facts);
    // DERIVED and REPORTED either way — the dashboard shows it and the operator
    // trace records it; the list decides only whether it bites.
    expect(outcomes(facts).get('test_order_completed')?.state).toBe('unsatisfied');
    expect(blockingRequirements(native, ['test_order_completed'])).toEqual([]);
    expect(blockingRequirements(native, [])).toEqual(['test_order_completed']);
  });
});
