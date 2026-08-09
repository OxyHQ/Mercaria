/**
 * Live supplier preflight — stock, shipping, quote and reservation (#122,
 * ADR 0004 D4 step 1 / D5 / D9.3).
 *
 * Immediately before Mercaria creates or confirms a retail payment it asks the
 * supplier an authoritative, destination-aware question: can this exact item
 * still be procured, what does it cost, how can it ship, and for how long is
 * that answer good? A catalogue feed observation is not checkout authority
 * (#122 acceptance 1), and this file is where that stops being a sentence.
 *
 * ## A capability the adapter did not declare has no representable success
 *
 * {@link SUPPLIER_ADAPTER_CAPABILITIES} is the twelve-member contract every
 * supplier adapter declares. {@link SUPPLIER_EMULATED_COMMITMENTS} is a
 * DISJOINT union naming the six things this domain must never manufacture on a
 * supplier's behalf — the `RetailForbiddenComponentKind` device (#120) applied
 * to commitments rather than to money. It stores nothing: it exists so a
 * refusal can name the exact emulation that was attempted.
 *
 * The load-bearing instance is the reservation. {@link SupplierReservationOutcome}
 * is a discriminated union whose ONLY `reserved` branch carries a NON-optional
 * `providerReservationId` and `providerExpiresAt` — so a local record named
 * `reserved` that no supplier committed to is not "discouraged", it is
 * unrepresentable. A supplier without reservation support produces
 * `{ supported: false }`, which has no id, no expiry and no success to read.
 *
 * ## Unknown is never a quiet yes
 *
 * {@link SupplierAvailabilityState} carries `unknown` as a first-class value and
 * a provider TIMEOUT maps to it — never to `orderable` (#122 concurrency 7).
 * {@link SupplierPreflightStatus} then fails closed: only `complete` may pass
 * checkout, and a `complete` answer requires a confirmed identity, an orderable
 * availability and a KNOWN shipping cost. That is
 * `deriveRetailCompleteness`'s shape (#120), applied to supply.
 *
 * ## Absence is modelled as absence
 *
 * Every union in this file whose "we do not know" branch exists has NO property
 * for the value it does not know — {@link SupplierShippingQuote} has no `cost`
 * on its `unknown` branch, {@link SupplierGroupDeliveredTotal} has no `total`
 * when a group is unquoted. A caller that wants to read silence as zero has to
 * write the coercion out loud, which is `deriveOfferDelivery`'s rule (#57).
 *
 * ## What this file deliberately does NOT declare
 *
 * A field that could carry a buyer's contact details or street address into a
 * supplier request. {@link SupplierPreflightDestination} is the WHOLE
 * destination vocabulary a quote may be asked for, and it has no recipient
 * name, address line, phone or email member — #122's "do not send customer
 * contact or address fields that the supplier does not need for quoting",
 * expressed as a type rather than as a review comment.
 */

import type { CurrencyCode, Money } from './money';
import type { SupplierOrderCapability, SupplierOrderEmulatedCommitment } from './supplier-order';
import {
  SUPPLIER_ORDER_CAPABILITIES,
  SUPPLIER_ORDER_EMULATED_COMMITMENTS,
  SUPPLIER_ORDER_EMULATED_COMMITMENT_LABELS,
} from './supplier-order';

/**
 * The TWELVE PREFLIGHT capabilities a supplier adapter declares (#122 "Adapter
 * capability contract").
 *
 *  - `live_product_lookup` — confirm the exact product and variant now.
 *  - `live_stock_lookup` — a current availability answer, not a feed's.
 *  - `destination_shipping_quote` — a cost for THIS destination.
 *  - `order_draft_validation` — a dry-run that validates without creating.
 *  - `inventory_reservation` — an actual supplier-side hold.
 *  - `quote_expiry` — the supplier states how long its answer is good for.
 *  - `price_guarantee` — the quoted price is held, not merely observed.
 *  - `address_validation` — the destination is checked before submission.
 *  - `delivery_estimate` — handling, dispatch and delivery windows.
 *  - `tax_duty_estimate` — tax, duty and import responsibility.
 *  - `cancellation_before_submission` — a draft can be abandoned cleanly.
 *  - `update_notifications` — webhooks or polling for later changes.
 */
export type SupplierPreflightCapability =
  | 'live_product_lookup'
  | 'live_stock_lookup'
  | 'destination_shipping_quote'
  | 'order_draft_validation'
  | 'inventory_reservation'
  | 'quote_expiry'
  | 'price_guarantee'
  | 'address_validation'
  | 'delivery_estimate'
  | 'tax_duty_estimate'
  | 'cancellation_before_submission'
  | 'update_notifications';

/** {@link SupplierPreflightCapability} as the tuple #122's boundary reads. */
export const SUPPLIER_PREFLIGHT_CAPABILITIES: readonly SupplierPreflightCapability[] = [
  'live_product_lookup',
  'live_stock_lookup',
  'destination_shipping_quote',
  'order_draft_validation',
  'inventory_reservation',
  'quote_expiry',
  'price_guarantee',
  'address_validation',
  'delivery_estimate',
  'tax_duty_estimate',
  'cancellation_before_submission',
  'update_notifications',
];

/**
 * Everything a supplier adapter can declare — #122's twelve preflight
 * capabilities and #124's twelve order ones, in ONE union.
 *
 * One union rather than two parallel ones, because the boundary that removes an
 * undeclared claim (`applyDeclaredCapabilities`) and the CHECK that bounds a
 * stored `declared_capabilities` array both read this tuple. Two lists
 * describing one adapter can disagree, and the direction they disagree in is
 * always the permissive one — an adapter that "supports cancellation" according
 * to the list nobody enforces.
 *
 * The sub-tuples stay separately named and separately asserted, so each half
 * keeps its own floor and ceiling: a capability quietly removed would stop
 * being enforced, and one quietly added would be enforced by nothing.
 */
export type SupplierAdapterCapability = SupplierPreflightCapability | SupplierOrderCapability;

/** {@link SupplierAdapterCapability} as the tuple the columns and CHECKs read. */
export const SUPPLIER_ADAPTER_CAPABILITIES: readonly SupplierAdapterCapability[] = [
  ...SUPPLIER_PREFLIGHT_CAPABILITIES,
  ...SUPPLIER_ORDER_CAPABILITIES,
];

/**
 * The SIX commitments the orchestration may never manufacture (#122 "The
 * orchestration must not emulate a reservation…", generalized).
 *
 * A DIFFERENT union from {@link SupplierAdapterCapability} and disjoint from it
 * by construction, so no emulation can be typed as a capability, stored in a
 * declared-capability array (the column's CHECK reads the allowed tuple) or
 * required by a sourcing policy version. Nothing stores one: the union exists
 * so a refusal names the exact thing attempted rather than answering
 * "unsupported".
 */
export type SupplierPreflightEmulatedCommitment =
  | 'emulated_reservation'
  | 'assumed_stock_on_timeout'
  | 'inferred_price_guarantee'
  | 'synthetic_delivery_estimate'
  | 'assumed_zero_shipping'
  | 'assumed_zero_tax';

/** {@link SupplierPreflightEmulatedCommitment} as a tuple, for exhaustive iteration. */
export const SUPPLIER_PREFLIGHT_EMULATED_COMMITMENTS: readonly SupplierPreflightEmulatedCommitment[] =
  [
    'emulated_reservation',
    'assumed_stock_on_timeout',
    'inferred_price_guarantee',
    'synthetic_delivery_estimate',
    'assumed_zero_shipping',
    'assumed_zero_tax',
  ];

/**
 * Every commitment this system may never manufacture — #122's six about a QUOTE
 * being better than the supplier said, and #124's seven about an ORDER being
 * further along than the supplier said.
 *
 * One union, for the reason {@link SupplierAdapterCapability} is one: the
 * disjointness gate that keeps an emulation from being typed as a capability
 * has to see both halves, or the order side gets none of it.
 */
export type SupplierEmulatedCommitment =
  | SupplierPreflightEmulatedCommitment
  | SupplierOrderEmulatedCommitment;

/** {@link SupplierEmulatedCommitment} as a tuple, for exhaustive iteration. */
export const SUPPLIER_EMULATED_COMMITMENTS: readonly SupplierEmulatedCommitment[] = [
  ...SUPPLIER_PREFLIGHT_EMULATED_COMMITMENTS,
  ...SUPPLIER_ORDER_EMULATED_COMMITMENTS,
];

/**
 * Why each emulation can never be represented. Used verbatim in the refusal, so
 * the answer explains the rule instead of citing a schema.
 */
export const SUPPLIER_EMULATED_COMMITMENT_LABELS: Record<SupplierEmulatedCommitment, string> = {
  ...SUPPLIER_ORDER_EMULATED_COMMITMENT_LABELS,
  emulated_reservation:
    'a local record named `reserved` for a supplier that made no commitment — a reservation row requires the supplier\'s own reservation id and expiry, both NOT NULL',
  assumed_stock_on_timeout:
    'reading a provider timeout as availability — a timeout is `unknown`, which blocks checkout, and never `orderable`',
  inferred_price_guarantee:
    'inferring a price guarantee the supplier did not state — a guarantee is declared by the adapter and reported by the provider, never derived from a quote existing',
  synthetic_delivery_estimate:
    'inventing a delivery window from a catalogue average — an unknown window is absent, and an absent window blocks a complete answer',
  assumed_zero_shipping:
    'treating an unavailable shipping cost as free — an unknown shipping cost has no amount, so it cannot be summed into a delivered total',
  assumed_zero_tax:
    'treating an unquoted tax or duty as zero — an unquoted tax is absent, and a complete answer names its tax treatment',
};

/**
 * The five availability answers a preflight can carry (#122 response item 2).
 *
 * `unknown` is a genuine answer and a BLOCKING one — a provider timeout, an
 * unparseable response and an adapter that cannot look stock up all land here.
 * It is deliberately NOT collapsed into `unavailable`: they route differently
 * (one to a retry and an operator, one to a refusal the customer can act on),
 * which is the `RetailEligibilityVerdict` three-value rule (#121).
 *
 * This is a DIFFERENT vocabulary from `ProcurementAvailability` (#118) and must
 * stay one: that field records what a catalogue FEED last said about an offer,
 * this one records what the supplier answered about this exact request, and a
 * shared union would let a feed's `in_stock` be read as checkout authority —
 * the one thing #122 acceptance 1 exists to prevent.
 */
export type SupplierAvailabilityState =
  | 'orderable'
  | 'unavailable'
  | 'restricted'
  | 'backordered'
  | 'unknown';

/** {@link SupplierAvailabilityState} as the tuple the columns and CHECKs read. */
export const SUPPLIER_AVAILABILITY_STATES: readonly SupplierAvailabilityState[] = [
  'orderable',
  'unavailable',
  'restricted',
  'backordered',
  'unknown',
];

/**
 * The availability states that may appear on a `complete` preflight.
 *
 * Exactly one. Rendered into the quote table's CHECK from this constant, so
 * "unknown availability cannot pass checkout" (#122 response, final paragraph)
 * is a property of the database rather than of the service that writes it.
 */
export const SUPPLIER_COMPLETE_AVAILABILITY_STATES: readonly SupplierAvailabilityState[] = [
  'orderable',
];

/** Whether the exact product and variant were confirmed (#122 response item 1). */
export type SupplierIdentityConfirmation = 'confirmed' | 'mismatched' | 'ambiguous' | 'unknown';

/** {@link SupplierIdentityConfirmation} as the tuple the columns and CHECKs read. */
export const SUPPLIER_IDENTITY_CONFIRMATIONS: readonly SupplierIdentityConfirmation[] = [
  'confirmed',
  'mismatched',
  'ambiguous',
  'unknown',
];

/**
 * Whether a price or a stock answer is held or merely observed (#122 response
 * item 14).
 *
 * `guaranteed` is only ever written from a provider statement on an adapter
 * that declared the matching capability; there is no derivation that could
 * produce it (`inferred_price_guarantee`).
 */
export type SupplierQuoteGuarantee = 'guaranteed' | 'advisory';

/** {@link SupplierQuoteGuarantee} as the tuple the columns and CHECKs read. */
export const SUPPLIER_QUOTE_GUARANTEES: readonly SupplierQuoteGuarantee[] = [
  'guaranteed',
  'advisory',
];

/**
 * How the supplier prices shipping for a group (#122 mixed carts 2–3).
 *
 * `basket` means the supplier quotes ONE cost for the whole grouped order, and
 * summing per-item costs in that case is a different (wrong) number.
 * {@link SupplierShippingQuote} makes that structural: its `basket` branch has
 * no per-item member to sum.
 */
export type SupplierShippingBasis = 'basket' | 'per_item' | 'unknown';

/** {@link SupplierShippingBasis} as the tuple the columns and CHECKs read. */
export const SUPPLIER_SHIPPING_BASES: readonly SupplierShippingBasis[] = [
  'basket',
  'per_item',
  'unknown',
];

/** Who carries import duty and clearance, when the supplier states it. */
export type SupplierImportResponsibility = 'supplier' | 'mercaria' | 'customer' | 'unknown';

/** {@link SupplierImportResponsibility} as the tuple the columns and CHECKs read. */
export const SUPPLIER_IMPORT_RESPONSIBILITIES: readonly SupplierImportResponsibility[] = [
  'supplier',
  'mercaria',
  'customer',
  'unknown',
];

/** Why a destination is refused or constrained (#122 response item 11). */
export type SupplierDestinationRestriction =
  | 'not_served'
  | 'postal_code_excluded'
  | 'hazardous_goods_restricted'
  | 'oversize_restricted'
  | 'customs_documentation_required'
  | 'age_restricted'
  | 'carrier_unavailable'
  | 'import_licence_required';

/** {@link SupplierDestinationRestriction} as the tuple the columns and CHECKs read. */
export const SUPPLIER_DESTINATION_RESTRICTIONS: readonly SupplierDestinationRestriction[] = [
  'not_served',
  'postal_code_excluded',
  'hazardous_goods_restricted',
  'oversize_restricted',
  'customs_documentation_required',
  'age_restricted',
  'carrier_unavailable',
  'import_licence_required',
];

/**
 * The normalized provider reason codes (#122 response item 15).
 *
 * A CLOSED set, and that is the point: a provider's own reason string is
 * unbounded free text shaped by somebody else, and storing it wholesale is the
 * mechanism by which a customer name or an internal note reaches Mercaria's
 * tables. The adapter maps to one of these; the original never lands.
 */
export type SupplierProviderReasonCode =
  | 'out_of_stock'
  | 'discontinued'
  | 'sku_unknown'
  | 'sku_ambiguous'
  | 'quantity_exceeds_stock'
  | 'destination_unsupported'
  | 'service_unavailable'
  | 'currency_unsupported'
  | 'account_suspended'
  | 'credential_invalid'
  | 'rate_limited'
  | 'provider_internal_error'
  | 'validation_rejected'
  | 'other';

/** {@link SupplierProviderReasonCode} as the tuple the columns and CHECKs read. */
export const SUPPLIER_PROVIDER_REASON_CODES: readonly SupplierProviderReasonCode[] = [
  'out_of_stock',
  'discontinued',
  'sku_unknown',
  'sku_ambiguous',
  'quantity_exceeds_stock',
  'destination_unsupported',
  'service_unavailable',
  'currency_unsupported',
  'account_suspended',
  'credential_invalid',
  'rate_limited',
  'provider_internal_error',
  'validation_rejected',
  'other',
];

/**
 * Complete, partial or invalid (#122 response item 16).
 *
 *  - `complete` — every fact checkout needs is present and orderable.
 *  - `partial` — a usable answer with a named gap; it may be SHOWN and may
 *    never be charged against.
 *  - `invalid` — the provider's answer contradicts itself or the request; it
 *    carries an {@link SupplierPreflightExceptionKind} and goes to an operator.
 */
export type SupplierPreflightStatus = 'complete' | 'partial' | 'invalid';

/** {@link SupplierPreflightStatus} as the tuple the columns and CHECKs read. */
export const SUPPLIER_PREFLIGHT_STATUSES: readonly SupplierPreflightStatus[] = [
  'complete',
  'partial',
  'invalid',
];

/**
 * Why an answer is not `complete`. Sorted, deduped, and non-empty EXACTLY when
 * the status is not `complete` — a CHECK, both directions, so a blocked answer
 * cannot be stored claiming completeness and a complete one cannot be stored
 * with an unexplained block (the `retail_cost_quotes` device).
 */
export type SupplierPreflightBlockReason =
  | 'availability_unknown'
  | 'not_orderable'
  | 'identity_unconfirmed'
  | 'identity_mismatched'
  | 'identity_ambiguous'
  | 'unit_cost_unknown'
  | 'shipping_cost_unknown'
  | 'shipping_service_unavailable'
  | 'delivery_estimate_unknown'
  | 'tax_treatment_unknown'
  | 'quantity_above_maximum'
  | 'quantity_below_minimum'
  | 'pack_size_violated'
  | 'destination_restricted'
  | 'currency_unsupported'
  | 'capability_missing'
  | 'provider_timeout'
  | 'provider_rate_limited'
  | 'provider_error'
  | 'provider_unconfigured'
  | 'preflight_disabled'
  | 'supplier_suppressed'
  | 'market_suppressed'
  | 'account_not_active'
  | 'offer_ineligible'
  | 'sourcing_policy_missing'
  | 'provider_contract_violation';

/** {@link SupplierPreflightBlockReason} as the tuple the columns and CHECKs read. */
export const SUPPLIER_PREFLIGHT_BLOCK_REASONS: readonly SupplierPreflightBlockReason[] = [
  'availability_unknown',
  'not_orderable',
  'identity_unconfirmed',
  'identity_mismatched',
  'identity_ambiguous',
  'unit_cost_unknown',
  'shipping_cost_unknown',
  'shipping_service_unavailable',
  'delivery_estimate_unknown',
  'tax_treatment_unknown',
  'quantity_above_maximum',
  'quantity_below_minimum',
  'pack_size_violated',
  'destination_restricted',
  'currency_unsupported',
  'capability_missing',
  'provider_timeout',
  'provider_rate_limited',
  'provider_error',
  'provider_unconfigured',
  'preflight_disabled',
  'supplier_suppressed',
  'market_suppressed',
  'account_not_active',
  'offer_ineligible',
  'sourcing_policy_missing',
  'provider_contract_violation',
];

/**
 * An answer that contradicts itself or the request (#122 concurrency 8: "an
 * ambiguous provider response enters an exception state").
 *
 * Present EXACTLY when the status is `invalid` (a CHECK), because an exception
 * is a claim that a person has to look at, and a service bug must not be able
 * to file one silently as a `partial`.
 */
export type SupplierPreflightExceptionKind =
  | 'ambiguous_sku_identity'
  | 'ambiguous_availability'
  | 'currency_mismatch'
  | 'conflicting_shipping_basis'
  | 'quantity_contract_violation'
  | 'provider_contract_violation';

/** {@link SupplierPreflightExceptionKind} as the tuple the columns and CHECKs read. */
export const SUPPLIER_PREFLIGHT_EXCEPTION_KINDS: readonly SupplierPreflightExceptionKind[] = [
  'ambiguous_sku_identity',
  'ambiguous_availability',
  'currency_mismatch',
  'conflicting_shipping_basis',
  'quantity_contract_violation',
  'provider_contract_violation',
];

/** How a preflight attempt failed, when it did. */
export type SupplierPreflightFailureKind =
  | 'timeout'
  | 'rate_limited'
  | 'provider_error'
  | 'transport_error'
  | 'contract_violation'
  | 'authentication_failed'
  | 'capability_missing';

/** {@link SupplierPreflightFailureKind} as the tuple the columns and CHECKs read. */
export const SUPPLIER_PREFLIGHT_FAILURE_KINDS: readonly SupplierPreflightFailureKind[] = [
  'timeout',
  'rate_limited',
  'provider_error',
  'transport_error',
  'contract_violation',
  'authentication_failed',
  'capability_missing',
];

/**
 * A quote's usage, DERIVED from its timestamps against the clock — never a
 * column (#122 quote field 9).
 *
 * The issue lists "usage state" among the fields a durable quote carries, and
 * this domain satisfies it with a derivation for the reason every other Oxy
 * domain does: `consumed_at`, `released_at`, `superseded_by_quote_id` and
 * `expires_at` already state it completely, and a stored verdict beside them is
 * two representations of one fact whose disagreement lands in a checkout gate
 * (`retail_cost_quotes`' expiry rule, `onboarding_state`'s converse).
 */
export type SupplierQuoteUsage = 'open' | 'consumed' | 'released' | 'superseded' | 'expired';

/** {@link SupplierQuoteUsage} as a tuple, for exhaustive iteration. */
export const SUPPLIER_QUOTE_USAGES: readonly SupplierQuoteUsage[] = [
  'open',
  'consumed',
  'released',
  'superseded',
  'expired',
];

/** Why a quote was released without being consumed. */
export type SupplierQuoteReleaseReason =
  | 'checkout_abandoned'
  | 'checkout_failed'
  | 'quote_superseded'
  | 'expired'
  | 'operator_release'
  | 'sourcing_failover';

/** {@link SupplierQuoteReleaseReason} as the tuple the columns and CHECKs read. */
export const SUPPLIER_QUOTE_RELEASE_REASONS: readonly SupplierQuoteReleaseReason[] = [
  'checkout_abandoned',
  'checkout_failed',
  'quote_superseded',
  'expired',
  'operator_release',
  'sourcing_failover',
];

/** Why a fresh quote replaced an earlier one. */
export type SupplierQuoteSupersedeReason =
  | 're_preflight'
  | 'cost_changed'
  | 'stock_changed'
  | 'destination_changed'
  | 'quantity_changed'
  | 'quote_expired'
  | 'sourcing_failover';

/** {@link SupplierQuoteSupersedeReason} as the tuple the columns and CHECKs read. */
export const SUPPLIER_QUOTE_SUPERSEDE_REASONS: readonly SupplierQuoteSupersedeReason[] = [
  're_preflight',
  'cost_changed',
  'stock_changed',
  'destination_changed',
  'quantity_changed',
  'quote_expired',
  'sourcing_failover',
];

/** Why a supplier-side reservation was handed back. */
export type SupplierReservationReleaseReason =
  | 'checkout_abandoned'
  | 'checkout_failed'
  | 'quote_superseded'
  | 'expired'
  | 'operator_release'
  | 'sourcing_failover';

/** {@link SupplierReservationReleaseReason} as the tuple the columns and CHECKs read. */
export const SUPPLIER_RESERVATION_RELEASE_REASONS: readonly SupplierReservationReleaseReason[] = [
  'checkout_abandoned',
  'checkout_failed',
  'quote_superseded',
  'expired',
  'operator_release',
  'sourcing_failover',
];

/**
 * The EIGHT signals a versioned sourcing policy may rank on (#122 selection 2).
 *
 * The list is exhaustive on purpose: a policy version names an ORDERED subset
 * of these and nothing else, so "selection is reproducible" (#122 acceptance 7)
 * reduces to "the policy version plus the candidate facts determine the order",
 * with no unnamed tiebreaker in between.
 */
export type SupplierSourcingCriterion =
  | 'total_landed_cost'
  | 'destination_eligibility'
  | 'offer_freshness'
  | 'delivery_promise'
  | 'return_capability'
  | 'supplier_health'
  | 'concentration_headroom'
  | 'reservation_capability';

/** {@link SupplierSourcingCriterion} as the tuple the columns and CHECKs read. */
export const SUPPLIER_SOURCING_CRITERIA: readonly SupplierSourcingCriterion[] = [
  'total_landed_cost',
  'destination_eligibility',
  'offer_freshness',
  'delivery_promise',
  'return_capability',
  'supplier_health',
  'concentration_headroom',
  'reservation_capability',
];

/**
 * The EIGHT signals selection may NEVER read (#122 selection 3: "never select
 * from affiliate commission or organic ranking signals").
 *
 * Disjoint from {@link SupplierSourcingCriterion} by construction and pinned as
 * such by a test, so none of them can be configured on a policy version — the
 * `RETAIL_FORBIDDEN_COMPONENT_KINDS` device again. `SourcingCandidateFacts` has
 * no property that could hold one either, so the prohibition survives whoever
 * writes the next comparator.
 */
export type SupplierForbiddenSourcingSignal =
  | 'affiliate_commission'
  | 'referral_commission'
  | 'organic_ranking_score'
  | 'paid_placement'
  | 'sponsored_boost'
  | 'merchant_subscription_tier'
  | 'advertising_revenue'
  | 'marketplace_fee_yield';

/** {@link SupplierForbiddenSourcingSignal} as a tuple, for exhaustive iteration. */
export const SUPPLIER_FORBIDDEN_SOURCING_SIGNALS: readonly SupplierForbiddenSourcingSignal[] = [
  'affiliate_commission',
  'referral_commission',
  'organic_ranking_score',
  'paid_placement',
  'sponsored_boost',
  'merchant_subscription_tier',
  'advertising_revenue',
  'marketplace_fee_yield',
];

/** Why each forbidden signal can never decide which supplier fulfils an order. */
export const SUPPLIER_FORBIDDEN_SOURCING_SIGNAL_LABELS: Record<
  SupplierForbiddenSourcingSignal,
  string
> = {
  affiliate_commission:
    'affiliate commission — an affiliate offer creates no Mercaria order and never enters preflight at all',
  referral_commission:
    'referral commission — an acquisition expense of Mercaria, invisible to which supplier can actually deliver the goods',
  organic_ranking_score:
    'an organic ranking score — ranking answers what a buyer should see, not who Mercaria buys from',
  paid_placement: 'paid placement — a supplier cannot buy the right to fulfil a customer order',
  sponsored_boost: 'a sponsored boost — the same purchase, under a different name',
  merchant_subscription_tier:
    'a merchant subscription tier — plan economics cannot change who can deliver this item to this address',
  advertising_revenue:
    'advertising revenue — revenue Mercaria earns elsewhere is not a property of a supply route',
  marketplace_fee_yield:
    'marketplace fee yield — a `mercaria_retail` order pays no marketplace fee, so there is no yield to compare',
};

/** What one sourcing attempt did (#122 selection 7). */
export type SupplierSourcingOutcome = 'selected' | 'skipped' | 'failed' | 'refused' | 'superseded';

/** {@link SupplierSourcingOutcome} as the tuple the columns and CHECKs read. */
export const SUPPLIER_SOURCING_OUTCOMES: readonly SupplierSourcingOutcome[] = [
  'selected',
  'skipped',
  'failed',
  'refused',
  'superseded',
];

/** Why one sourcing attempt ended the way it did. */
export type SupplierSourcingReason =
  | 'selected_by_policy'
  | 'offer_ineligible'
  | 'supplier_suppressed'
  | 'market_suppressed'
  | 'account_not_active'
  | 'capability_missing'
  | 'concentration_limit'
  | 'attempt_limit_reached'
  | 'rate_limited'
  | 'provider_timeout'
  | 'provider_error'
  | 'answer_incomplete'
  | 'substitution_refused'
  | 'terms_already_locked'
  | 'no_active_policy'
  | 'no_candidate';

/** {@link SupplierSourcingReason} as the tuple the columns and CHECKs read. */
export const SUPPLIER_SOURCING_REASONS: readonly SupplierSourcingReason[] = [
  'selected_by_policy',
  'offer_ineligible',
  'supplier_suppressed',
  'market_suppressed',
  'account_not_active',
  'capability_missing',
  'concentration_limit',
  'attempt_limit_reached',
  'rate_limited',
  'provider_timeout',
  'provider_error',
  'answer_incomplete',
  'substitution_refused',
  'terms_already_locked',
  'no_active_policy',
  'no_candidate',
];

/**
 * Why a proposed failover source was refused (#122 selection 5–6).
 *
 * A failover supplier is permitted only BEFORE customer terms are locked, or
 * when the replacement preserves the exact product, the total price, the
 * delivery commitment and the returns capability. Each way that can fail has
 * its own member, so a refusal states which promise the replacement broke —
 * and `different_canonical_variant` / `different_supplier_sku` are what makes
 * "do not silently substitute another variant or a used condition" a comparison
 * of identities rather than a judgement call.
 */
export type SupplierSubstitutionRefusal =
  | 'different_canonical_variant'
  | 'different_supplier_sku'
  | 'different_quantity'
  | 'different_currency'
  | 'higher_total_price'
  | 'slower_delivery_commitment'
  | 'weaker_return_capability'
  | 'terms_already_locked';

/** {@link SupplierSubstitutionRefusal} as a tuple, for exhaustive iteration. */
export const SUPPLIER_SUBSTITUTION_REFUSALS: readonly SupplierSubstitutionRefusal[] = [
  'different_canonical_variant',
  'different_supplier_sku',
  'different_quantity',
  'different_currency',
  'higher_total_price',
  'slower_delivery_commitment',
  'weaker_return_capability',
  'terms_already_locked',
];

/** A sourcing policy version's lifecycle — the `fee_schedules` shape. */
export type SupplierSourcingPolicyStatus = 'draft' | 'active' | 'superseded' | 'retired';

/** {@link SupplierSourcingPolicyStatus} as the tuple the columns and CHECKs read. */
export const SUPPLIER_SOURCING_POLICY_STATUSES: readonly SupplierSourcingPolicyStatus[] = [
  'draft',
  'active',
  'superseded',
  'retired',
];

/** What a preflight suppression covers (#122 operations 4 and 6). */
export type SupplierSuppressionScope =
  | 'supplier'
  | 'supplier_account'
  | 'market'
  | 'supplier_account_market';

/** {@link SupplierSuppressionScope} as the tuple the columns and CHECKs read. */
export const SUPPLIER_SUPPRESSION_SCOPES: readonly SupplierSuppressionScope[] = [
  'supplier',
  'supplier_account',
  'market',
  'supplier_account_market',
];

/** Why a subject is suppressed. */
export type SupplierSuppressionKind =
  | 'kill_switch'
  | 'health_degraded'
  | 'quota_exhausted'
  | 'capability_unavailable';

/** {@link SupplierSuppressionKind} as the tuple the columns and CHECKs read. */
export const SUPPLIER_SUPPRESSION_KINDS: readonly SupplierSuppressionKind[] = [
  'kill_switch',
  'health_degraded',
  'quota_exhausted',
  'capability_unavailable',
];

/**
 * Who raised a suppression.
 *
 * `automatic_health` rows are the only ones this domain may raise or lift on its
 * own, and only for {@link SupplierSuppressionKind} `health_degraded`. A
 * `kill_switch` is always an operator's act and always carries their id — a
 * CHECK, so nothing automatic can file one.
 */
export type SupplierSuppressionOrigin = 'operator' | 'automatic_health';

/** {@link SupplierSuppressionOrigin} as the tuple the columns and CHECKs read. */
export const SUPPLIER_SUPPRESSION_ORIGINS: readonly SupplierSuppressionOrigin[] = [
  'operator',
  'automatic_health',
];

/**
 * The destination facts a supplier may be asked to quote against.
 *
 * The WHOLE vocabulary, and the absent members are the point: there is no
 * recipient name, address line, phone or email here, so #122's "do not send
 * customer contact or address fields that the supplier does not need for
 * quoting" is enforced by `tsc` at every adapter call rather than reviewed at
 * each one. A parcel needs a street; a QUOTE does not.
 *
 * `postalCode` and `city` are accepted because some carriers price on them —
 * and neither is STORED: the quote row keeps `country` and `region` plus the
 * keyed request fingerprint, so an auditor can confirm which destination a
 * quote was taken for without the table ever holding one.
 */
export interface SupplierPreflightDestination {
  /** ISO-3166-1 alpha-2, upper case. */
  country: string;
  /** A coarse administrative region, when the carrier prices on one. */
  region?: string;
  /** Sent when the carrier prices on it. Never stored. */
  postalCode?: string;
  /** Sent when the carrier prices on it. Never stored. */
  city?: string;
}

/**
 * One line of a preflight request (#122 request items 1–3, 7).
 *
 * A retail line and nothing else: it names a procurement offer, so a
 * marketplace listing and an `external_referral` offer have no shape here —
 * #122 mixed carts 5–6, held by the type rather than by a filter somebody could
 * forget to apply.
 */
export interface SupplierPreflightLine {
  /** The procurement offer being sourced from (#118). */
  procurementOfferId: string;
  /** The supplier's own SKU, as the offer records it. */
  supplierSku: string;
  /** The canonical variant this line is for — the identity a substitution must preserve. */
  canonicalVariantId: string | null;
  canonicalProductId: string | null;
  quantity: number;
}

/**
 * A preflight request (#122 "SupplierPreflight request", items 1–10).
 *
 * ## No actor, session or buyer identity — structurally
 *
 * There is no `guestSessionId`, `oxyUserId`, `sessionId` or `actor` member, and
 * that is what makes #122 concurrency 5 ("session rotation and guest sign-in do
 * not duplicate supplier requests") true rather than tested: the request
 * fingerprint is computed from this type, so a rotated session cannot change
 * it, because a session cannot reach it.
 */
export interface SupplierPreflightRequest {
  /** The supplier account to ask (#118). */
  supplierAccountId: string;
  line: SupplierPreflightLine;
  destination: SupplierPreflightDestination;
  /** A requested carrier service code, when the buyer or the policy pinned one. */
  requestedShippingServiceCode?: string;
  /** The currency the answer should be denominated in. */
  currency: CurrencyCode;
  /** The checkout group this question belongs to, when it has one. */
  checkoutGroupId?: string;
  /** The customer order this question belongs to, when one exists (#123). */
  orderId?: string;
  /** The caller's idempotency key. Defaults to the request fingerprint. */
  idempotencyKey?: string;
  /** A prior quote being refreshed, when this is a re-preflight. */
  priorQuoteId?: string;
  /** ISO-8601. Defaults to now. */
  at?: string;
}

/** A shipping service the supplier offered (#122 response item 6). */
export interface SupplierShippingOption {
  serviceCode: string;
  carrier: string | null;
  serviceName: string | null;
  cost: Money;
  basis: SupplierShippingBasis;
  deliveryDaysMin: number | null;
  deliveryDaysMax: number | null;
  guaranteed: boolean;
}

/**
 * The shipping answer for one group, as a union whose UNKNOWN branch has no
 * cost (#122 mixed carts 3, response item 7).
 *
 * `basket` carries ONE cost for the whole group and no per-line member, so
 * summing per-item shipping when the supplier priced the basket is not a
 * mistake to avoid — it has no expression. `unknown` has no `cost` at all, so
 * reading an unavailable shipping cost as free requires writing the coercion
 * out loud.
 */
export type SupplierShippingQuote =
  | { basis: 'basket'; cost: Money; serviceCode: string; guaranteed: boolean }
  | {
      basis: 'per_item';
      /** One entry per requested line, in request order. */
      costs: readonly Money[];
      serviceCode: string;
      guaranteed: boolean;
    }
  | { basis: 'unknown'; restrictions: readonly SupplierDestinationRestriction[] };

/**
 * Whether the supplier made a real reservation (#122 acceptance 3).
 *
 * THE honesty device of this domain. The only branch that says a hold exists
 * carries the supplier's own id and expiry as NON-optional members, so an
 * orchestration that wanted to record a reservation nobody made would have to
 * invent a provider id — and the reservation table refuses a blank one.
 * `supported: false` has no id, no expiry and no success to misread.
 */
export type SupplierReservationOutcome =
  | { supported: false; reason: 'capability_not_declared' | 'not_requested' }
  | {
      supported: true;
      state: 'reserved';
      /** The SUPPLIER's own reservation id. Never a Mercaria row id. */
      providerReservationId: string;
      /** ISO-8601, from the supplier. */
      providerExpiresAt: string;
      singleUse: boolean;
    }
  | {
      supported: true;
      state: 'refused';
      reason: SupplierProviderReasonCode;
    };

/**
 * A normalized preflight answer (#122 "Preflight response", items 1–16).
 *
 * What an adapter returns and what the durable quote stores, field for field.
 * Unknown facts are `null`, never zero and never a default — the components a
 * complete answer requires are checked by
 * `deriveSupplierPreflightCompleteness`, and the same rule is a CHECK on the
 * stored row.
 */
export interface SupplierPreflightAnswer {
  identity: SupplierIdentityConfirmation;
  availability: SupplierAvailabilityState;
  /** NULL = the supplier does not report a ceiling. A different fact from zero. */
  maxOrderableQuantity: number | null;
  minimumOrderQuantity: number | null;
  packSize: number | null;
  unitCost: Money | null;
  supplierFees: Money | null;
  shipping: SupplierShippingQuote;
  shippingOptions: readonly SupplierShippingOption[];
  handlingDaysMin: number | null;
  handlingDaysMax: number | null;
  dispatchDaysMin: number | null;
  dispatchDaysMax: number | null;
  deliveryDaysMin: number | null;
  deliveryDaysMax: number | null;
  tax: Money | null;
  duty: Money | null;
  importResponsibility: SupplierImportResponsibility | null;
  fulfilmentOriginCountry: string | null;
  destinationRestrictions: readonly SupplierDestinationRestriction[];
  /** The provider's own quote reference, when it minted one. */
  providerQuoteReference: string | null;
  /** ISO-8601. When the supplier states its own expiry, this is it. */
  providerExpiresAt: string | null;
  priceGuarantee: SupplierQuoteGuarantee;
  stockGuarantee: SupplierQuoteGuarantee;
  reservation: SupplierReservationOutcome;
  reasonCodes: readonly SupplierProviderReasonCode[];
  /**
   * A reference to the restricted-access raw source record, when the adapter
   * stored one. Never the payload itself: this domain stores allow-listed,
   * normalized fields and a POINTER, exactly as the payment domain does.
   */
  sourceRecordRef: string | null;
}

/**
 * The completeness verdict, derived from an answer (#122 response, closing
 * rule).
 *
 * Three separate questions, the `deriveRetailCompleteness` shape: what the
 * answer knows, whether it may be shown, and whether checkout may proceed. They
 * are not the same question — a `partial` answer with a known item cost is
 * legitimately displayable and may never be charged against.
 */
export interface SupplierPreflightCompleteness {
  status: SupplierPreflightStatus;
  /** Sorted and deduped. Non-empty exactly when `status` is not `complete`. */
  blockReasons: readonly SupplierPreflightBlockReason[];
  /** Present exactly when `status` is `invalid`. */
  exceptionKind: SupplierPreflightExceptionKind | null;
  /** Only a `complete` answer may authorize a charge. */
  mayCheckout: boolean;
}

/**
 * The delivered total for a decomposed cart (#122 mixed carts 7–8).
 *
 * The incomplete branch has NO `total`, which is the whole point: "do not claim
 * a complete delivered total when one group remains unquoted" is not a rule the
 * composer has to remember, it is the only shape it can return when a group is
 * missing.
 */
export type SupplierGroupDeliveredTotal =
  | { complete: true; total: Money; groupTotals: readonly Money[] }
  | { complete: false; unquotedGroupKeys: readonly string[] };

/** One line of the operator-facing quote trace, with the destination redacted. */
export interface SupplierQuoteTrace {
  quoteId: string;
  supplierId: string;
  supplierAccountId: string;
  procurementOfferId: string | null;
  supplierSku: string;
  quantity: number;
  environment: string;
  status: SupplierPreflightStatus;
  blockReasons: readonly SupplierPreflightBlockReason[];
  exceptionKind: SupplierPreflightExceptionKind | null;
  availability: SupplierAvailabilityState;
  identity: SupplierIdentityConfirmation;
  usage: SupplierQuoteUsage;
  /** Coarse only — the country and region a quote may keep. */
  destinationCountry: string;
  destinationRegion: string | null;
  quotedAt: string;
  expiresAt: string;
  reservation: {
    present: boolean;
    /** Redacted to its last four characters, the `provider_accounts` rule. */
    providerReservationIdSuffix: string | null;
    providerExpiresAt: string | null;
    consumedAt: string | null;
    releasedAt: string | null;
  };
  attempts: number;
  lastFailureKind: SupplierPreflightFailureKind | null;
  latencyMs: number | null;
}
