/**
 * Merchant activation readiness and native-checkout onboarding — issue #85.
 *
 * Guiding a verified merchant from a linked native store to a safely activated
 * Mercaria checkout, and — separately, because they are separate questions —
 * to a guest checkout it can actually fulfil, support and refund.
 *
 * ## The verdict is DERIVED and never stored, and this is the #57 divergence
 *
 * The house rule is one stored verdict per fact: `provider_accounts`'
 * `onboarding_state` is the model, and it is stored because ADR 0001 D9's
 * conjunction is evaluated over the row being verdicted. Activation readiness
 * has no such row. Its inputs sit on `merchants`, `native_store_links`,
 * `merchant_claims`, `connections`, `sync_runs`, `feed_configurations`,
 * `listings`, `provider_accounts`, `fee_schedules`, `orders` and this domain's
 * own three tables — eleven tables in eight domains, none of which this one
 * owns. A stored verdict would be a twelfth representation, and it would go
 * stale at exactly the moment that matters: the instant Stripe restricts a
 * seller, a jury restricts a catalogue, or a connector stops delivering.
 *
 * So this follows `deriveNativeCheckoutEligibility` (#57), `getRetailEligibility`
 * (#121) and `deriveChannelReadiness` (#87), for the same reason and stated in
 * the same place. What IS stored is what somebody DECIDED — a policy accepted,
 * a checkout paused, an operator's hold — plus the append-only record of what
 * the derivation was OBSERVED to say, which is a recording and never an
 * authority (`payment_discrepancies`' relationship to a payment).
 *
 * ## Requirements come in two registries because guest is not a stronger native
 *
 * #85 states it twice ("Readiness must distinguish general native checkout from
 * guest checkout", "Guest readiness cannot be inferred simply from Stripe
 * account readiness"), and the two lists genuinely ask different things: one is
 * about whether this seller can sell at all, the other about whether a buyer
 * with no Oxy account can be contacted, refunded and supported afterwards. The
 * guest registry's FIRST member is the native conjunction, so guest is strictly
 * narrower — but it is narrower by naming its own facts, not by adding a
 * threshold to somebody else's.
 *
 * ## Three outcomes, and two of them block
 *
 * `satisfied | unsatisfied | unevaluable`, the #112 vocabulary. `unevaluable`
 * is never a soft yes: it means Mercaria cannot answer the question in this
 * deployment at all (no transactional transport exists, #93 publishes no pickup
 * state), which routes differently from a merchant who has simply not finished
 * — one is a build to do, the other is a form to fill in — and BOTH withhold
 * the capability.
 *
 * ## The discriminants are STRINGS
 *
 * The backend compiles with `strict: false`, so without `strictNullChecks`
 * TypeScript does not narrow a union on the truthiness of a boolean-literal
 * discriminant (#68's finding, #110's second sighting). Every union here is
 * discriminated on a string.
 */

import type { CurrencyCode } from './money';

/* -------------------------------------------------------------------------- */
/*  Requirements                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What a store must satisfy before Mercaria will let anybody buy from it
 * natively — #85's "Activation state" list, minus the guest half.
 *
 * Ordered by how early in onboarding each one bites, which is also the order
 * the dashboard walks them in. A closed tuple because every consumer branches
 * on it: the capability derivation, the onboarding step map, the checkout gate
 * and the operator trace all name members, and a sentence cannot be branched on.
 */
export const MERCHANT_ACTIVATION_REQUIREMENTS = [
  /** #85 state 1. `merchants.claim_state` is ADR 0002 D9's one stored verdict. */
  'merchant_claim_verified',
  /** #85 state 2. A live `native_store_links` row joins the merchant to this store. */
  'native_store_link_valid',
  /** #85 state 3, the profile half: name, description and a brand identity. */
  'store_profile_complete',
  /** #85 state 3, the public-support half — required before a native order exists. */
  'support_contact_complete',
  /** #85 state 4. A connector, a feed or the native catalogue is supplying stock. */
  'catalog_source_connected',
  /** #85 state 5. The connected channels are actually landing their catalogue. */
  'catalog_sync_healthy',
  /** #85 state 4, the other half: something a buyer could put in a cart. */
  'publishable_listing_exists',
  /** #85 state 6. Return window, refund and privacy policies configured. */
  'store_policies_configured',
  /** #85 state 7. #46's stored `onboarding_state`, READ and never re-derived. */
  'payment_provider_ready',
  /** #85 state 8. The store's settlement currency is one this deployment charges in. */
  'market_currency_supported',
  /** #85 state 9, and #88's deferred acceptance gate. */
  'fee_schedule_accepted',
  /** #85 state 10. The returns and fulfilment responsibilities policy, accepted. */
  'returns_fulfilment_acknowledged',
  /** #85 state 11. No moderation restriction and no operator safety hold. */
  'no_platform_hold',
  /** #85 state 13. The merchant has not paused its own native checkout. */
  'native_checkout_not_paused',
  /** #85 state 12. A completed order on the rail this deployment is configured for. */
  'test_order_completed',
] as const;

/** One of {@link MERCHANT_ACTIVATION_REQUIREMENTS}. */
export type MerchantActivationRequirement = (typeof MERCHANT_ACTIVATION_REQUIREMENTS)[number];

/**
 * What a store must ADDITIONALLY satisfy before a buyer with no Oxy account may
 * check out — #85's "Guest checkout readiness" list.
 *
 * Disjoint from {@link MERCHANT_ACTIVATION_REQUIREMENTS} (a test asserts it), so
 * `MerchantActivationRequirementKey` below is a genuine discriminated key rather
 * than a union with an ambiguous member.
 */
export const GUEST_ACTIVATION_REQUIREMENTS = [
  /** #85 guest 1. The whole native conjunction, as one conjunct. */
  'native_checkout_ready',
  /** #85 guest 2, the deployment half: guest commerce and guest carts are on. */
  'guest_commerce_enabled',
  /** #85 guest 2, the market half: the deployment charges guests in this currency. */
  'guest_market_currency_allowed',
  /** #85 guest 3. At least one guest-eligible payment surface is configured. */
  'guest_payment_method_available',
  /** #85 guest 4. #105's inline contact and destination path is available. */
  'guest_inline_destination_supported',
  /** #85 guest 5. At least one fulfilment method is deterministically priceable. */
  'guest_fulfilment_deterministic',
  /** #85 guest 6. A merchant can read the order without an Oxy buyer profile. */
  'guest_merchant_order_access',
  /** #85 guest 7. #108's portal and #110's request path are mounted. */
  'guest_support_and_returns_available',
  /** #85 guest 8. A transactional transport that can actually reach the buyer. */
  'guest_transactional_contact_operational',
  /** #85 guest 9. The guest data and contact-handling policy, accepted. */
  'guest_data_responsibilities_accepted',
  /** #85 guest 10. Refund and cancellation workflows reachable for this seller. */
  'guest_refund_operations_available',
  /** #85 guest 11. Somebody on the store holds the buyer-data permission. */
  'guest_buyer_data_permissions_scoped',
  /** #85 guest 12. No operator, moderation or rollout restriction on guest orders. */
  'guest_no_active_restriction',
  /** #85 guest 13. The merchant is inside the enabled rollout cohort (#111). */
  'guest_cohort_enabled',
  /** #85 state 14. The merchant has not paused its own guest checkout. */
  'guest_checkout_not_paused',
] as const;

/** One of {@link GUEST_ACTIVATION_REQUIREMENTS}. */
export type GuestActivationRequirement = (typeof GUEST_ACTIVATION_REQUIREMENTS)[number];

/**
 * What a store must satisfy before ONE fulfilment mode may be used — the third
 * registry, and the one that withholds a CAPABILITY without withholding
 * checkout.
 *
 * It exists because the other two cannot express this shape. A member of either
 * of them enters its conjunction, so a pickup requirement in the native
 * registry would make every store on a deployment with `STORE_PICKUP_ENABLED`
 * off (the default) read `nativeCheckout: disabled` — a far worse answer than
 * the one it was added to fix. A mode is not a precondition of selling; it is a
 * precondition of selling THAT WAY, and `shipping_checkout` / `pickup_checkout`
 * are exactly the two capabilities that say so.
 *
 * So these are DERIVED and REPORTED like every other requirement, they name
 * their reason like every other requirement, and they are excluded from both
 * conjunctions by CONSTRUCTION rather than by a hand-maintained exclusion list:
 * `activation.service.ts` composes the blocking sets per registry, and this
 * tuple is a registry.
 */
export const FULFILMENT_MODE_REQUIREMENTS = [
  /** This deployment can price at least one method that puts goods in transit. */
  'shipping_fulfilment_available',
  /** This deployment offers collection AND this store published somewhere to collect from. */
  'pickup_fulfilment_available',
] as const;

/** One of {@link FULFILMENT_MODE_REQUIREMENTS}. */
export type FulfilmentModeRequirement = (typeof FULFILMENT_MODE_REQUIREMENTS)[number];

/** Any registry's key. The three tuples are disjoint, asserted by a test. */
export type MerchantActivationRequirementKey =
  | MerchantActivationRequirement
  | GuestActivationRequirement
  | FulfilmentModeRequirement;

/**
 * Every registry as one tuple, in native-then-guest-then-mode order.
 *
 * It exists for the two consumers that need the SET rather than any one half:
 * the `merchant_activation_capability_events.unmet` element CHECK (so an audit
 * row can hold a requirement key and nothing else), and the disjointness test.
 * Derived by concatenation rather than written out, so a member added to any
 * registry cannot be forgotten here.
 */
export const MERCHANT_ACTIVATION_REQUIREMENT_KEYS = [
  ...MERCHANT_ACTIVATION_REQUIREMENTS,
  ...GUEST_ACTIVATION_REQUIREMENTS,
  ...FULFILMENT_MODE_REQUIREMENTS,
] as const;

/**
 * Why a requirement is not satisfied, as a closed set.
 *
 * A code rather than a sentence because #85 acceptance 6 asks for an
 * owner-facing explanation AND an operator trace: the explanation is copy the
 * client renders from the code, and the trace is the code itself. A sentence
 * would make the two the same string and neither translatable nor branchable.
 */
export const MERCHANT_ACTIVATION_BLOCK_REASONS = [
  // Identity and linkage.
  'merchant_not_claimed',
  'merchant_claim_not_verified',
  'no_linked_merchant',
  // Profile and policy.
  'store_profile_incomplete',
  'support_contact_missing',
  'store_policies_incomplete',
  'policy_not_accepted',
  'policy_version_superseded',
  // Catalogue.
  'no_connected_channel',
  'no_native_checkout_channel',
  'no_successful_sync',
  'catalog_sync_degraded',
  'no_publishable_listing',
  // Money.
  'payments_not_ready',
  'payment_rail_disabled',
  'currency_not_supported',
  'fee_schedule_not_accepted',
  'fee_schedule_version_superseded',
  // Operational state.
  'platform_hold',
  'merchant_paused_checkout',
  'merchant_paused_guest_checkout',
  'no_completed_test_order',
  // Guest-specific.
  /**
   * #85 guest 1: the native conjunction itself failed.
   *
   * A reason of its own rather than repeating the native reasons inside the
   * guest list — a merchant reading "guest checkout is off because your Stripe
   * account is restricted" would go and fix Stripe and find guest checkout still
   * off, because the native half has its own list they never looked at.
   */
  'native_checkout_not_ready',
  'guest_commerce_disabled',
  'guest_cart_disabled',
  'guest_inline_destination_disabled',
  'guest_market_blocked',
  'guest_currency_not_chargeable',
  'guest_no_payment_surface',
  'guest_seller_blocked_by_operator',
  'guest_fulfilment_method_blocked',
  'guest_buyer_data_permission_unassigned',
  // Fulfilment modes. Each names ONE mode, because the two capabilities that
  // read them name one mode each — a shared reason would be a shared answer,
  // which is the defect these replaced.
  'no_priceable_shipping_method',
  'store_pickup_disabled',
  'no_collectable_pickup_location',
  // Capabilities this deployment does not have at all — every one is a NAMED
  // seam whose owner is recorded beside it, never a merchant's fault.
  'transactional_transport_unconfigured',
  /**
   * #110's buyer-request mount is switched off in this deployment.
   *
   * Its own code, and that is the point. It replaced `pickup_not_supported`,
   * which described a DIFFERENT condition entirely (#93 had published no
   * collection state) and reached the merchant's own dashboard as the stated
   * cause of a guest checkout being ineligible. A merchant told the wrong cause
   * of their own problem is a wrong answer, not a privacy measure: the
   * one-code-for-many-dimensions rule (`guest_rollout_blocked`,
   * `retail_line_ineligible`, `p2p_seller_excluded`) exists for BUYER-facing
   * refusals where a client varying one input at a time reads out somebody
   * else's state, and this reader is the store owner asking about their own
   * store behind `store:manage`.
   */
  'guest_support_requests_disabled',
  'p2p_activation_unavailable',
] as const;

/** One of {@link MERCHANT_ACTIVATION_BLOCK_REASONS}. */
export type MerchantActivationBlockReason = (typeof MERCHANT_ACTIVATION_BLOCK_REASONS)[number];

/**
 * Who would have to supply an input this deployment cannot answer.
 *
 * `unevaluable` is only honest if it says whose gap it is — #112's device. A
 * reason with no owner is indistinguishable from a bug in this domain.
 */
export const MERCHANT_ACTIVATION_INPUT_OWNERS = ['#93', '#108', '#110', '#111', 'deployment'] as const;

/** One of {@link MERCHANT_ACTIVATION_INPUT_OWNERS}. */
export type MerchantActivationInputOwner = (typeof MERCHANT_ACTIVATION_INPUT_OWNERS)[number];

/**
 * One requirement's verdict.
 *
 * `unsatisfied` and `unevaluable` BOTH withhold the capability, and they are
 * kept apart because they route to different places: the first to the merchant's
 * own dashboard with a remedy, the second to a report of what Mercaria cannot
 * offer here. Collapsing them tells a merchant to fix something nobody built.
 */
export type MerchantActivationOutcome =
  | { readonly state: 'satisfied' }
  | { readonly state: 'unsatisfied'; readonly reason: MerchantActivationBlockReason }
  | {
      readonly state: 'unevaluable';
      readonly reason: MerchantActivationBlockReason;
      readonly owner: MerchantActivationInputOwner;
    };

/** One requirement and what it currently says. */
export interface MerchantActivationRequirementResult {
  readonly requirement: MerchantActivationRequirementKey;
  readonly outcome: MerchantActivationOutcome;
}

/* -------------------------------------------------------------------------- */
/*  Capabilities                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What a store may actually do — #85's capability model, "server-derived
 * capabilities rather than one broad `checkoutEnabled` boolean".
 *
 * A closed tuple, and it is the vocabulary every consumer branches on: the
 * checkout gate, the storefront's `Buy on Mercaria` / `Continue as guest`
 * affordances, the dashboard and the audit trail.
 */
export const MERCHANT_CAPABILITIES = [
  'authenticated_native_checkout',
  'guest_native_checkout',
  'shipping_checkout',
  'pickup_checkout',
  'presentment_currency_selection',
  'card_payment_rail',
  'refund_and_return_operations',
  'transactional_guest_communication',
  'p2p_seller_checkout',
  'guest_p2p_checkout',
] as const;

/** One of {@link MERCHANT_CAPABILITIES}. */
export type MerchantCapability = (typeof MERCHANT_CAPABILITIES)[number];

/**
 * A capability's state.
 *
 * THREE values, and `not_applicable` is the one that earns its place: a STORE
 * is not a P2P seller, so `p2p_seller_checkout` is neither granted nor withheld
 * from it — reporting `withheld` would put a permanent unfixable red mark on
 * every merchant dashboard, and reporting `granted` would be a lie.
 */
export const MERCHANT_CAPABILITY_STATES = ['granted', 'withheld', 'not_applicable'] as const;

/** One of {@link MERCHANT_CAPABILITY_STATES}. */
export type MerchantCapabilityState = (typeof MERCHANT_CAPABILITY_STATES)[number];

/**
 * One capability, its state and — when withheld — exactly which requirements
 * withheld it.
 *
 * #85 capability rule 6: "Capability state and reason codes are auditable and
 * safe to expose to the merchant." The unmet list IS the reason code set, and
 * every member is a requirement the merchant can look up in the same payload.
 */
export interface MerchantCapabilityResult {
  readonly capability: MerchantCapability;
  readonly state: MerchantCapabilityState;
  /** Empty unless `withheld`. */
  readonly unmet: readonly MerchantActivationRequirementKey[];
}

/* -------------------------------------------------------------------------- */
/*  Checkout states                                                            */
/* -------------------------------------------------------------------------- */

/** #85 state 13: native checkout is enabled, paused or disabled. */
export const MERCHANT_CHECKOUT_STATES = ['enabled', 'paused', 'disabled'] as const;

/** One of {@link MERCHANT_CHECKOUT_STATES}. */
export type MerchantCheckoutState = (typeof MERCHANT_CHECKOUT_STATES)[number];

/**
 * #85 state 14: guest checkout is enabled, paused, disabled or INELIGIBLE.
 *
 * The fourth value is the whole reason this is a separate tuple. `disabled`
 * means a requirement is unsatisfied and the merchant can act; `ineligible`
 * means a requirement is UNEVALUABLE — this deployment cannot offer guest
 * checkout to anybody, because something nobody has built is missing. A single
 * `disabled` would send every merchant to a screen with no remedy on it.
 */
export const GUEST_CHECKOUT_STATES = ['enabled', 'paused', 'disabled', 'ineligible'] as const;

/** One of {@link GUEST_CHECKOUT_STATES}. */
export type GuestCheckoutState = (typeof GUEST_CHECKOUT_STATES)[number];

/** What a merchant may set on its own checkout: on, or paused. */
export const MERCHANT_CHECKOUT_INTENTS = ['enabled', 'paused'] as const;

/** One of {@link MERCHANT_CHECKOUT_INTENTS}. */
export type MerchantCheckoutIntent = (typeof MERCHANT_CHECKOUT_INTENTS)[number];

/* -------------------------------------------------------------------------- */
/*  Policies                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The policies a seller accepts as part of activation.
 *
 * Deliberately NOT the marketplace fee schedule, which is #88's own versioned
 * table with its own acceptance row and its own operator publication path. What
 * these three carry is what #88 did not: the RESPONSIBILITIES a seller takes on,
 * which are prose in a shipped terms document rather than numbers somebody
 * publishes.
 */
export const MERCHANT_ACTIVATION_POLICY_KEYS = [
  /** #85 state 10 — returns, cancellations and fulfilment responsibilities. */
  'returns_and_fulfilment_responsibilities',
  /** #85 guest 9 — handling a guest's contact details and destination. */
  'guest_data_and_contact_handling',
  /**
   * #112's one `unevaluable` criterion — return, cancellation and dispute
   * policy for an INDIVIDUAL seller. Its owner is an Oxy account rather than a
   * store, which is why every acceptance row is polymorphic.
   */
  'p2p_returns_cancellation_dispute',
] as const;

/** One of {@link MERCHANT_ACTIVATION_POLICY_KEYS}. */
export type MerchantActivationPolicyKey = (typeof MERCHANT_ACTIVATION_POLICY_KEYS)[number];

/**
 * One policy's currently published version.
 *
 * A CODE CONSTANT and not a table, the #126 consumer-rights-terms decision: a
 * version pointer is only as durable as the code that can still resolve it, and
 * a table would let somebody publish a responsibilities version no shipped
 * terms document contains — which would then be snapshotted onto acceptance
 * rows as what those sellers agreed to.
 */
export interface MerchantActivationPolicy {
  readonly key: MerchantActivationPolicyKey;
  /** The version an acceptance is recorded against. Bump it and everyone re-accepts. */
  readonly version: string;
  /**
   * Whose acceptance this policy asks for — `provider_accounts`' owner
   * vocabulary, so `user` means an individual Oxy seller.
   */
  readonly appliesTo: 'store' | 'user';
  /** The requirement this policy satisfies when accepted. */
  readonly satisfies: MerchantActivationRequirementKey | 'guest_p2p_seller_policies';
}

/**
 * The published policies. Editing a `version` here is what schedules a
 * re-acceptance; editing the prose without bumping it is what must not happen,
 * and is why the version lives beside the key rather than in a database row
 * somebody could move independently of the document.
 */
export const MERCHANT_ACTIVATION_POLICIES: Readonly<
  Record<MerchantActivationPolicyKey, MerchantActivationPolicy>
> = {
  returns_and_fulfilment_responsibilities: {
    key: 'returns_and_fulfilment_responsibilities',
    version: '2026-08-14',
    appliesTo: 'store',
    satisfies: 'returns_fulfilment_acknowledged',
  },
  guest_data_and_contact_handling: {
    key: 'guest_data_and_contact_handling',
    version: '2026-08-14',
    appliesTo: 'store',
    satisfies: 'guest_data_responsibilities_accepted',
  },
  p2p_returns_cancellation_dispute: {
    key: 'p2p_returns_cancellation_dispute',
    version: '2026-08-14',
    appliesTo: 'user',
    satisfies: 'guest_p2p_seller_policies',
  },
};

/** One recorded acceptance, as a merchant surface reports it. */
export interface MerchantActivationPolicyAcceptance {
  readonly policyKey: MerchantActivationPolicyKey;
  readonly policyVersion: string;
  readonly acceptedByOxyUserId: string;
  readonly acceptedAt: string;
  /** False when a newer version has since been published. */
  readonly current: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Onboarding                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * #85's fourteen dashboard steps, in order.
 *
 * They are DERIVED from the requirements rather than stored, which is what
 * makes "every step can be resumed on another client through the Oxy account"
 * true without a per-client cursor: there is no progress record to be out of
 * date, because progress IS the authoritative state. It is also why acceptance
 * 5 ("resumes idempotently and does not create duplicate stores, connections or
 * provider accounts") needs no idempotency mechanism here — reading creates
 * nothing.
 */
export const MERCHANT_ONBOARDING_STEPS = [
  'review_presence_and_demand',
  'confirm_native_store',
  'connect_catalog',
  'review_imported_matches',
  'configure_currency_and_markets',
  'start_payment_onboarding',
  'review_fee_schedule',
  'capture_store_policies',
  'configure_support_contact',
  'review_checkout_capabilities',
  'confirm_guest_contact_handling',
  'configure_fulfilment_methods',
  'run_readiness_checks',
  'enable_capabilities',
] as const;

/** One of {@link MERCHANT_ONBOARDING_STEPS}. */
export type MerchantOnboardingStep = (typeof MERCHANT_ONBOARDING_STEPS)[number];

/**
 * A step's state.
 *
 * `blocked` is separate from `incomplete` because they lead somewhere
 * different: an incomplete step is one the merchant can do NOW, a blocked one
 * is waiting on something outside their control. A wizard that renders them the
 * same makes the merchant press a button that cannot work.
 */
export const MERCHANT_ONBOARDING_STEP_STATES = [
  'complete',
  'incomplete',
  'blocked',
  'not_applicable',
] as const;

/** One of {@link MERCHANT_ONBOARDING_STEP_STATES}. */
export type MerchantOnboardingStepState = (typeof MERCHANT_ONBOARDING_STEP_STATES)[number];

/** One onboarding step and the requirements it covers. */
export interface MerchantOnboardingStepResult {
  readonly step: MerchantOnboardingStep;
  readonly state: MerchantOnboardingStepState;
  /** Every requirement this step is responsible for, satisfied or not. */
  readonly requirements: readonly MerchantActivationRequirementKey[];
  /** The subset currently not satisfied. Empty when `complete`. */
  readonly unmet: readonly MerchantActivationRequirementKey[];
}

/* -------------------------------------------------------------------------- */
/*  What this deployment supports                                              */
/* -------------------------------------------------------------------------- */

/**
 * #85 capability 5, 6 and state 15 — the supported SETS, kept apart from the
 * boolean capabilities because they are data rather than verdicts.
 *
 * Every field is what the SERVER permits. #85 capability rule 2 ("Client UI
 * cannot override them") is held by there being no write path that reaches any
 * of these: they are composed from deployment configuration and the store's own
 * settlement currency, and the merchant surface serves them read-only.
 */
export interface MerchantActivationSupport {
  /** Presentment currencies this deployment can charge in. */
  readonly presentmentCurrencies: readonly CurrencyCode[];
  /** Payment surfaces the card rail may offer. Empty when the rail is off. */
  readonly paymentMethods: readonly string[];
  /**
   * Destination countries this deployment serves. EMPTY means unrestricted,
   * which is `CHECKOUT_DESTINATION_COUNTRIES`' own meaning — not "none".
   */
  readonly markets: readonly string[];
  /** Fulfilment methods a buyer may pick. */
  readonly fulfilmentMethods: readonly string[];
  /** The same four questions asked about a signed-out buyer (#85 state 15). */
  readonly guest: {
    readonly presentmentCurrencies: readonly CurrencyCode[];
    readonly paymentMethods: readonly string[];
    readonly markets: readonly string[];
    readonly fulfilmentMethods: readonly string[];
  };
}

/* -------------------------------------------------------------------------- */
/*  The projection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One store's whole activation state, as the dashboard and the operator trace
 * both read it.
 *
 * Every field is NAMED explicitly (the `provider_accounts` #46 precedent). This
 * projection carries no buyer, no order, no contact and no provider object id —
 * #85 security 6 ("secrets and verification evidence never enter onboarding
 * analytics") is held by there being no column of that shape to fill.
 */
export interface MerchantActivationState {
  readonly storeId: string;
  readonly nativeCheckout: {
    readonly state: MerchantCheckoutState;
    readonly requirements: readonly MerchantActivationRequirementResult[];
    readonly unmet: readonly MerchantActivationRequirement[];
  };
  readonly guestCheckout: {
    readonly state: GuestCheckoutState;
    readonly requirements: readonly MerchantActivationRequirementResult[];
    readonly unmet: readonly GuestActivationRequirement[];
  };
  /**
   * The per-mode registry, which has requirements and NO checkout state.
   *
   * There is deliberately no `state` beside these. A mode does not decide
   * whether this store may sell — it decides which of `shipping_checkout` and
   * `pickup_checkout` is granted — and a third checkout word here would be a
   * second answer to a question `nativeCheckout.state` already answers.
   */
  readonly fulfilment: {
    readonly requirements: readonly MerchantActivationRequirementResult[];
    readonly unmet: readonly FulfilmentModeRequirement[];
  };
  readonly capabilities: readonly MerchantCapabilityResult[];
  readonly support: MerchantActivationSupport;
  readonly onboarding: readonly MerchantOnboardingStepResult[];
  readonly policies: readonly MerchantActivationPolicyAcceptance[];
  /** What the merchant itself asked for, before the derivation had its say. */
  readonly intents: {
    readonly nativeCheckout: MerchantCheckoutIntent;
    readonly guestCheckout: MerchantCheckoutIntent;
  };
  /**
   * Whether an operator has held this store's checkout.
   *
   * The REASON is deliberately not here: #85 permissions rule 11 says a
   * merchant cannot bypass a platform safety pause from the dashboard, and a
   * hold whose stated reason is a moderation finding would be a way to read one.
   * The operator trace carries it; the merchant is told a hold exists and who
   * to contact.
   */
  readonly platformHold: boolean;
}

/* -------------------------------------------------------------------------- */
/*  The audit trail                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Who caused a capability to change — #85 security 10 ("All guest-capability
 * changes are audited with actor, reason and prior state").
 *
 * `system` exists because most transitions have no actor at all: a Stripe
 * restriction, a connector failure, a jury restricting a catalogue. Recording
 * one of those against the operator whose sweep noticed it would be a false
 * attribution, and recording it against nobody would leave the column nullable
 * for the two cases that DO have an actor.
 */
export const MERCHANT_ACTIVATION_ACTOR_KINDS = ['merchant', 'operator', 'system'] as const;

/** One of {@link MERCHANT_ACTIVATION_ACTOR_KINDS}. */
export type MerchantActivationActorKind = (typeof MERCHANT_ACTIVATION_ACTOR_KINDS)[number];

/** What prompted an observation. */
export const MERCHANT_ACTIVATION_CAUSES = [
  'merchant_setting_changed',
  'policy_accepted',
  'operator_hold_applied',
  'operator_hold_released',
  'operator_reevaluation',
  'scheduled_observation',
] as const;

/** One of {@link MERCHANT_ACTIVATION_CAUSES}. */
export type MerchantActivationCause = (typeof MERCHANT_ACTIVATION_CAUSES)[number];

/** One recorded capability transition, as the operator trace reports it. */
export interface MerchantActivationTransition {
  readonly storeId: string;
  readonly capability: MerchantCapability;
  readonly previousState: MerchantCapabilityState | null;
  readonly nextState: MerchantCapabilityState;
  readonly unmet: readonly MerchantActivationRequirementKey[];
  readonly actorKind: MerchantActivationActorKind;
  readonly actorOxyUserId: string | null;
  readonly cause: MerchantActivationCause;
  readonly observedAt: string;
}

/**
 * The operator's view of one store's activation.
 *
 * A trace opens from a STORE ID and nothing else — no buyer, no order, no
 * email. "Which merchants has this person activated" is not a question this
 * surface can be asked, because no function here takes an account id.
 */
export interface MerchantActivationTrace {
  readonly state: MerchantActivationState;
  readonly transitions: readonly MerchantActivationTransition[];
  /**
   * The hold's stated reason, operator-only. Absent when there is no hold.
   * See {@link MerchantActivationState.platformHold} for why it is not there.
   */
  readonly platformHoldReason?: string;
  readonly platformHeldByOxyUserId?: string;
  readonly platformHeldAt?: string;
}
