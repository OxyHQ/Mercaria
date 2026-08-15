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
  FULFILMENT_MODE_REQUIREMENTS,
  GUEST_ACTIVATION_REQUIREMENTS,
  MERCHANT_ACTIVATION_REQUIREMENTS,
  MERCHANT_ACTIVATION_REQUIREMENT_KEYS,
  type MerchantActivationRequirementKey,
} from '@mercaria/shared-types';
import { deriveGuestFulfilmentMethods } from '../facts.js';
import {
  blockingRequirements,
  deriveFulfilmentModeRequirements,
  deriveGuestRequirements,
  deriveNativeRequirements,
  hasUnevaluable,
} from '../requirements.js';
import { activationFacts } from './facts-fixture.js';

/** Every requirement's outcome, in one map. */
function outcomes(facts = activationFacts()) {
  const results = [
    ...deriveNativeRequirements(facts),
    ...deriveGuestRequirements(facts),
    ...deriveFulfilmentModeRequirements(facts),
  ];
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

  it('keeps the three registries DISJOINT', () => {
    // #85 says twice that guest readiness may not be inferred from native. The
    // registries being disjoint is what makes `MerchantActivationRequirementKey`
    // a real discriminated key — a shared member would be one requirement
    // deciding two conjunctions with one answer, which is exactly the defect the
    // third registry was added to fix one layer up.
    const registries = [
      MERCHANT_ACTIVATION_REQUIREMENTS,
      GUEST_ACTIVATION_REQUIREMENTS,
      FULFILMENT_MODE_REQUIREMENTS,
    ];
    const seen = new Set<string>();
    for (const registry of registries) {
      for (const requirement of registry) {
        expect(seen.has(requirement), `${requirement} is in two registries`).toBe(false);
        seen.add(requirement);
      }
    }
    expect(MERCHANT_ACTIVATION_REQUIREMENT_KEYS.length).toBe(
      registries.reduce((total, registry) => total + registry.length, 0),
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

describe('a refusal names its OWN condition', () => {
  it('reports buyer requests being off as buyer requests being off', () => {
    // The wrong answer this replaces: `guest_support_and_returns_available`
    // answered `pickup_not_supported`, owner `#110`, when the fact it had read
    // was `BUYER_REQUESTS_ENABLED=false`. It reaches the merchant's own
    // dashboard as the stated cause of their guest checkout being `ineligible`,
    // and it sent them to wait for pickup — which had already shipped.
    const outcome = outcomes(activationFacts({ guest: { buyerRequestsEnabled: false } })).get(
      'guest_support_and_returns_available',
    );
    expect(outcome?.state).toBe('unevaluable');
    expect(outcome?.state === 'unevaluable' && outcome.reason).toBe(
      'guest_support_requests_disabled',
    );
    // The owner moved with the code. #110 SHIPPED, so naming it as the owner of
    // a gap points a merchant at work that is already done; the deployment is
    // what turned the mount off.
    expect(outcome?.state === 'unevaluable' && outcome.owner).toBe('deployment');
  });

  it('never answers a guest-support question with a PICKUP word', () => {
    // Kept as a value-level scan rather than left to the union: the defect was
    // a plausible-looking member of a thirty-code vocabulary, and the next one
    // would be too. This fires on any pickup-named reason re-appearing here,
    // whatever it is called.
    const outcome = outcomes(activationFacts({ guest: { buyerRequestsEnabled: false } })).get(
      'guest_support_and_returns_available',
    );
    const reason = outcome?.state === 'satisfied' ? '' : (outcome?.reason ?? '');
    // The floor: an empty reason would satisfy the assertion below vacuously.
    expect(reason.length).toBeGreaterThan(5);
    expect(reason).not.toMatch(/pickup/i);
  });
});

describe('the fulfilment-mode registry', () => {
  it('refuses pickup on the DEPLOYMENT lever, naming the deployment', () => {
    const outcome = outcomes(activationFacts({ fulfilment: { storePickupEnabled: false } })).get(
      'pickup_fulfilment_available',
    );
    expect(outcome?.state).toBe('unevaluable');
    expect(outcome?.state === 'unevaluable' && outcome.reason).toBe('store_pickup_disabled');
    expect(outcome?.state === 'unevaluable' && outcome.owner).toBe('deployment');
  });

  it('refuses pickup on the STORE fact, which the merchant can act on', () => {
    // Two different conditions, two different codes and two different states:
    // one is a lever nobody at this store can reach, the other is a screen they
    // have. Collapsing them would send half of them to the wrong place.
    const outcome = outcomes(activationFacts({ fulfilment: { collectableLocationCount: 0 } })).get(
      'pickup_fulfilment_available',
    );
    expect(outcome?.state).toBe('unsatisfied');
    expect(outcome?.state === 'unsatisfied' && outcome.reason).toBe('no_collectable_pickup_location');
  });

  it('answers shipping from the SHIPPING methods and pickup from the PICKUP facts', () => {
    // The independence assertion. Moving one input must move exactly one
    // answer, or the two requirements are one requirement under two names —
    // which is what the capabilities they serve had before this.
    const noShipping = outcomes(activationFacts({ fulfilment: { shippingMethods: [] } }));
    expect(noShipping.get('shipping_fulfilment_available')?.state).toBe('unevaluable');
    expect(noShipping.get('pickup_fulfilment_available')?.state).toBe('satisfied');

    const noPickup = outcomes(activationFacts({ fulfilment: { storePickupEnabled: false } }));
    expect(noPickup.get('shipping_fulfilment_available')?.state).toBe('satisfied');
    expect(noPickup.get('pickup_fulfilment_available')?.state).toBe('unevaluable');
  });
});

describe('the guest fulfilment set', () => {
  const SHIPPING_AND_PICKUP = ['standard', 'express', 'pickup'];

  /** The fulfilment facts, with collection fully available unless overridden. */
  function fulfilment(override: Partial<ReturnType<typeof activationFacts>['fulfilment']> = {}) {
    return { ...activationFacts().fulfilment, ...override };
  }

  it('OFFERS collection when both levers are on and this store has a desk', () => {
    // The wrong answer this replaces: pickup was struck out of the set
    // unconditionally, on the premise that "#93 publishes no collection state
    // and every pickup is refused at checkout". Both halves are false since #93
    // landed. This case fails against the unconditional exclusion.
    expect(
      deriveGuestFulfilmentMethods({
        priceableMethods: SHIPPING_AND_PICKUP,
        blockedFulfilmentMethods: [],
        fulfilment: fulfilment(),
      }),
    ).toEqual(['standard', 'express', 'pickup']);
  });

  it('leaves a store whose ONLY guest method is collection with a non-empty set', () => {
    // The circular case. With `GUEST_SELLER_ACTIVATION_REQUIRED` on, an empty
    // set withheld guest activation, which `derivePickupEligibility` then read
    // back as `guest_seller_not_activated` — a store refused for not being
    // activated, and unable to become activated because it was refused.
    expect(
      deriveGuestFulfilmentMethods({
        priceableMethods: SHIPPING_AND_PICKUP,
        blockedFulfilmentMethods: ['standard', 'express'],
        fulfilment: fulfilment(),
      }),
    ).toEqual(['pickup']);
  });

  it('withholds collection on each of the three conjuncts, one at a time', () => {
    // The negative controls. Without them the case above would pass against a
    // composition that offered collection unconditionally, which is the same
    // defect pointing the other way.
    for (const override of [
      { storePickupEnabled: false },
      { guestPickupEnabled: false },
      { collectableLocationCount: 0 },
    ]) {
      expect(
        deriveGuestFulfilmentMethods({
          priceableMethods: SHIPPING_AND_PICKUP,
          blockedFulfilmentMethods: [],
          fulfilment: fulfilment(override),
        }),
        `collection offered with ${JSON.stringify(override)}`,
      ).toEqual(['standard', 'express']);
    }
  });

  it('still honours the guest block list for collection', () => {
    // Availability and an operator's withdrawal are different questions, and
    // making pickup available must not have made it unblockable.
    expect(
      deriveGuestFulfilmentMethods({
        priceableMethods: SHIPPING_AND_PICKUP,
        blockedFulfilmentMethods: ['pickup'],
        fulfilment: fulfilment(),
      }),
    ).toEqual(['standard', 'express']);
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
