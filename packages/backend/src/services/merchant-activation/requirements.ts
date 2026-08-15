/**
 * The activation derivation (#85) — PURE, and that is enforced by a gate.
 *
 * This module imports no repository, no database handle and no service. It
 * takes {@link MerchantActivationFacts} — everything `facts.ts` read — and
 * answers every requirement. `getRetailEligibility`'s rule (#121), for its
 * reason: a derivation that can reach a table is a derivation whose answer
 * depends on when it was called, and the whole point of deriving rather than
 * storing is that the answer is a function of the facts at THIS instant.
 * `merchant-activation-isolation.test.ts` fails the build if that changes.
 *
 * ## Every requirement is answered, and the census says so
 *
 * The record below is `Record<MerchantActivationRequirementKey, …>`, so a
 * member added to either registry fails `tsc` here rather than being silently
 * absent from a conjunction. #112's census test is the precedent — a criterion
 * published and never evaluated reads exactly like one that always passes.
 *
 * ## Two of three outcomes block, and the third is not "maybe"
 *
 * `unsatisfied` is a merchant's own work. `unevaluable` is Mercaria's: this
 * deployment cannot answer the question at all, and it NAMES whose gap it is.
 * Both withhold. Nothing here returns "probably fine".
 */

import type {
  FulfilmentModeRequirement,
  GuestActivationRequirement,
  MerchantActivationOutcome,
  MerchantActivationRequirement,
  MerchantActivationRequirementKey,
  MerchantActivationRequirementResult,
} from '@mercaria/shared-types';
import {
  FULFILMENT_MODE_REQUIREMENTS,
  GUEST_ACTIVATION_REQUIREMENTS,
  MERCHANT_ACTIVATION_REQUIREMENTS,
} from '@mercaria/shared-types';
import type { MerchantActivationFacts } from './facts.js';

/**
 * The three predicates the CHECKOUT gate also calls.
 *
 * Named and exported rather than inlined into the record below, because
 * `checkout-gate.ts` enforces exactly these three and must not re-implement
 * them: two spellings of "paused" or "not accepted" can disagree, and the place
 * that must not happen is a gate telling a buyer a shop is closed. One
 * definition, two callers — the shape #88 already uses for the fee arithmetic
 * the dashboard, the preview and the order snapshot all share.
 *
 * Each takes only the facts it reads, so the gate can answer them from two rows
 * instead of the eleven tables the full derivation needs.
 */
export function deriveNoPlatformHold(settings: {
  platformHeld: boolean;
}): MerchantActivationOutcome {
  return settings.platformHeld ? no('platform_hold') : OK;
}

/** The merchant's own native switch. */
export function deriveNativeCheckoutNotPaused(settings: {
  nativeCheckoutIntent: string;
}): MerchantActivationOutcome {
  return settings.nativeCheckoutIntent === 'enabled' ? OK : no('merchant_paused_checkout');
}

/** The merchant's own guest switch. */
export function deriveGuestCheckoutNotPaused(settings: {
  guestCheckoutIntent: string;
}): MerchantActivationOutcome {
  return settings.guestCheckoutIntent === 'enabled' ? OK : no('merchant_paused_guest_checkout');
}

/**
 * #88's deferred acceptance gate.
 *
 * NO applicable schedule is satisfied and not a failure: `no_active_schedule` is
 * #88's honest zero, and refusing a checkout because nobody has published a fee
 * policy would make a fresh deployment unable to sell anything.
 */
export function deriveFeeScheduleAccepted(fee: {
  applicableFeeSchedule: { scheduleKey: string; version: number } | null;
  feeScheduleAccepted: boolean;
  feeScheduleAcceptedVersionCurrent: boolean;
}): MerchantActivationOutcome {
  if (!fee.applicableFeeSchedule) return OK;
  if (!fee.feeScheduleAccepted) return no('fee_schedule_not_accepted');
  return fee.feeScheduleAcceptedVersionCurrent ? OK : no('fee_schedule_version_superseded');
}

/** Satisfied. */
const OK: MerchantActivationOutcome = { state: 'satisfied' };

/** A requirement the merchant can act on. */
function no(
  reason: Extract<MerchantActivationOutcome, { state: 'unsatisfied' }>['reason'],
): MerchantActivationOutcome {
  return { state: 'unsatisfied', reason };
}

/** A question this deployment cannot answer, and whose gap it is. */
function cannotAnswer(
  reason: Extract<MerchantActivationOutcome, { state: 'unevaluable' }>['reason'],
  owner: Extract<MerchantActivationOutcome, { state: 'unevaluable' }>['owner'],
): MerchantActivationOutcome {
  return { state: 'unevaluable', reason, owner };
}

/**
 * One requirement's derivation, as data.
 *
 * A `Record` over the key union rather than a switch: the compiler then demands
 * every member, and a reader can see the whole conjunction on one screen instead
 * of tracing fall-through.
 */
type Derivation = (facts: MerchantActivationFacts) => MerchantActivationOutcome;

const DERIVATIONS: Readonly<Record<MerchantActivationRequirementKey, Derivation>> = {
  /* ── Native ─────────────────────────────────────────────────────────── */

  merchant_claim_verified: (f) => {
    if (!f.merchant) return no('no_linked_merchant');
    if (f.merchant.claimState === 'verified') return OK;
    return f.merchant.claimState === 'unclaimed' ? no('merchant_not_claimed') : no('merchant_claim_not_verified');
  },

  // A store with no merchant behind it fails BOTH this and the claim above, and
  // that is not redundancy: a merchant whose link was revoked keeps its verified
  // claim, so the two reasons name genuinely different repairs.
  native_store_link_valid: (f) => (f.merchant ? OK : no('no_linked_merchant')),

  store_profile_complete: (f) =>
    f.store.name.trim().length > 0 && f.store.description.trim().length > 0
      ? OK
      : no('store_profile_incomplete'),

  support_contact_complete: (f) =>
    f.settings.supportEmail !== null || f.settings.supportUrl !== null
      ? OK
      : no('support_contact_missing'),

  // The catalogue three read #87's ONE authoritative result and re-derive
  // nothing. `deriveChannelReadiness` already answers "is anything supplying a
  // catalogue, is it landing, is there something to sell" over five tables; a
  // second reading here would be the two-representations failure in a gate that
  // tells a merchant they can sell.
  catalog_source_connected: (f) =>
    f.channelReadiness.nativeCheckout.blockers.includes('no_connected_channel')
      ? no('no_connected_channel')
      : f.channelReadiness.nativeCheckout.blockers.includes('no_native_checkout_channel')
        ? no('no_native_checkout_channel')
        : OK,

  catalog_sync_healthy: (f) =>
    f.channelReadiness.nativeCheckout.blockers.includes('no_successful_sync')
      ? no('no_successful_sync')
      : f.channelReadiness.catalog.state === 'degraded'
        ? no('catalog_sync_degraded')
        : OK,

  publishable_listing_exists: (f) =>
    f.channelReadiness.nativeCheckout.blockers.includes('no_publishable_listing')
      ? no('no_publishable_listing')
      : OK,

  // The return window has a default, so it is always set; a refund policy and a
  // privacy policy are what a buyer actually needs to read before a native
  // order, and neither has one.
  store_policies_configured: (f) =>
    isPresent(f.store.policiesRefundPolicy) && isPresent(f.store.policiesPrivacyPolicy)
      ? OK
      : no('store_policies_incomplete'),

  payment_provider_ready: (f) => {
    if (!f.railEnabled) return no('payment_rail_disabled');
    return f.paymentsReady ? OK : no('payments_not_ready');
  },

  market_currency_supported: (f) =>
    f.presentmentCurrencies.includes(f.store.defaultCurrency) ? OK : no('currency_not_supported'),

  fee_schedule_accepted: (f) => deriveFeeScheduleAccepted(f),

  returns_fulfilment_acknowledged: (f) =>
    policyOutcome(f, 'returns_and_fulfilment_responsibilities'),

  no_platform_hold: (f) => deriveNoPlatformHold(f.settings),

  native_checkout_not_paused: (f) => deriveNativeCheckoutNotPaused(f.settings),

  // #85 state 12. Whether it BLOCKS is a deployment policy
  // (`MERCHANT_ACTIVATION_TEST_ORDER_REQUIRED`), because there is no launch plan
  // in this repository requiring one and making it blocking by default would
  // mean no merchant could ever take a first order. It is always EVALUATED and
  // always reported; `blocking` decides whether the answer withholds anything.
  test_order_completed: (f) =>
    f.completedOrderCount > 0 ? OK : no('no_completed_test_order'),

  /* ── Guest ──────────────────────────────────────────────────────────── */

  // The native conjunction as ONE conjunct. #85 guest 1 verbatim, and the reason
  // guest is narrower than native by CONTAINMENT rather than by an extra
  // threshold on somebody else's verdict.
  native_checkout_ready: (f) => (f.nativeSatisfied ? OK : no('native_checkout_not_ready')),

  guest_commerce_enabled: (f) => {
    if (!f.guest.commerceEnabled) return no('guest_commerce_disabled');
    if (!f.guest.cartEnabled) return no('guest_cart_disabled');
    return OK;
  },

  guest_market_currency_allowed: (f) =>
    f.guest.presentmentCurrencies.length === 0
      ? no('guest_currency_not_chargeable')
      : f.guest.blockedMarkets.length > 0 && f.guest.markets.length > 0 &&
          f.guest.markets.every((market) => f.guest.blockedMarkets.includes(market))
        ? no('guest_market_blocked')
        : OK,

  guest_payment_method_available: (f) =>
    f.guest.paymentMethods.length > 0 ? OK : no('guest_no_payment_surface'),

  guest_inline_destination_supported: (f) =>
    f.guest.inlineDestinationEnabled ? OK : no('guest_inline_destination_disabled'),

  // At least one method must be BOTH priceable by this deployment and not
  // withdrawn from guests. `facts.ts` composes that set, and pickup is now IN
  // it whenever #93's two levers are on and this store published somewhere to
  // collect from — it was struck out unconditionally on a premise #93 retired,
  // and the exclusion had become circular under
  // `GUEST_SELLER_ACTIVATION_REQUIRED`.
  //
  // This answers "is there any guest-eligible method at all" and deliberately
  // says nothing about WHICH: the two capabilities that name one mode read
  // `FULFILMENT_MODE_REQUIREMENTS` instead, because a set that is non-empty for
  // two different reasons cannot tell them apart.
  guest_fulfilment_deterministic: (f) =>
    f.guest.fulfilmentMethods.length > 0 ? OK : no('guest_fulfilment_method_blocked'),

  // #106 made this structural: `MerchantOrder` `Omit`s the three buyer fields
  // and the contact comes from the FK'd `guest_checkouts` snapshot, so a
  // merchant reads a guest order without an Oxy profile by construction. There
  // is nothing per-store to check, and reporting it as a requirement anyway is
  // what makes the guarantee visible on the dashboard instead of implicit.
  guest_merchant_order_access: () => OK,

  // #110's buyer WRITE mount, switched off deployment-wide. The reason names
  // THAT, and the owner is the deployment: #110 shipped, so pointing a merchant
  // at it would send them to wait for something that already exists. It read
  // `pickup_not_supported`/`#110` until this fix — a reason belonging to an
  // unrelated condition, on the merchant's own dashboard, as the stated cause
  // of their guest checkout being `ineligible`.
  guest_support_and_returns_available: (f) =>
    f.guest.buyerRequestsEnabled
      ? OK
      : cannotAnswer('guest_support_requests_disabled', 'deployment'),

  // The one that FAILS CLOSED and is not a merchant's fault. Mercaria has no
  // outbound mail transport: #108's registry is empty and every send fails
  // `transport_unconfigured`. A guest who cannot be told their order number,
  // cannot recover access and cannot be sent a return label is a guest whose
  // purchase this store cannot support — so guest checkout is INELIGIBLE here,
  // which is a different word from disabled and routes to a different place.
  guest_transactional_contact_operational: (f) =>
    f.guest.transactionalTransportConfigured
      ? OK
      : cannotAnswer('transactional_transport_unconfigured', '#108'),

  guest_data_responsibilities_accepted: (f) => policyOutcome(f, 'guest_data_and_contact_handling'),

  // #110 mounts the buyer's request path; the merchant's refund route is
  // `/admin/stores/:storeId/orders/:id/refunds`, which exists for every store.
  // The check that matters is that somebody on the store can actually press it.
  guest_refund_operations_available: (f) =>
    f.refundPermissionAssigned ? OK : no('guest_buyer_data_permission_unassigned'),

  guest_buyer_data_permissions_scoped: (f) =>
    f.buyerDataPermissionAssigned ? OK : no('guest_buyer_data_permission_unassigned'),

  guest_no_active_restriction: (f) => {
    if (f.settings.platformHeld) return no('platform_hold');
    return f.guest.sellerBlockedByOperator ? no('guest_seller_blocked_by_operator') : OK;
  },

  // #111 owns a positive rollout cohort. Until it publishes one, the cohort
  // dimension is the block list ADR 0006 G14 already decided on — a merchant is
  // in the cohort unless an operator took it out — and this requirement reads
  // exactly that. It is NOT reported `unevaluable`: the fact it needs exists and
  // is answered, and claiming otherwise would make every store ineligible on the
  // deploy that added the requirement.
  guest_cohort_enabled: (f) =>
    f.guest.sellerBlockedByOperator ? no('guest_seller_blocked_by_operator') : OK,

  guest_checkout_not_paused: (f) => deriveGuestCheckoutNotPaused(f.settings),

  /* ── Fulfilment modes ───────────────────────────────────────────────────── */

  // Deployment configuration, so `unevaluable` and owner `deployment`: a
  // merchant cannot make this deployment able to price a parcel. Moovo owns
  // per-store shipping serviceability (#155/#160) and this repository holds
  // only the seam, so the honest fact available is whether ANY method that puts
  // goods in transit can be priced at all.
  shipping_fulfilment_available: (f) =>
    f.fulfilment.shippingMethods.length > 0
      ? OK
      : cannotAnswer('no_priceable_shipping_method', 'deployment'),

  // The one that used to measure nothing about itself. Two facts, in the order
  // a merchant can act on them: the deployment lever first (nothing they can
  // do), then their own publications (a screen they have).
  //
  // The store-level half is the LOCATION half of #93's conjunction and no more
  // — stock, opening hours and the listing belong to a request about one item
  // and are answered by `derivePickupEligibility` when one arrives. So this
  // says "this store has somewhere a shopper could collect from", which is the
  // onboarding question #85 asks, and never "this can be collected now".
  pickup_fulfilment_available: (f) => {
    if (!f.fulfilment.storePickupEnabled) return cannotAnswer('store_pickup_disabled', 'deployment');
    return f.fulfilment.collectableLocationCount > 0 ? OK : no('no_collectable_pickup_location');
  },
};

/** Whether an optional prose column carries something. */
function isPresent(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

/** A policy is satisfied when the CURRENT version has been accepted. */
function policyOutcome(
  facts: MerchantActivationFacts,
  key: 'returns_and_fulfilment_responsibilities' | 'guest_data_and_contact_handling',
): MerchantActivationOutcome {
  const acceptance = facts.acceptedPolicies[key];
  if (!acceptance) return no('policy_not_accepted');
  return acceptance.current ? OK : no('policy_version_superseded');
}

/**
 * Derive every NATIVE requirement.
 *
 * `test_order_completed` is filtered out of the blocking conjunction when the
 * deployment does not require one — it is still DERIVED and still reported, so
 * the dashboard shows it and the operator trace records it; what the flag
 * changes is whether its answer withholds a capability.
 */
export function deriveNativeRequirements(
  facts: MerchantActivationFacts,
): readonly MerchantActivationRequirementResult[] {
  return MERCHANT_ACTIVATION_REQUIREMENTS.map((requirement) => ({
    requirement,
    outcome: DERIVATIONS[requirement](facts),
  }));
}

/** Derive every GUEST requirement. */
export function deriveGuestRequirements(
  facts: MerchantActivationFacts,
): readonly MerchantActivationRequirementResult[] {
  return GUEST_ACTIVATION_REQUIREMENTS.map((requirement) => ({
    requirement,
    outcome: DERIVATIONS[requirement](facts),
  }));
}

/**
 * Derive every FULFILMENT-MODE requirement.
 *
 * A third call rather than a third slice of one, because the composer must be
 * able to keep these out of the two CONJUNCTIONS while feeding them to the
 * capability derivation. Splitting the registries is what makes that a matter
 * of which list you pass rather than of an exclusion somebody maintains.
 */
export function deriveFulfilmentModeRequirements(
  facts: MerchantActivationFacts,
): readonly MerchantActivationRequirementResult[] {
  return FULFILMENT_MODE_REQUIREMENTS.map((requirement) => ({
    requirement,
    outcome: DERIVATIONS[requirement](facts),
  }));
}

/**
 * Which of a result set actually WITHHOLD, honouring the one advisory
 * requirement.
 *
 * The advisory list is a parameter rather than a module constant so the caller's
 * configuration is visible at the call site — a hidden global deciding whether a
 * gate bites is exactly the shape of a check that cannot fail.
 */
export function blockingRequirements(
  results: readonly MerchantActivationRequirementResult[],
  advisory: readonly MerchantActivationRequirementKey[],
): readonly MerchantActivationRequirementKey[] {
  return results
    .filter((result) => result.outcome.state !== 'satisfied' && !advisory.includes(result.requirement))
    .map((result) => result.requirement);
}

/** Whether any blocking result is `unevaluable` — the `ineligible` discriminant. */
export function hasUnevaluable(
  results: readonly MerchantActivationRequirementResult[],
  advisory: readonly MerchantActivationRequirementKey[],
): boolean {
  return results.some(
    (result) => result.outcome.state === 'unevaluable' && !advisory.includes(result.requirement),
  );
}

/** Narrow a mixed result list to the native registry's members. */
export function nativeKeys(
  keys: readonly MerchantActivationRequirementKey[],
): readonly MerchantActivationRequirement[] {
  return keys.filter((key): key is MerchantActivationRequirement =>
    (MERCHANT_ACTIVATION_REQUIREMENTS as readonly string[]).includes(key),
  );
}

/** Narrow a mixed result list to the guest registry's members. */
export function guestKeys(
  keys: readonly MerchantActivationRequirementKey[],
): readonly GuestActivationRequirement[] {
  return keys.filter((key): key is GuestActivationRequirement =>
    (GUEST_ACTIVATION_REQUIREMENTS as readonly string[]).includes(key),
  );
}

/** Narrow a mixed result list to the fulfilment-mode registry's members. */
export function fulfilmentKeys(
  keys: readonly MerchantActivationRequirementKey[],
): readonly FulfilmentModeRequirement[] {
  return keys.filter((key): key is FulfilmentModeRequirement =>
    (FULFILMENT_MODE_REQUIREMENTS as readonly string[]).includes(key),
  );
}
