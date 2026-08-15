/**
 * The composer (#85): read the facts, derive the two conjunctions, project them.
 *
 * ## The native half runs FIRST, and the guest half consumes its verdict
 *
 * #85 guest 1 is "General native checkout readiness passes", so guest is
 * narrower by containment. Running the native half first and handing its answer
 * in as a FACT (rather than letting the guest derivation call back into the
 * registry) is what keeps `requirements.ts` a flat record: a derivation that
 * recursed into its own map would have an answer sensitive to evaluation order.
 *
 * ## `enabled | paused | disabled | ineligible`, and each word means one thing
 *
 * `paused` is reserved for the case where the ONLY unmet requirement is the
 * merchant's own switch — everything else is ready and one click restores it.
 * `disabled` is a requirement the merchant can act on. `ineligible` (guest only)
 * is a requirement that is `unevaluable`: this deployment cannot offer guest
 * checkout to anybody, and telling a merchant to fix it would send them looking
 * for a screen that does not exist.
 */

import type {
  GuestCheckoutState,
  MerchantActivationPolicyAcceptance,
  MerchantActivationRequirementKey,
  MerchantActivationRequirementResult,
  MerchantActivationState,
  MerchantActivationSupport,
  MerchantCapabilityResult,
  MerchantCheckoutState,
} from '@mercaria/shared-types';
import { MERCHANT_ACTIVATION_POLICIES } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { deriveCapabilities } from './capabilities.js';
import { readMerchantActivationFacts, type MerchantActivationFacts } from './facts.js';
import { deriveOnboarding } from './onboarding.js';
import {
  blockingRequirements,
  deriveGuestRequirements,
  deriveNativeRequirements,
  guestKeys,
  hasUnevaluable,
  nativeKeys,
} from './requirements.js';

/**
 * Requirements that are DERIVED and REPORTED but do not withhold anything.
 *
 * Exactly one member today, and it is a deployment policy rather than a
 * judgement about a merchant: there is no launch plan in this repository
 * requiring a test order, and making it blocking by default would mean no
 * merchant could ever take a first one. A deployment that runs a pilot sets
 * `MERCHANT_ACTIVATION_TEST_ORDER_REQUIRED=true` and it starts biting.
 *
 * The list is computed per call rather than frozen at import, because a test
 * that flips the variable must see the change — and because a gate whose
 * behaviour was decided at module load is one nobody can exercise.
 */
function advisoryRequirements(): readonly MerchantActivationRequirementKey[] {
  return config.merchantActivation.testOrderRequired ? [] : ['test_order_completed'];
}

/** The composed derivation, before it is projected for anybody. */
export interface DerivedMerchantActivation {
  readonly facts: MerchantActivationFacts;
  readonly native: readonly MerchantActivationRequirementResult[];
  readonly guest: readonly MerchantActivationRequirementResult[];
  readonly nativeBlocking: readonly MerchantActivationRequirementKey[];
  readonly guestBlocking: readonly MerchantActivationRequirementKey[];
  readonly capabilities: readonly MerchantCapabilityResult[];
  readonly nativeState: MerchantCheckoutState;
  readonly guestState: GuestCheckoutState;
}

/**
 * Derive one store's activation.
 *
 * Answers `null` for a store that does not exist rather than throwing, because
 * two callers want opposite things from that: the merchant surface has already
 * loaded the store and cannot reach this with a bad id, and the checkout gate
 * treats an unknown seller as unactivated rather than as a 500.
 */
export async function deriveMerchantActivation(
  storeId: string,
): Promise<DerivedMerchantActivation | null> {
  const base = await readMerchantActivationFacts(storeId);
  if (!base) return null;

  const advisory = advisoryRequirements();

  // The native half is derived against a facts object whose `nativeSatisfied` is
  // not yet known. No native derivation reads it — the field belongs to the
  // guest registry's first member — and passing `false` here rather than
  // leaving it undefined keeps the type honest at every point.
  const nativeFacts: MerchantActivationFacts = { ...base, nativeSatisfied: false };
  const native = deriveNativeRequirements(nativeFacts);
  const nativeBlocking = blockingRequirements(native, advisory);

  const facts: MerchantActivationFacts = { ...base, nativeSatisfied: nativeBlocking.length === 0 };
  const guest = deriveGuestRequirements(facts);
  const guestBlocking = blockingRequirements(guest, advisory);

  const all = [...native, ...guest];
  const allBlocking = [...nativeBlocking, ...guestBlocking];

  return {
    facts,
    native,
    guest,
    nativeBlocking,
    guestBlocking,
    capabilities: deriveCapabilities(all, allBlocking),
    nativeState: nativeCheckoutState(nativeBlocking),
    guestState: guestCheckoutState(guest, guestBlocking, advisory),
  };
}

/** `paused` only when the merchant's own switch is the whole of what is wrong. */
function nativeCheckoutState(
  blocking: readonly MerchantActivationRequirementKey[],
): MerchantCheckoutState {
  if (blocking.length === 0) return 'enabled';
  return blocking.length === 1 && blocking[0] === 'native_checkout_not_paused' ? 'paused' : 'disabled';
}

/** The guest version, with the fourth word. */
function guestCheckoutState(
  results: readonly MerchantActivationRequirementResult[],
  blocking: readonly MerchantActivationRequirementKey[],
  advisory: readonly MerchantActivationRequirementKey[],
): GuestCheckoutState {
  if (blocking.length === 0) return 'enabled';
  if (blocking.length === 1 && blocking[0] === 'guest_checkout_not_paused') return 'paused';
  // `ineligible` beats `disabled`, the severity rule `deriveRetailCompleteness`
  // (#120) and `getRetailEligibility` (#121) both use: the worse answer wins, so
  // a merchant is never told to fix something while a capability nobody built is
  // also missing.
  return hasUnevaluable(results, advisory) ? 'ineligible' : 'disabled';
}

/** Project the derivation for the merchant's own dashboard. */
export function projectActivationState(derived: DerivedMerchantActivation): MerchantActivationState {
  const { facts } = derived;
  return {
    storeId: facts.store.id,
    nativeCheckout: {
      state: derived.nativeState,
      requirements: derived.native,
      unmet: nativeKeys(derived.nativeBlocking),
    },
    guestCheckout: {
      state: derived.guestState,
      requirements: derived.guest,
      unmet: guestKeys(derived.guestBlocking),
    },
    capabilities: derived.capabilities,
    support: projectSupport(facts),
    onboarding: deriveOnboarding(
      [...derived.native, ...derived.guest],
      [...derived.nativeBlocking, ...derived.guestBlocking],
    ),
    policies: projectPolicies(facts),
    intents: {
      nativeCheckout: facts.settings.nativeCheckoutIntent,
      guestCheckout: facts.settings.guestCheckoutIntent,
    },
    platformHold: facts.settings.platformHeld,
  };
}

/** What this deployment supports, for both actor kinds (#85 capability 5/6, state 15). */
function projectSupport(facts: MerchantActivationFacts): MerchantActivationSupport {
  return {
    presentmentCurrencies: facts.presentmentCurrencies,
    paymentMethods: facts.paymentMethods,
    markets: facts.markets,
    fulfilmentMethods: facts.fulfilmentMethods,
    guest: {
      presentmentCurrencies: facts.guest.presentmentCurrencies,
      paymentMethods: facts.guest.paymentMethods,
      // The guest market set is the deployment's markets MINUS the ones an
      // operator has withdrawn from guests. Composed rather than replaced,
      // because `GUEST_CHECKOUT_BLOCKED_MARKETS` withdraws a market from guests
      // while authenticated checkout there keeps working.
      markets: facts.markets.filter((market) => !facts.guest.blockedMarkets.includes(market)),
      fulfilmentMethods: facts.guest.fulfilmentMethods,
    },
  };
}

/** Every published policy and what this owner has accepted of it. */
function projectPolicies(
  facts: MerchantActivationFacts,
): readonly MerchantActivationPolicyAcceptance[] {
  return Object.values(MERCHANT_ACTIVATION_POLICIES)
    .filter((policy) => policy.appliesTo === 'store')
    .flatMap((policy) => {
      const accepted = facts.acceptedPolicies[policy.key];
      if (!accepted) return [];
      return [
        {
          policyKey: policy.key,
          policyVersion: accepted.policyVersion,
          acceptedByOxyUserId: accepted.acceptedByOxyUserId,
          acceptedAt: accepted.acceptedAt.toISOString(),
          current: accepted.current,
        },
      ];
    });
}

/** Derive and project in one call — the merchant surface's whole read. */
export async function readMerchantActivationState(storeId: string): Promise<MerchantActivationState> {
  const derived = await deriveMerchantActivation(storeId);
  if (!derived) throw notFound('Store not found');
  return projectActivationState(derived);
}
