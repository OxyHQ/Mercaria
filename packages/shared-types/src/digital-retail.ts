/**
 * Authorized digital retail — the private supply vocabulary (#1016, ADR 0011).
 *
 * Mercaria is the seller; an approved distributor is private procurement
 * infrastructure behind it. Every closed value set that domain uses is declared
 * HERE, once, as a `readonly` tuple plus the union derived from it — the
 * `payment.ts` / `procurement.ts` convention, and the thing the Postgres CHECKs,
 * the drizzle column types and the service guards all read.
 *
 * ## The boundary this file exists to hold
 *
 * Nothing in here is a public DTO except the three projections at the bottom, and
 * those are safe because of their SHAPE rather than because of a serializer: a
 * type with no cost property cannot leak a cost. Wholesale cost, supplier
 * identity, supplier SKUs, provider order ids and procurement reasoning live on
 * private rows that have no route, no controller and no DTO at all.
 *
 * ## What is deliberately ABSENT
 *
 * **Any spelling of a gift card, a top-up or a cash-equivalent instrument.**
 * ADR 0011 D16 keeps ADR 0010 D16's stored-value half intact:
 * {@link DIGITAL_RETAIL_PRODUCT_CLASSES} has no member for one, the CHECK on the
 * column is rendered from that tuple, and so such a product is unrepresentable
 * rather than disabled by a flag. Admitting one is a new ADR plus the epic's
 * Workstream 13 compliance gate, not an edit to this tuple.
 *
 * **A plaintext artifact anywhere.** No type here holds a key, a code or a token
 * value. The one shape that describes a delivered artifact to a buyer
 * ({@link DigitalLibraryEntryView}) carries a masked hint and a state, and the
 * secret itself is handed over exactly once by the reveal path.
 */

/* -------------------------------------------------------------------------- */
/* What Mercaria retails                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The product classes authorized digital retail may sell (ADR 0011 D16).
 *
 * FOUR members, and the absences are the decision:
 *
 * - **No gift card, no top-up, no cash-equivalent.** ADR 0010 D16's stored-value
 *   half is untouched. A CHECK rendered from this tuple makes one unrepresentable.
 * - **`subscription_activation_code` is NOT a `consumer_subscription`.** Mercaria
 *   sells a code once, at a fixed price, and never bills the customer again; any
 *   recurring relationship is between the customer and the platform they redeem
 *   it on. ADR 0007 D15 excludes Mercaria operating a recurring consumer charge,
 *   and nothing here does.
 * - **No `other`.** An unclassifiable product is one nobody reviewed, and a
 *   catch-all member is how the review is skipped.
 */
export type DigitalRetailProductClass =
  | 'digital_game'
  | 'game_expansion'
  | 'software_licence'
  | 'subscription_activation_code';

/** {@link DigitalRetailProductClass} as the tuple the column types and CHECKs read. */
export const DIGITAL_RETAIL_PRODUCT_CLASSES: readonly DigitalRetailProductClass[] = [
  'digital_game',
  'game_expansion',
  'software_licence',
  'subscription_activation_code',
];

/**
 * How a supply is TAXED, carried per offer and snapshotted per order line
 * (ADR 0011 D18).
 *
 * This carries a DISTINCTION and asserts no rate, threshold or jurisdictional
 * conclusion — the epic is explicit that it *"does not hard-code jurisdictional
 * legal conclusions; it requires the commerce model to carry the distinctions
 * needed for reviewed policy"*. A market whose treatment is unresolved does not
 * launch, and the lever that holds it is per deployment.
 */
export type DigitalRetailTaxClass =
  | 'electronically_supplied_service'
  | 'software_licence_supply'
  | 'content_licence_supply';

/** {@link DigitalRetailTaxClass} as the tuple the column types and CHECKs read. */
export const DIGITAL_RETAIL_TAX_CLASSES: readonly DigitalRetailTaxClass[] = [
  'electronically_supplied_service',
  'software_licence_supply',
  'content_licence_supply',
];

/**
 * What is actually handed over, and how (the epic's Workstream 9).
 *
 * Deliberately NOT "a key, plus special cases". A domain designed around plaintext
 * codes acquires its second shape as an exception, and the exception is where the
 * security properties get dropped.
 *
 * - `activation_key` — a platform key the buyer redeems themselves.
 * - `redemption_code` — a code redeemed on a publisher or platform surface that
 *   is not an activation ecosystem.
 * - `licence_token` — an opaque token a product activates against.
 * - `licence_file` — a licence issued as a file. It is delivered through #1015's
 *   grant path, never as a URL.
 * - `direct_account_activation` — the supplier activates onto an account Mercaria
 *   has bound to the purchase. No secret is ever shown to the buyer.
 * - `external_account_link_activation` — the buyer authenticates with the platform
 *   because the PLATFORM requires it. They are never sent to the supplier to buy.
 */
export type DigitalFulfilmentCapability =
  | 'activation_key'
  | 'redemption_code'
  | 'licence_token'
  | 'licence_file'
  | 'direct_account_activation'
  | 'external_account_link_activation';

/** {@link DigitalFulfilmentCapability} as the tuple the column types and CHECKs read. */
export const DIGITAL_FULFILMENT_CAPABILITIES: readonly DigitalFulfilmentCapability[] = [
  'activation_key',
  'redemption_code',
  'licence_token',
  'licence_file',
  'direct_account_activation',
  'external_account_link_activation',
];

/**
 * The capabilities whose artifact is BEARER SECRET MATERIAL — anyone holding the
 * plaintext can use it.
 *
 * The sealing rules, the reveal audit and the refund consequences of a reveal all
 * key on this set rather than on a per-capability `if`, so adding a capability
 * forces a decision about which side of the line it falls on.
 */
export const SECRET_BEARING_FULFILMENT_CAPABILITIES: readonly DigitalFulfilmentCapability[] = [
  'activation_key',
  'redemption_code',
  'licence_token',
];

/** Whether a capability's artifact is bearer secret material (ADR 0011 D10). */
export function isSecretBearingCapability(capability: DigitalFulfilmentCapability): boolean {
  return SECRET_BEARING_FULFILMENT_CAPABILITIES.includes(capability);
}

/* -------------------------------------------------------------------------- */
/* Who Mercaria buys from                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How a supply relationship is SOURCED — the epic's Workstream 21 classification,
 * carried on the agreement rider rather than on the supplier (ADR 0011 D3).
 *
 * FOUR members and **no `unknown`**, which is what makes it fail closed: an
 * unclassified relationship has no rider at all, and no rider already authorizes
 * nothing. An `unverified` member would be a value the database accepts, which
 * means a row can sit in it, which means the rule is a service-level `if`.
 *
 * One counterparty may hold several riders — publisher-direct for its own titles,
 * authorized distributor for the rest — because provenance is a property of what
 * was agreed, not of who they are.
 */
export type DigitalSupplyProvenance =
  | 'publisher_direct'
  | 'authorized_distributor'
  | 'authorized_wholesaler'
  | 'approved_marketplace_supply';

/** {@link DigitalSupplyProvenance} as the tuple the column types and CHECKs read. */
export const DIGITAL_SUPPLY_PROVENANCES: readonly DigitalSupplyProvenance[] = [
  'publisher_direct',
  'authorized_distributor',
  'authorized_wholesaler',
  'approved_marketplace_supply',
];

/**
 * Provenance strength, for the ONE place policy may prefer one over another: the
 * selector's final ranking (ADR 0011 D9). Higher is stronger.
 *
 * A total map rather than an array index, so adding a member without deciding its
 * strength fails `tsc`.
 */
export const DIGITAL_SUPPLY_PROVENANCE_STRENGTH: Readonly<
  Record<DigitalSupplyProvenance, number>
> = {
  publisher_direct: 4,
  authorized_distributor: 3,
  authorized_wholesaler: 2,
  approved_marketplace_supply: 1,
};

/**
 * What a digital supplier account's API can do — the adapter capability set
 * (the epic's Workstream 2).
 *
 * A SEPARATE vocabulary from `SUPPLIER_API_CAPABILITIES`, deliberately:
 * `shipping_quote` and `fulfilment_fetch` do not belong to one list, and a single
 * widened tuple would let a physical account claim a digital capability by
 * typo. Each member is one operation on {@link DigitalSupplierAdapterOperation}.
 */
export type DigitalSupplierApiCapability =
  | 'catalog_sync'
  | 'product_lookup'
  | 'stock_query'
  | 'quote'
  | 'preflight'
  | 'purchase'
  | 'purchase_recovery'
  | 'fulfilment_fetch'
  | 'order_status'
  | 'cancel'
  | 'credit_status'
  | 'callback_events'
  | 'health';

/** {@link DigitalSupplierApiCapability} as the tuple the element CHECK reads. */
export const DIGITAL_SUPPLIER_API_CAPABILITIES: readonly DigitalSupplierApiCapability[] = [
  'catalog_sync',
  'product_lookup',
  'stock_query',
  'quote',
  'preflight',
  'purchase',
  'purchase_recovery',
  'fulfilment_fetch',
  'order_status',
  'cancel',
  'credit_status',
  'callback_events',
  'health',
];

/**
 * The capabilities without which NOTHING can be procured from an account.
 *
 * `purchase_recovery` is in the set and that is the decision worth reading: an
 * adapter that can buy but cannot ask *"did my last request actually buy
 * something"* makes the ambiguous state unrecoverable, and an unrecoverable
 * ambiguous state converges on either double-buying or stranding a paid customer.
 * ADR 0011 D5 says a timeout may only be left by provider truth; this is the
 * tuple that makes an account unable to reach the state in the first place.
 */
export const REQUIRED_PROCUREMENT_CAPABILITIES: readonly DigitalSupplierApiCapability[] = [
  'preflight',
  'purchase',
  'purchase_recovery',
  'fulfilment_fetch',
];

/**
 * A single capability's own pause state (ADR 0011 D2).
 *
 * Independent per capability because the epic requires catalog sync and
 * procurement to pause separately (W2 requirement 9), and an array column cannot
 * carry a per-element pause, health check or reason.
 */
export type DigitalSupplierCapabilityState = 'enabled' | 'paused' | 'unavailable';

/** {@link DigitalSupplierCapabilityState} as the tuple the column types and CHECKs read. */
export const DIGITAL_SUPPLIER_CAPABILITY_STATES: readonly DigitalSupplierCapabilityState[] = [
  'enabled',
  'paused',
  'unavailable',
];

/* -------------------------------------------------------------------------- */
/* Private procurement offers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How confidently a supplier offer is mapped onto Mercaria's canonical variant
 * (ADR 0011 D4).
 *
 * `exact` is the ONLY value that may fulfil a customer order. An `ambiguous` offer
 * is stored, keeps the supplier's own title verbatim for audit, and is dark — the
 * same refusal `matchIncomingVariant` makes for a GTIN collision, which answers
 * `ambiguous` and never `skipped`.
 */
export type DigitalProcurementMappingStatus = 'exact' | 'ambiguous' | 'unmapped';

/** {@link DigitalProcurementMappingStatus} as the tuple the column types and CHECKs read. */
export const DIGITAL_PROCUREMENT_MAPPING_STATUSES: readonly DigitalProcurementMappingStatus[] = [
  'exact',
  'ambiguous',
  'unmapped',
];

/**
 * Why a digital procurement offer is NOT eligible — the closed, explainable reason
 * set the derived verdict carries.
 *
 * Fail-closed: an unknown condition is a reason, never a pass. Separate from
 * `PROCUREMENT_INELIGIBILITY_REASONS` because six of these have no physical
 * counterpart and three physical ones (destination, incoterm, origin) have no
 * digital meaning — one merged tuple would make every reason list half-inapplicable.
 */
export type DigitalProcurementIneligibilityReason =
  | 'supplier_not_active'
  | 'supplier_risk_blocked'
  | 'account_not_active'
  | 'account_kill_switched'
  | 'capability_missing'
  | 'capability_paused'
  | 'terms_missing'
  | 'agreement_not_approved'
  | 'agreement_not_effective'
  | 'agreement_expired'
  | 'product_class_not_permitted'
  | 'capability_not_permitted'
  | 'territory_not_permitted'
  | 'brand_excluded'
  | 'offer_retired'
  | 'offer_quote_stale'
  | 'offer_expired'
  | 'offer_mapping_ambiguous'
  | 'offer_unmapped'
  | 'offer_out_of_stock'
  | 'cost_above_bound'
  | 'procurement_disabled';

/** {@link DigitalProcurementIneligibilityReason} as the tuple guards and tests read. */
export const DIGITAL_PROCUREMENT_INELIGIBILITY_REASONS: readonly DigitalProcurementIneligibilityReason[] =
  [
    'supplier_not_active',
    'supplier_risk_blocked',
    'account_not_active',
    'account_kill_switched',
    'capability_missing',
    'capability_paused',
    'terms_missing',
    'agreement_not_approved',
    'agreement_not_effective',
    'agreement_expired',
    'product_class_not_permitted',
    'capability_not_permitted',
    'territory_not_permitted',
    'brand_excluded',
    'offer_retired',
    'offer_quote_stale',
    'offer_expired',
    'offer_mapping_ambiguous',
    'offer_unmapped',
    'offer_out_of_stock',
    'cost_above_bound',
    'procurement_disabled',
  ];

/**
 * The derived eligibility verdict. Deliberately NEVER stored as a column — a
 * stored flag beside the facts it derives from is two representations of one
 * fact, and the place they must not disagree is a checkout gate.
 */
export interface DigitalProcurementEligibility {
  eligible: boolean;
  /** Empty exactly when `eligible` is true. Sorted, deduped, explainable. */
  reasons: DigitalProcurementIneligibilityReason[];
}

/** A digital procurement offer's lifecycle. Freshness is DERIVED, never a status. */
export type DigitalProcurementOfferStatus = 'active' | 'retired';

/** {@link DigitalProcurementOfferStatus} as the tuple the column types and CHECKs read. */
export const DIGITAL_PROCUREMENT_OFFER_STATUSES: readonly DigitalProcurementOfferStatus[] = [
  'active',
  'retired',
];

/* -------------------------------------------------------------------------- */
/* The digital purchase order                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The digital purchase-order machine of ADR 0011 D5.
 *
 * ```text
 * pending -> preflighted -> submitting -> accepted -> fulfilled
 *                              |  \-> ambiguous -> accepted | rejected | failed
 *                              \-> rejected | failed
 * any non-terminal -> cancelled
 * accepted | fulfilled -> credited
 * ```
 *
 * `ambiguous` is a FIRST-CLASS state and the reason the whole machine exists
 * separately from `PURCHASE_ORDER_STATUSES`: a timeout that advanced to `failed`
 * would invite a fallback that buys a second key for a customer paying for one.
 */
export type DigitalPurchaseOrderStatus =
  | 'pending'
  | 'preflighted'
  | 'submitting'
  | 'ambiguous'
  | 'accepted'
  | 'fulfilled'
  | 'rejected'
  | 'cancelled'
  | 'credited'
  | 'failed';

/** {@link DigitalPurchaseOrderStatus} as the tuple the column types and CHECKs read. */
export const DIGITAL_PURCHASE_ORDER_STATUSES: readonly DigitalPurchaseOrderStatus[] = [
  'pending',
  'preflighted',
  'submitting',
  'ambiguous',
  'accepted',
  'fulfilled',
  'rejected',
  'cancelled',
  'credited',
  'failed',
];

/**
 * The terminal states — nothing transitions out of these, and the partial unique
 * index that bounds "one live attempt per order line" is defined as the complement
 * of this set.
 */
export const DIGITAL_PURCHASE_ORDER_TERMINAL_STATUSES: readonly DigitalPurchaseOrderStatus[] = [
  'fulfilled',
  'rejected',
  'cancelled',
  'credited',
  'failed',
];

/** The states in which an order line still has a procurement attempt in flight. */
export const DIGITAL_PURCHASE_ORDER_LIVE_STATUSES: readonly DigitalPurchaseOrderStatus[] =
  DIGITAL_PURCHASE_ORDER_STATUSES.filter(
    (status) => !DIGITAL_PURCHASE_ORDER_TERMINAL_STATUSES.includes(status),
  );

/**
 * The TOTAL transition map. Every status is a key, so a new state that nobody
 * decided the edges for fails `tsc` rather than becoming implicitly terminal.
 *
 * Two edges are absent on purpose and both are load-bearing:
 *
 * - **`submitting -> failed` on a timeout does not exist.** The only edge a
 *   timeout may take is `submitting -> ambiguous` (ADR 0011 D5). A `failed`
 *   written on a timeout is a claim that nothing was bought, and nothing on this
 *   side of the wire knows that.
 * - **`ambiguous -> cancelled` exists but `ambiguous -> fulfilled` does not.** A
 *   recovered ambiguous order rejoins the machine at `accepted`, which is where
 *   its artifact is fetched from provider truth — so an artifact can never appear
 *   without a fetch that proves it.
 *
 * `pending -> rejected` and `preflighted -> rejected` are present because a
 * supplier can answer "no" at PREFLIGHT — out of stock, unknown SKU, a cost above
 * the order's ceiling — and that is a rejection, not an integration failure. The
 * first version of this map omitted them, and the consequence was not a bad
 * label: the transition was refused, the attempt stayed `pending`, and the
 * partial unique over the non-terminal statuses then blocked that order line
 * forever. A state machine missing an edge does not merely mislabel; it strands.
 */
export const DIGITAL_PURCHASE_ORDER_TRANSITIONS: Readonly<
  Record<DigitalPurchaseOrderStatus, readonly DigitalPurchaseOrderStatus[]>
> = {
  pending: ['preflighted', 'rejected', 'cancelled', 'failed'],
  preflighted: ['submitting', 'rejected', 'cancelled', 'failed'],
  submitting: ['accepted', 'ambiguous', 'rejected', 'failed'],
  ambiguous: ['accepted', 'rejected', 'cancelled', 'failed'],
  accepted: ['fulfilled', 'cancelled', 'credited', 'failed'],
  fulfilled: ['credited'],
  rejected: [],
  cancelled: [],
  credited: [],
  failed: [],
};

/** Whether the machine admits this edge. The ONE place the table is read. */
export function digitalPurchaseOrderTransitionAllowed(
  from: DigitalPurchaseOrderStatus,
  to: DigitalPurchaseOrderStatus,
): boolean {
  return DIGITAL_PURCHASE_ORDER_TRANSITIONS[from].includes(to);
}

/**
 * The normalized provider error taxonomy (the epic's Workstream 2 requirement 3).
 *
 * The provider's own message is stored REDACTED beside the code; the code is what
 * queues, retries and tests read. `other` is the honest fallback and is never a
 * sentence.
 *
 * **`timeout` is not a failure.** It is the one kind that produces `ambiguous`,
 * and `isAmbiguousProcurementError` is the single place that judgement is made.
 */
export type DigitalProcurementErrorKind =
  | 'out_of_stock'
  | 'price_changed'
  | 'sku_unknown'
  | 'region_not_served'
  | 'rights_restricted'
  | 'rate_limited'
  | 'authentication_failed'
  | 'insufficient_funding'
  | 'provider_unavailable'
  | 'provider_rejected'
  | 'invalid_request'
  | 'duplicate_request'
  | 'timeout'
  | 'other';

/** {@link DigitalProcurementErrorKind} as the tuple the column types and CHECKs read. */
export const DIGITAL_PROCUREMENT_ERROR_KINDS: readonly DigitalProcurementErrorKind[] = [
  'out_of_stock',
  'price_changed',
  'sku_unknown',
  'region_not_served',
  'rights_restricted',
  'rate_limited',
  'authentication_failed',
  'insufficient_funding',
  'provider_unavailable',
  'provider_rejected',
  'invalid_request',
  'duplicate_request',
  'timeout',
  'other',
];

/**
 * The error kinds that leave the outcome UNKNOWN — the ones after which the
 * gateway cannot say whether the supplier allocated anything.
 *
 * A `timeout` obviously qualifies. `provider_unavailable` qualifies too, and that
 * is the subtle one: a 502 from a load balancer can sit in front of a request the
 * origin processed. `rate_limited` does NOT qualify — a throttle is a refusal
 * before work — and neither does `out_of_stock`, which is an answer.
 */
export const AMBIGUOUS_PROCUREMENT_ERROR_KINDS: readonly DigitalProcurementErrorKind[] = [
  'timeout',
  'provider_unavailable',
];

/** Whether this error leaves the supplier's side unknown (ADR 0011 D5). */
export function isAmbiguousProcurementError(kind: DigitalProcurementErrorKind): boolean {
  return AMBIGUOUS_PROCUREMENT_ERROR_KINDS.includes(kind);
}

/** Who caused a purchase-order transition. */
export type DigitalProcurementInitiator = 'system' | 'customer' | 'supplier' | 'operator';

/** {@link DigitalProcurementInitiator} as the tuple the column types and CHECKs read. */
export const DIGITAL_PROCUREMENT_INITIATORS: readonly DigitalProcurementInitiator[] = [
  'system',
  'customer',
  'supplier',
  'operator',
];

/* -------------------------------------------------------------------------- */
/* Fulfilment, artifacts and their audit                                       */
/* -------------------------------------------------------------------------- */

/**
 * A fulfilment's state as the BUYER's durable record of what they own.
 *
 * **There is no `replaced` member, and the absence is a decision.** A replacement
 * is a fact about the ARTIFACT, not about the entitlement: the buyer still owns
 * the same one thing they bought, and what changed is which key it is currently
 * expressed as. Modelling replacement as a fulfilment state would mean a second
 * fulfilment row per incident, and the library would then have to decide which of
 * two rows for one order line to show — the decision that produces "both the old
 * and the new key look valid", which ADR 0011 D11 makes unrepresentable instead.
 */
export type DigitalFulfilmentStatus = 'pending' | 'delivered' | 'refunded' | 'revoked';

/** {@link DigitalFulfilmentStatus} as the tuple the column types and CHECKs read. */
export const DIGITAL_FULFILMENT_STATUSES: readonly DigitalFulfilmentStatus[] = [
  'pending',
  'delivered',
  'refunded',
  'revoked',
];

/**
 * Where an artifact CAME FROM (ADR 0011 D12).
 *
 * `operator_manual` is a member because the real world contains suppliers who
 * email a key after an outage. What makes it safe is the CHECK beside it: an
 * `operator_manual` artifact REQUIRES a named operator and an incident id, with no
 * default — so an operator cannot fabricate a successful fulfilment without an
 * auditable exceptional process, and a machine cannot produce one at all.
 */
export type DigitalArtifactSource = 'supplier_api' | 'supplier_callback' | 'operator_manual';

/** {@link DigitalArtifactSource} as the tuple the column types and CHECKs read. */
export const DIGITAL_ARTIFACT_SOURCES: readonly DigitalArtifactSource[] = [
  'supplier_api',
  'supplier_callback',
  'operator_manual',
];

/** An artifact's own lifecycle. Nothing is ever deleted (ADR 0011 D11). */
export type DigitalArtifactState = 'active' | 'replaced' | 'revoked' | 'expired';

/** {@link DigitalArtifactState} as the tuple the column types and CHECKs read. */
export const DIGITAL_ARTIFACT_STATES: readonly DigitalArtifactState[] = [
  'active',
  'replaced',
  'revoked',
  'expired',
];

/**
 * Whether the artifact has been USED, as distinct from looked at (ADR 0011 D10).
 *
 * `unknown` is the DEFAULT and is honest: for most ecosystems Mercaria has no way
 * to ask. Only provider truth may move it, which is why there is no operator
 * transition to `redeemed` — an operator who could set it could make a refund
 * ineligible by typing.
 */
export type DigitalArtifactRedemptionState = 'unknown' | 'unredeemed' | 'redeemed' | 'invalid';

/** {@link DigitalArtifactRedemptionState} as the tuple the column types and CHECKs read. */
export const DIGITAL_ARTIFACT_REDEMPTION_STATES: readonly DigitalArtifactRedemptionState[] = [
  'unknown',
  'unredeemed',
  'redeemed',
  'invalid',
];

/** Who performed a reveal. Two kinds, and an operator reveal is always audited. */
export type DigitalRevealActorKind = 'buyer' | 'operator';

/** {@link DigitalRevealActorKind} as the tuple the column types and CHECKs read. */
export const DIGITAL_REVEAL_ACTOR_KINDS: readonly DigitalRevealActorKind[] = ['buyer', 'operator'];

/** What a support incident over a fulfilment IS. */
export type DigitalFulfilmentIncidentKind =
  | 'buyer_reported_invalid'
  | 'buyer_reported_used'
  | 'buyer_reported_wrong_region'
  | 'supplier_reported_invalid'
  | 'provider_incident'
  | 'operator_escalation';

/** {@link DigitalFulfilmentIncidentKind} as the tuple the column types and CHECKs read. */
export const DIGITAL_FULFILMENT_INCIDENT_KINDS: readonly DigitalFulfilmentIncidentKind[] = [
  'buyer_reported_invalid',
  'buyer_reported_used',
  'buyer_reported_wrong_region',
  'supplier_reported_invalid',
  'provider_incident',
  'operator_escalation',
];

/** The kinds an OPERATOR raises, which the schema requires an operator id for. */
export const OPERATOR_RAISED_INCIDENT_KINDS: readonly DigitalFulfilmentIncidentKind[] = [
  'provider_incident',
  'operator_escalation',
];

/** How an incident ended. `closed_no_action` is an outcome, not an absence. */
export type DigitalFulfilmentIncidentState =
  | 'open'
  | 'supplier_escalated'
  | 'replacement_issued'
  | 'refunded'
  | 'credited'
  | 'closed_no_action';

/** {@link DigitalFulfilmentIncidentState} as the tuple the column types and CHECKs read. */
export const DIGITAL_FULFILMENT_INCIDENT_STATES: readonly DigitalFulfilmentIncidentState[] = [
  'open',
  'supplier_escalated',
  'replacement_issued',
  'refunded',
  'credited',
  'closed_no_action',
];

/* -------------------------------------------------------------------------- */
/* Refund and remedy                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What may be DONE about a digital-retail purchase (ADR 0011 D11).
 *
 * Derived from facts by a pure function — the PO state, whether an artifact
 * exists, whether it was revealed, its redemption state, the capability and the
 * buyer's withdrawal waiver. No column anywhere says "refundable".
 */
export type DigitalRemedyOutcome =
  | 'cancel_before_procurement'
  | 'cancel_procurement'
  | 'refund_customer'
  | 'replace_artifact'
  | 'supplier_credit_pending'
  | 'manual_review'
  | 'not_eligible';

/** {@link DigitalRemedyOutcome} as the tuple guards and tests read. */
export const DIGITAL_REMEDY_OUTCOMES: readonly DigitalRemedyOutcome[] = [
  'cancel_before_procurement',
  'cancel_procurement',
  'refund_customer',
  'replace_artifact',
  'supplier_credit_pending',
  'manual_review',
  'not_eligible',
];

/**
 * Why a remedy is what it is. Closed, so a support surface can render a REASON
 * rather than a verdict the customer cannot argue with.
 */
export type DigitalRemedyReason =
  | 'not_yet_procured'
  | 'procurement_in_flight'
  | 'procurement_outcome_unknown'
  | 'artifact_not_revealed'
  | 'artifact_revealed'
  | 'artifact_redeemed'
  | 'artifact_reported_invalid'
  | 'withdrawal_waived'
  | 'activation_completed'
  | 'already_refunded';

/** {@link DigitalRemedyReason} as the tuple guards and tests read. */
export const DIGITAL_REMEDY_REASONS: readonly DigitalRemedyReason[] = [
  'not_yet_procured',
  'procurement_in_flight',
  'procurement_outcome_unknown',
  'artifact_not_revealed',
  'artifact_revealed',
  'artifact_redeemed',
  'artifact_reported_invalid',
  'withdrawal_waived',
  'activation_completed',
  'already_refunded',
];

/** One derived remedy: the outcome, and the facts that produced it. */
export interface DigitalRemedyVerdict {
  outcome: DigitalRemedyOutcome;
  /** Sorted, deduped. Never empty — every outcome has a reason, `not_eligible` included. */
  reasons: DigitalRemedyReason[];
}

/* -------------------------------------------------------------------------- */
/* Retail pricing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How a computed retail price is ROUNDED.
 *
 * ADR 0004 D3's physical retail is cost-only and rounds to the minor unit;
 * digital retail carries a margin (ADR 0011) and therefore lands on prices a
 * storefront has an opinion about.
 */
export type DigitalRetailRoundingMode = 'minor_unit' | 'end_99' | 'nearest_major';

/** {@link DigitalRetailRoundingMode} as the tuple the column types and CHECKs read. */
export const DIGITAL_RETAIL_ROUNDING_MODES: readonly DigitalRetailRoundingMode[] = [
  'minor_unit',
  'end_99',
  'nearest_major',
];

/** Why a price could not be computed. Closed, and every member is actionable. */
export type DigitalRetailPricingRefusal =
  | 'no_policy'
  | 'currency_mismatch'
  | 'margin_below_floor'
  | 'ceiling_below_floor'
  | 'cost_not_positive';

/** {@link DigitalRetailPricingRefusal} as the tuple guards and tests read. */
export const DIGITAL_RETAIL_PRICING_REFUSALS: readonly DigitalRetailPricingRefusal[] = [
  'no_policy',
  'currency_mismatch',
  'margin_below_floor',
  'ceiling_below_floor',
  'cost_not_positive',
];

/**
 * A priced public offer, or the reason there is not one.
 *
 * The success branch carries the retail price and the MARGIN in minor units,
 * because the caller computing it is inside the private domain. It is not a DTO
 * and never crosses toward a public surface — {@link DigitalRetailOfferView} is
 * what does, and it has no margin property.
 */
export type DigitalRetailPricingResult =
  | {
      priced: true;
      /** Minor units, in the policy's currency. */
      retailAmount: number;
      currency: string;
      /** `retailAmount - costAmount`, minor units. Private. */
      marginAmount: number;
      /** Realized margin in basis points of the retail price. Private. */
      marginBps: number;
    }
  | { priced: false; refusal: DigitalRetailPricingRefusal };

/* -------------------------------------------------------------------------- */
/* The projections that cross toward a public surface                          */
/* -------------------------------------------------------------------------- */

/**
 * What a buyer sees on a digital-retail product, and it is STRUCTURALLY unable to
 * leak (ADR 0011 D13).
 *
 * No supplier id, no supplier name, no account, no agreement, no cost, no supplier
 * SKU, no provider order id, no procurement reasoning — the type has no such
 * properties, so a serializer that tried to ship one fails `tsc`.
 *
 * `soldBy` is a literal, not a field somebody fills in: for this commercial mode
 * the seller is Mercaria and there is no other value it could take.
 */
export interface DigitalRetailOfferView {
  canonicalVariantId: string;
  productClass: DigitalRetailProductClass;
  /** The platform the buyer will use it on, e.g. `pc`. Lower-case slug. */
  platform: string;
  /** Where it activates, e.g. `steam`. Lower-case slug. */
  activationEcosystem: string;
  /** The edition as the catalogue knows it, e.g. `standard`. */
  edition: string;
  /** ISO-3166-1 alpha-2 territories the product ACTIVATES in. Empty = unrestricted. */
  activationTerritories: string[];
  fulfilmentCapability: DigitalFulfilmentCapability;
  /** Minor units, in `currency`. The RETAIL price — never a cost. */
  retailAmount: number;
  currency: string;
  soldBy: 'mercaria';
  /** Whether the buyer must authenticate with the platform to activate. */
  requiresPlatformAccountLink: boolean;
  /** Expected time to fulfil, for the checkout disclosure. */
  expectedFulfilmentSeconds: number | null;
}

/**
 * The seam toward the future public `mercaria_retail` offer (#57), for the
 * DIGITAL half — the shape `RetailOfferSourcingSeam` has for the physical half,
 * and for the same reason: #57's unified offer domain is not built, and extending
 * a table that does not exist is not a plan.
 *
 * What is absent is the point: no cost, no supplier, no credential, no terms.
 */
export interface DigitalRetailSourcingSeam {
  digitalProcurementOfferId: string;
  canonicalProductId: string | null;
  canonicalVariantId: string | null;
  productClass: DigitalRetailProductClass;
  fulfilmentCapability: DigitalFulfilmentCapability;
  mappingStatus: DigitalProcurementMappingStatus;
  eligibility: DigitalProcurementEligibility;
  expectedFulfilmentSeconds: number | null;
}

/**
 * One row of the buyer's Mercaria Library (ADR 0011 D17).
 *
 * The library is a PROJECTION over two durable records — `asset_rights` (#1015)
 * and `digital_fulfilments` (#1016) — so this type has to describe both without
 * flattening the difference. `origin` is which of the two it came from;
 * `action` is what the buyer may do next.
 *
 * It carries NO secret. `maskedHint` is at most four characters and exists so a
 * buyer can tell two purchases apart in a list without revealing either.
 */
export interface DigitalLibraryEntryView {
  /** The id of the underlying durable row, in its own domain. */
  id: string;
  origin: 'creator_asset' | 'authorized_retail';
  title: string;
  /** Purchase time, which is the library's sort key. */
  acquiredAt: string;
  status: 'active' | 'pending' | 'unavailable';
  /** What the buyer does next. `none` where the entry is informational. */
  action: 'download' | 'reveal' | 'activate' | 'link_account' | 'none';
  /** Present only for a retail fulfilment. */
  fulfilmentCapability: DigitalFulfilmentCapability | null;
  /** At most four characters, or null. Never a prefix of a live secret's start. */
  maskedHint: string | null;
  /** Whether a secret has already been revealed once — never the secret. */
  revealed: boolean;
  orderId: string | null;
}
