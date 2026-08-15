/**
 * The resumable dashboard flow (#85's fourteen steps) — PURE, and DERIVED.
 *
 * ## There is no progress record, and that is what makes it resumable
 *
 * #85 asks that "every step can be resumed on another client through the Oxy
 * account". A stored cursor would satisfy the words and fail the thing: it goes
 * out of date the moment a merchant changes something on another surface, and
 * two clients would then disagree about where the merchant is. Progress here IS
 * the authoritative state — a step is complete when the requirements it covers
 * are satisfied — so there is nothing to resume from and nothing to reconcile.
 *
 * It is also why acceptance 5 ("the flow resumes idempotently and does not
 * create duplicate stores, connections or provider accounts") needs no
 * idempotency mechanism in this module: reading creates nothing, and each of the
 * three creations it names is already held by an index in the domain that owns
 * it (#84's `store_linkage_requests_open_key`, #87's connection unique, #46's
 * `UNIQUE(provider, owner_type, owner_id)`).
 *
 * ## Every requirement belongs to exactly one step
 *
 * A census test asserts it, in both directions: a requirement covered by no step
 * is one a merchant is never told about, and a requirement covered by two is one
 * they are sent to fix twice. `not_applicable` is a decision the census accepts;
 * silence is not.
 */

import type {
  MerchantActivationRequirementKey,
  MerchantActivationRequirementResult,
  MerchantOnboardingStep,
  MerchantOnboardingStepResult,
} from '@mercaria/shared-types';
import { MERCHANT_ONBOARDING_STEPS } from '@mercaria/shared-types';

/**
 * Which requirements each step is responsible for.
 *
 * A `Record` over the step tuple, so a step added without a mapping fails `tsc`.
 * Two steps carry an EMPTY list and each says why: they are things the merchant
 * reads rather than facts the server can check, and giving them a borrowed
 * requirement would make a step complete for a reason that has nothing to do
 * with it.
 */
const STEP_REQUIREMENTS: Readonly<
  Record<MerchantOnboardingStep, readonly MerchantActivationRequirementKey[]>
> = {
  /**
   * #85 dashboard 1 — "why the merchant already appears on Mercaria and the
   * demand Mercaria has observed". #86 owns the demand figures and this step
   * renders them; there is nothing for a merchant to satisfy, so the step is
   * `complete` as soon as there is a merchant to show it about.
   */
  review_presence_and_demand: ['merchant_claim_verified'],
  confirm_native_store: ['native_store_link_valid'],
  connect_catalog: ['catalog_source_connected', 'catalog_sync_healthy'],
  review_imported_matches: ['publishable_listing_exists'],
  configure_currency_and_markets: ['market_currency_supported'],
  start_payment_onboarding: ['payment_provider_ready'],
  review_fee_schedule: ['fee_schedule_accepted'],
  capture_store_policies: ['store_policies_configured', 'returns_fulfilment_acknowledged'],
  configure_support_contact: ['store_profile_complete', 'support_contact_complete'],
  /**
   * #85 dashboard 10 — "Explains authenticated and guest checkout as separate
   * capabilities". Reading, not doing. The empty list is deliberate: borrowing
   * `guest_commerce_enabled` would mark the explanation incomplete on a
   * deployment that has guest commerce switched off, which explains it perfectly
   * well.
   */
  review_checkout_capabilities: [],
  confirm_guest_contact_handling: [
    'guest_data_responsibilities_accepted',
    'guest_buyer_data_permissions_scoped',
    'guest_refund_operations_available',
  ],
  configure_fulfilment_methods: ['guest_fulfilment_deterministic'],
  run_readiness_checks: ['test_order_completed'],
  enable_capabilities: ['native_checkout_not_paused', 'guest_checkout_not_paused'],
};

/**
 * Requirements no STEP covers, with the reason.
 *
 * Every one is a fact about the DEPLOYMENT rather than about the merchant, so
 * there is no screen a merchant could be sent to. Naming them here is what lets
 * the census demand a decision for every requirement instead of accepting
 * silence — `merge-plan.ts`' `untouched` with a reason, one domain over.
 */
export const STEPLESS_REQUIREMENTS: Readonly<
  Partial<Record<MerchantActivationRequirementKey, string>>
> = {
  no_platform_hold: 'An operator decision. A merchant cannot act on it and must not be sent to try.',
  native_checkout_ready: 'The native conjunction itself; every step above already covers a part of it.',
  guest_commerce_enabled: 'A deployment flag. No merchant screen changes it.',
  guest_market_currency_allowed: 'Deployment configuration — which markets and currencies are charged.',
  guest_payment_method_available: 'Deployment configuration — which Stripe surfaces are enabled.',
  guest_inline_destination_supported: 'A deployment flag (#105).',
  guest_merchant_order_access: 'Structural (#106). Nothing to configure.',
  guest_support_and_returns_available: 'A deployment flag (#110).',
  guest_transactional_contact_operational: 'A named seam (#108). No transport is registered.',
  guest_no_active_restriction: 'An operator decision, like the hold above.',
  guest_cohort_enabled: 'An operator decision (#111 owns a positive cohort model).',
};

/** Derive the whole flow. */
export function deriveOnboarding(
  results: readonly MerchantActivationRequirementResult[],
  blocking: readonly MerchantActivationRequirementKey[],
): readonly MerchantOnboardingStepResult[] {
  const blockingSet = new Set(blocking);
  const outcomes = new Map(results.map((result) => [result.requirement, result.outcome]));

  return MERCHANT_ONBOARDING_STEPS.map((step) => {
    const requirements = STEP_REQUIREMENTS[step];
    const unmet = requirements.filter((requirement) => blockingSet.has(requirement));
    if (unmet.length === 0) {
      return { step, state: 'complete' as const, requirements, unmet };
    }
    // `blocked` when nothing the merchant does can fix it — an `unevaluable`
    // outcome is a capability nobody built. Rendering that the same as
    // `incomplete` makes a merchant press a button that cannot work.
    const blocked = unmet.some((requirement) => outcomes.get(requirement)?.state === 'unevaluable');
    return { step, state: blocked ? ('blocked' as const) : ('incomplete' as const), requirements, unmet };
  });
}

/** The map, for the census test. */
export function stepRequirements(): Readonly<
  Record<MerchantOnboardingStep, readonly MerchantActivationRequirementKey[]>
> {
  return STEP_REQUIREMENTS;
}
