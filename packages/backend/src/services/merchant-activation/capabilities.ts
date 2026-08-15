/**
 * Requirements → capabilities (#85's capability model) — PURE.
 *
 * #85 asks for "server-derived capabilities rather than one broad
 * `checkoutEnabled` boolean", and the map below is what makes that more than a
 * rename: each capability names the requirements it depends on, so a merchant
 * whose Stripe account is restricted loses `authenticated_native_checkout` and
 * keeps `refund_and_return_operations` — which is #85 capability rule 4
 * ("a capability loss blocks only new ineligible checkouts and preserves
 * existing paid-order operations") expressed as a dependency list rather than
 * as care taken by whoever writes the next gate.
 *
 * ## The map is DATA and the census is a test
 *
 * A `Record` over the capability tuple, so a capability added without a
 * dependency list fails `tsc`. A capability whose list is EMPTY is a capability
 * nothing can withhold, which is the shape of a check that cannot fail — so the
 * two that legitimately have none are `not_applicable` by construction rather
 * than granted by omission.
 */

import type {
  MerchantActivationRequirementKey,
  MerchantActivationRequirementResult,
  MerchantCapability,
  MerchantCapabilityResult,
} from '@mercaria/shared-types';
import { MERCHANT_CAPABILITIES } from '@mercaria/shared-types';

/**
 * What each capability depends on.
 *
 * `p2p_seller_checkout` and `guest_p2p_checkout` carry `null` rather than an
 * empty list: a STORE is not an individual seller, so neither question applies
 * to it at all. An empty list would grant them, and a full list would withhold
 * them forever with no remedy — both are lies, and `not_applicable` is the
 * answer #85's own capability 9 ("where applicable") asks for.
 */
const CAPABILITY_DEPENDENCIES: Readonly<
  Record<MerchantCapability, readonly MerchantActivationRequirementKey[] | null>
> = {
  authenticated_native_checkout: [
    'merchant_claim_verified',
    'native_store_link_valid',
    'store_profile_complete',
    'support_contact_complete',
    'catalog_source_connected',
    'publishable_listing_exists',
    'store_policies_configured',
    'payment_provider_ready',
    'market_currency_supported',
    'fee_schedule_accepted',
    'returns_fulfilment_acknowledged',
    'no_platform_hold',
    'native_checkout_not_paused',
  ],
  guest_native_checkout: [
    'native_checkout_ready',
    'guest_commerce_enabled',
    'guest_market_currency_allowed',
    'guest_payment_method_available',
    'guest_inline_destination_supported',
    'guest_fulfilment_deterministic',
    'guest_merchant_order_access',
    'guest_support_and_returns_available',
    'guest_transactional_contact_operational',
    'guest_data_responsibilities_accepted',
    'guest_refund_operations_available',
    'guest_buyer_data_permissions_scoped',
    'guest_no_active_restriction',
    'guest_cohort_enabled',
    'guest_checkout_not_paused',
  ],
  // Shipping needs a priceable method AND somebody able to sell, because a
  // shipping capability nobody can check out through is not a capability.
  shipping_checkout: ['guest_fulfilment_deterministic', 'native_checkout_not_paused'],
  // #93 publishes no collection state and every pickup is refused at checkout,
  // so this is withheld for every store on every deployment today. It is a real
  // dependency rather than a hardcoded `false`: the day #93 lands, the
  // requirement's derivation changes and this needs no edit.
  pickup_checkout: ['guest_fulfilment_deterministic', 'native_checkout_not_paused'],
  presentment_currency_selection: ['market_currency_supported'],
  card_payment_rail: ['payment_provider_ready'],
  // Deliberately NOT dependent on the checkout requirements. #85
  // readiness-change rule 3: "Existing paid orders remain manageable." A store
  // that lost payment readiness this morning still has to be able to refund
  // yesterday's order, and a capability list that withheld this on the same
  // trigger would be the mechanism by which it could not.
  refund_and_return_operations: ['guest_refund_operations_available'],
  transactional_guest_communication: ['guest_transactional_contact_operational'],
  p2p_seller_checkout: null,
  guest_p2p_checkout: null,
};

/**
 * Derive every capability for a store.
 *
 * The unmet list is the INTERSECTION of the capability's dependencies with the
 * requirements that actually failed, so a capability names only what is wrong
 * with IT — a merchant reading `guest_native_checkout` withheld should not be
 * shown a native blocker they already know about under a second heading.
 */
export function deriveCapabilities(
  results: readonly MerchantActivationRequirementResult[],
  blocking: readonly MerchantActivationRequirementKey[],
): readonly MerchantCapabilityResult[] {
  const blockingSet = new Set(blocking);
  // A requirement whose outcome is not satisfied but which the deployment made
  // advisory is NOT in `blocking`, so it withholds nothing here either. One list
  // decides both, which is what stops the gate and the dashboard disagreeing.
  const known = new Set(results.map((result) => result.requirement));

  return MERCHANT_CAPABILITIES.map((capability) => {
    const dependencies = CAPABILITY_DEPENDENCIES[capability];
    if (dependencies === null) {
      return { capability, state: 'not_applicable' as const, unmet: [] };
    }
    // A dependency the caller did not evaluate is a defect in the composition,
    // not a pass: #74's `rankOffers` throws on an admission that does not cover
    // its rule tuple, for exactly this reason.
    const missing = dependencies.filter((requirement) => !known.has(requirement));
    if (missing.length > 0) {
      throw new Error(
        `Capability ${capability} depends on unevaluated requirements: ${missing.join(', ')}.`,
      );
    }
    const unmet = dependencies.filter((requirement) => blockingSet.has(requirement));
    return {
      capability,
      state: unmet.length === 0 ? ('granted' as const) : ('withheld' as const),
      unmet,
    };
  });
}

/** Every requirement any capability depends on — the census test's input. */
export function capabilityDependencies(): Readonly<
  Record<MerchantCapability, readonly MerchantActivationRequirementKey[] | null>
> {
  return CAPABILITY_DEPENDENCIES;
}
