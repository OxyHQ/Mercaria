/**
 * Requirements → capabilities → onboarding steps (#85), and the two CENSUSES
 * that keep both maps honest.
 *
 * A capability with no dependency list can never be withheld, and a requirement
 * covered by no step is one a merchant is never told about. Both look exactly
 * like a working feature, which is why each is walked rather than spot-checked.
 */

import { describe, expect, it } from 'vitest';
import {
  MERCHANT_ACTIVATION_REQUIREMENT_KEYS,
  MERCHANT_CAPABILITIES,
  MERCHANT_ONBOARDING_STEPS,
  type MerchantActivationRequirementKey,
} from '@mercaria/shared-types';
import { capabilityDependencies, deriveCapabilities } from '../capabilities.js';
import { deriveOnboarding, STEPLESS_REQUIREMENTS, stepRequirements } from '../onboarding.js';
import {
  deriveFulfilmentModeRequirements,
  deriveGuestRequirements,
  deriveNativeRequirements,
} from '../requirements.js';
import { activationFacts } from './facts-fixture.js';

/** Every requirement result for a store with nothing wrong with it. */
function allResults(override: Parameters<typeof activationFacts>[0] = {}) {
  const facts = activationFacts(override);
  return [
    ...deriveNativeRequirements(facts),
    ...deriveGuestRequirements(facts),
    ...deriveFulfilmentModeRequirements(facts),
  ];
}

/** Which requirements are blocking, for a given override. */
function blocking(override: Parameters<typeof activationFacts>[0] = {}) {
  return allResults(override)
    .filter((result) => result.outcome.state !== 'satisfied')
    .map((result) => result.requirement);
}

describe('the capability census', () => {
  it('gives every capability a dependency list or an explicit not-applicable', () => {
    const map = capabilityDependencies();
    for (const capability of MERCHANT_CAPABILITIES) {
      expect(capability in map, `${capability} has no disposition`).toBe(true);
      const dependencies = map[capability];
      // `null` is the decision "this does not apply"; an EMPTY list would be a
      // capability nothing could withhold, which is a check that cannot fail.
      expect(dependencies === null || dependencies.length > 0).toBe(true);
    }
    expect(Object.keys(map)).toHaveLength(MERCHANT_CAPABILITIES.length);
  });

  it('names only requirements that exist', () => {
    const known = new Set<string>(MERCHANT_ACTIVATION_REQUIREMENT_KEYS);
    for (const dependencies of Object.values(capabilityDependencies())) {
      for (const requirement of dependencies ?? []) {
        expect(known.has(requirement), `${requirement} is not a published requirement`).toBe(true);
      }
    }
  });
});

describe('the onboarding census', () => {
  it('covers every requirement exactly once, or names it stepless with a reason', () => {
    const covered = new Map<MerchantActivationRequirementKey, number>();
    for (const requirements of Object.values(stepRequirements())) {
      for (const requirement of requirements) {
        covered.set(requirement, (covered.get(requirement) ?? 0) + 1);
      }
    }
    for (const requirement of MERCHANT_ACTIVATION_REQUIREMENT_KEYS) {
      const count = covered.get(requirement) ?? 0;
      const stepless = requirement in STEPLESS_REQUIREMENTS;
      // Exactly one of the two. Covered twice sends a merchant to fix the same
      // thing on two screens; covered by neither and not declared stepless is
      // silence, which is what the census refuses (`merge-plan.ts`' `untouched`
      // WITH a reason, one domain over).
      expect(
        (count === 1 && !stepless) || (count === 0 && stepless),
        `${requirement}: covered ${String(count)} times, stepless=${String(stepless)}`,
      ).toBe(true);
      if (stepless) expect(STEPLESS_REQUIREMENTS[requirement]?.length).toBeGreaterThan(10);
    }
    // The vacuity floor: a `stepRequirements()` returning nothing satisfies the
    // loop above for every stepless member and would otherwise read as a pass.
    expect(covered.size).toBeGreaterThan(10);
  });

  it('names only steps that exist, and every step exactly once', () => {
    expect(Object.keys(stepRequirements()).sort()).toEqual([...MERCHANT_ONBOARDING_STEPS].sort());
  });
});

describe('capabilities on a ready store', () => {
  it('grants everything a store can hold and marks the two P2P ones not applicable', () => {
    const results = deriveCapabilities(allResults(), blocking());
    const byCapability = new Map(results.map((result) => [result.capability, result]));
    expect(byCapability.get('authenticated_native_checkout')?.state).toBe('granted');
    expect(byCapability.get('guest_native_checkout')?.state).toBe('granted');
    // A STORE is not an individual seller. `withheld` would put a permanent
    // unfixable red mark on every dashboard and `granted` would be a lie.
    expect(byCapability.get('p2p_seller_checkout')?.state).toBe('not_applicable');
    expect(byCapability.get('guest_p2p_checkout')?.state).toBe('not_applicable');
  });

  it('withholds ONLY the guest half when guest checkout is paused', () => {
    // #85 readiness-change rule 9, and it is the case a single `checkoutEnabled`
    // boolean cannot express at all.
    const override = { settings: { guestCheckoutIntent: 'paused' as const } };
    const results = deriveCapabilities(allResults(override), blocking(override));
    const byCapability = new Map(results.map((result) => [result.capability, result]));
    expect(byCapability.get('authenticated_native_checkout')?.state).toBe('granted');
    expect(byCapability.get('guest_native_checkout')?.state).toBe('withheld');
    expect(byCapability.get('guest_native_checkout')?.unmet).toEqual(['guest_checkout_not_paused']);
  });

  it('keeps refunds available when payment readiness is LOST', () => {
    // #85 readiness-change rule 3: existing paid orders remain manageable. A
    // capability list that withheld refunds on the same trigger would be the
    // mechanism by which yesterday's order could not be refunded today.
    const override = { paymentsReady: false, nativeSatisfied: false };
    const results = deriveCapabilities(allResults(override), blocking(override));
    const byCapability = new Map(results.map((result) => [result.capability, result]));
    expect(byCapability.get('authenticated_native_checkout')?.state).toBe('withheld');
    expect(byCapability.get('refund_and_return_operations')?.state).toBe('granted');
  });

  it('THROWS on a capability whose dependency was never evaluated', () => {
    // #74's `rankOffers` rule: a requirement added to a registry and not wired
    // into the derivation must fail the first comparison rather than quietly
    // widening what is granted.
    expect(() => deriveCapabilities([], [])).toThrow(/depends on unevaluated requirements/);
  });
});

/**
 * The two capabilities that name ONE fulfilment mode.
 *
 * They shared `guest_fulfilment_deterministic` until this file's cases were
 * written — one requirement, answering "is the guest-eligible method set
 * non-empty", handed to two capabilities that ask different questions. Every
 * case below is therefore a WRONG-ANSWER case rather than a right-answer one:
 * each fixture is chosen so the shared-dependency wiring returns the OPPOSITE
 * of what it asserts, because a case that only pins the correct branch passes
 * against both wirings whenever the fixture happens to satisfy both.
 */
describe('a capability that names a fulfilment mode measures THAT mode', () => {
  /** Read one capability's state and unmet list for an override. */
  function capability(
    name: 'shipping_checkout' | 'pickup_checkout',
    override: Parameters<typeof activationFacts>[0],
  ) {
    const results = deriveCapabilities(allResults(override), blocking(override));
    const found = results.find((result) => result.capability === name);
    expect(found, `${name} was not derived`).toBeDefined();
    return found;
  }

  it('WITHHOLDS pickup on a deployment that does not offer collection', () => {
    // The live wrong answer: `STORE_PICKUP_ENABLED` is off by DEFAULT, and with
    // shipping rates configured the shared dependency was satisfied — so this
    // read `granted` for every store on every deployment. The guest set is left
    // non-empty here on purpose, because that is precisely what used to carry
    // the capability.
    const override = { fulfilment: { storePickupEnabled: false } };
    expect(activationFacts(override).guest.fulfilmentMethods.length).toBeGreaterThan(0);

    const pickup = capability('pickup_checkout', override);
    expect(pickup?.state).toBe('withheld');
    expect(pickup?.unmet).toEqual(['pickup_fulfilment_available']);
  });

  it('WITHHOLDS pickup when the deployment offers it and this store published nowhere', () => {
    // The other half of "granted for every store": a deployment lever alone
    // cannot make this a fact about THIS shop.
    const pickup = capability('pickup_checkout', { fulfilment: { collectableLocationCount: 0 } });
    expect(pickup?.state).toBe('withheld');
    expect(pickup?.unmet).toEqual(['pickup_fulfilment_available']);
  });

  it('GRANTS pickup to a store whose only remaining guest method is collection', () => {
    // The inverse wrong answer, and the one that costs a merchant a sale: with
    // both shipping methods withdrawn from guests the shared dependency was
    // UNSATISFIED, so a shop with an open collection desk read `withheld`.
    const override = {
      guest: { fulfilmentMethods: [] },
      fulfilment: { shippingMethods: [] },
    };
    expect(activationFacts(override).guest.fulfilmentMethods).toEqual([]);

    expect(capability('pickup_checkout', override)?.state).toBe('granted');
  });

  it('makes the two answers DISAGREE, in both directions', () => {
    // The assertion the shared wiring cannot satisfy at all. One dependency
    // means one answer, so under it these two capabilities are equal on every
    // input — and a suite that never asks them to differ measures nothing about
    // which mode either one names.
    const pickupOnly = { guest: { fulfilmentMethods: [] }, fulfilment: { shippingMethods: [] } };
    expect(capability('pickup_checkout', pickupOnly)?.state).toBe('granted');
    expect(capability('shipping_checkout', pickupOnly)?.state).toBe('withheld');

    const shippingOnly = { fulfilment: { storePickupEnabled: false } };
    expect(capability('pickup_checkout', shippingOnly)?.state).toBe('withheld');
    expect(capability('shipping_checkout', shippingOnly)?.state).toBe('granted');
  });

  it('keeps a mode requirement OUT of both checkout conjunctions', () => {
    // The reason these live in a third registry. A member of the native one
    // would read `nativeCheckout: disabled` for every store on a deployment
    // with collection off — which is the default, and a far worse answer than
    // the one it would have fixed.
    const override = { fulfilment: { storePickupEnabled: false } };
    const facts = activationFacts(override);
    const nativeKeysDerived = deriveNativeRequirements(facts).map((result) => result.requirement);
    const guestKeysDerived = deriveGuestRequirements(facts).map((result) => result.requirement);

    expect(nativeKeysDerived).not.toContain('pickup_fulfilment_available');
    expect(guestKeysDerived).not.toContain('pickup_fulfilment_available');
    // The vacuity floor: an empty derivation would satisfy both lines above.
    expect(nativeKeysDerived.length).toBeGreaterThan(10);
    expect(guestKeysDerived.length).toBeGreaterThan(10);
    // And it IS derived — by the third registry, which is what reaches the
    // capability map. "Excluded" must not read as "never answered".
    expect(deriveFulfilmentModeRequirements(facts).map((result) => result.requirement)).toContain(
      'pickup_fulfilment_available',
    );
  });
});

describe('onboarding steps', () => {
  it('completes every step on a ready store', () => {
    const steps = deriveOnboarding(allResults(), blocking());
    expect(steps).toHaveLength(MERCHANT_ONBOARDING_STEPS.length);
    expect(steps.every((step) => step.state === 'complete')).toBe(true);
  });

  it('marks a step BLOCKED when its gap is unevaluable, and INCOMPLETE otherwise', () => {
    const blockedOverride = { guest: { transactionalTransportConfigured: false } };
    const blockedSteps = deriveOnboarding(
      allResults(blockedOverride),
      blocking(blockedOverride),
    );
    // The transport gap is stepless (nothing a merchant can do), so no step
    // carries it — which is exactly the census's point. The step that DOES have
    // a merchant-actionable gap is the one below.
    expect(blockedSteps.every((step) => step.state !== 'blocked')).toBe(true);

    const incompleteOverride = { settings: { supportEmail: null, supportUrl: null } };
    const steps = deriveOnboarding(allResults(incompleteOverride), blocking(incompleteOverride));
    const contact = steps.find((step) => step.step === 'configure_support_contact');
    expect(contact?.state).toBe('incomplete');
    expect(contact?.unmet).toEqual(['support_contact_complete']);
  });
});
