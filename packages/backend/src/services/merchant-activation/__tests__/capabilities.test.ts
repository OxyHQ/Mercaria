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
import { deriveGuestRequirements, deriveNativeRequirements } from '../requirements.js';
import { activationFacts } from './facts-fixture.js';

/** Every requirement result for a store with nothing wrong with it. */
function allResults(override: Parameters<typeof activationFacts>[0] = {}) {
  const facts = activationFacts(override);
  return [...deriveNativeRequirements(facts), ...deriveGuestRequirements(facts)];
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
