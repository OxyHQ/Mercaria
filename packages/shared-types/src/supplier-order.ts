/**
 * The provider-neutral supplier ORDER boundary (#124, ADR 0004 D4 steps 4–5,
 * D6.6, D9.2 and D10).
 *
 * #122 asks a supplier what it would do. This file is what Mercaria says when
 * it actually buys: the draft it submits, the acknowledgement it gets back, the
 * shipments and tracking that follow, the cancellation it may ask for, the
 * documents it is invoiced with, and the normalized error vocabulary all of
 * that fails in.
 *
 * ## It EXTENDS #122's capability contract; it does not fork it
 *
 * {@link SUPPLIER_ORDER_CAPABILITIES} joins `SUPPLIER_PREFLIGHT_CAPABILITIES`
 * into the one `SUPPLIER_ADAPTER_CAPABILITIES` tuple every declared-capability
 * CHECK and `applyDeclaredCapabilities` already read. A second, parallel
 * capability vocabulary is the failure this arrangement exists to prevent: two
 * lists describing one adapter can disagree, and the direction they disagree in
 * is always the permissive one — an adapter that "supports cancellation"
 * according to the list nobody enforces.
 *
 * The same holds for emulation. {@link SUPPLIER_ORDER_EMULATED_COMMITMENTS}
 * extends `SUPPLIER_EMULATED_COMMITMENTS`, so the disjointness gate that keeps
 * an emulation from being typed as a capability covers the order side for free.
 * The order-side entries are the ones that cost money rather than a bad quote:
 * `assumed_order_accepted` is a customer told their goods are coming because an
 * HTTP response was lost.
 *
 * ## What this file deliberately has no property for
 *
 * **A buyer email address.** ADR 0004 D2.7 permits the supplier recipient name,
 * the shipping address and a phone number where the carrier requires it, and
 * nothing else; the ADR's escape hatch — "a Mercaria-owned relay address per
 * order where the supplier's system demands one" — needs an outbound mail
 * transport Mercaria does not have (the `role_email` claim method, #83, is
 * unavailable for exactly the same reason). A field for it today could only
 * ever be filled with the buyer's own address, so {@link SupplierRecipient} has
 * none. #126 adds it with the transport that makes it real.
 *
 * **A street address on a tracking event.** {@link SupplierTrackingEvent}
 * carries a country and a region and no finer location: a carrier scan at the
 * delivery address is the buyer's home, and a tracking trail is read by
 * operators and stored for as long as the order is.
 *
 * **A provider document URL.** {@link SupplierInvoice} carries the supplier's
 * own document reference and no link. A supplier portal's document link is
 * routinely a signed URL — a credential wearing a location — and a column of
 * them is a credential store nobody declared.
 */

import type { CurrencyCode, Money } from './money';
import type { PurchaseOrderReasonCode } from './procurement';

/**
 * The TWELVE order-side capabilities a supplier adapter declares (#124
 * "SupplierAdapter contract").
 *
 *  - `order_draft_submission` — create the order at the provider.
 *  - `order_state_read` — read one order back, by the provider's own id.
 *  - `order_reference_lookup` — find an order by MERCARIA's client reference.
 *    The ambiguity converger: without it, a lost response can never be resolved
 *    automatically and goes to an operator instead of being retried.
 *  - `order_cancellation` — ask the provider to cancel.
 *  - `order_partial_acceptance` — the provider can accept part of an order and
 *    say which part. Without it a partial answer is unrepresentable, which is
 *    the point: splitting an all-or-nothing acceptance into per-line outcomes
 *    would be `assumed_partial_acceptance`.
 *  - `shipment_read` — parcels, carriers and tracking numbers.
 *  - `tracking_events` — the carrier scan trail behind a tracking number.
 *  - `invoice_retrieval` — the B2B invoice for a purchase order.
 *  - `credit_note_retrieval` — credit notes against one.
 *  - `return_authorization` — create or inspect an RMA.
 *  - `order_webhooks` — the provider pushes changes, verifiably.
 *  - `order_polling` — the provider supports being asked, within limits.
 */
export type SupplierOrderCapability =
  | 'order_draft_submission'
  | 'order_state_read'
  | 'order_reference_lookup'
  | 'order_cancellation'
  | 'order_partial_acceptance'
  | 'shipment_read'
  | 'tracking_events'
  | 'invoice_retrieval'
  | 'credit_note_retrieval'
  | 'return_authorization'
  | 'order_webhooks'
  | 'order_polling';

/** {@link SupplierOrderCapability} as the tuple the columns and CHECKs read. */
export const SUPPLIER_ORDER_CAPABILITIES: readonly SupplierOrderCapability[] = [
  'order_draft_submission',
  'order_state_read',
  'order_reference_lookup',
  'order_cancellation',
  'order_partial_acceptance',
  'shipment_read',
  'tracking_events',
  'invoice_retrieval',
  'credit_note_retrieval',
  'return_authorization',
  'order_webhooks',
  'order_polling',
];

/**
 * The SEVEN order-side commitments the orchestration may never manufacture.
 *
 * #122's six are about a quote being better than the supplier said; these are
 * about an ORDER being further along than the supplier said, which is the half
 * that reaches a customer. `assumed_order_accepted` is the one to read: a lost
 * HTTP response is not an acceptance, and treating it as one tells a buyer
 * their goods are on the way while nothing was ever ordered.
 */
export type SupplierOrderEmulatedCommitment =
  | 'assumed_order_accepted'
  | 'assumed_cancellation_accepted'
  | 'assumed_partial_acceptance'
  | 'synthetic_shipment'
  | 'assumed_delivery'
  | 'emulated_provider_idempotency'
  | 'synthetic_supplier_document';

/** {@link SupplierOrderEmulatedCommitment} as a tuple, for exhaustive iteration. */
export const SUPPLIER_ORDER_EMULATED_COMMITMENTS: readonly SupplierOrderEmulatedCommitment[] = [
  'assumed_order_accepted',
  'assumed_cancellation_accepted',
  'assumed_partial_acceptance',
  'synthetic_shipment',
  'assumed_delivery',
  'emulated_provider_idempotency',
  'synthetic_supplier_document',
];

/** Why each order-side emulation can never be represented — used verbatim in refusals. */
export const SUPPLIER_ORDER_EMULATED_COMMITMENT_LABELS: Record<
  SupplierOrderEmulatedCommitment,
  string
> = {
  assumed_order_accepted:
    'reading a lost or timed-out submission response as an acceptance — an unanswered submission is AMBIGUOUS, which converges by asking the provider or reaches an operator, and never becomes an accepted order',
  assumed_cancellation_accepted:
    'treating a cancellation REQUEST as a cancellation — the supplier answers a cancellation, and until it does the purchase order stays `cancel_requested`',
  assumed_partial_acceptance:
    'splitting an all-or-nothing acceptance into per-line outcomes — a provider that cannot report line-level acceptance has not accepted part of anything',
  synthetic_shipment:
    'recording a shipment or a tracking number the supplier did not report — a parcel Mercaria invented cannot be delivered, and the customer is told to wait for it',
  assumed_delivery:
    'reading dispatch, a transit scan or the passage of time as delivery — delivery is a carrier fact, and it starts the return window',
  emulated_provider_idempotency:
    'claiming a provider deduplicated a repeated submission when it declared no idempotency support — the second call places a second supplier order and Mercaria pays for both',
  synthetic_supplier_document:
    'composing an invoice or credit note the supplier did not issue — a document Mercaria wrote reconciles against itself and proves nothing about what was billed',
};

/**
 * The normalized order state every provider's own vocabulary maps onto.
 *
 * A DIFFERENT vocabulary from `PurchaseOrderStatus` and deliberately so: that
 * is Mercaria's own machine (ADR 0004 D9.2, nine states, with
 * `cancel_requested` as an overlay Mercaria owns and no provider has). This is
 * what a provider is capable of saying. Collapsing the two would make a
 * provider able to drive Mercaria's machine directly, which is what the
 * versioned mapping exists to prevent.
 *
 * `unknown` is a first-class answer and a BLOCKING one — an unmapped provider
 * string lands here rather than being guessed at, and the orchestration records
 * an `unmapped_provider_state` exception instead of moving anything.
 */
export type SupplierOrderNormalizedState =
  | 'unknown'
  | 'received'
  | 'accepted'
  | 'partially_accepted'
  | 'processing'
  | 'partially_shipped'
  | 'shipped'
  | 'delivered'
  | 'rejected'
  | 'cancelled';

/** {@link SupplierOrderNormalizedState} as the tuple the columns and CHECKs read. */
export const SUPPLIER_ORDER_NORMALIZED_STATES: readonly SupplierOrderNormalizedState[] = [
  'unknown',
  'received',
  'accepted',
  'partially_accepted',
  'processing',
  'partially_shipped',
  'shipped',
  'delivered',
  'rejected',
  'cancelled',
];

/** The normalized states nothing follows. */
export const SUPPLIER_ORDER_TERMINAL_STATES: readonly SupplierOrderNormalizedState[] = [
  'delivered',
  'rejected',
  'cancelled',
];

/**
 * How far along the fulfilment each normalized state is.
 *
 * Used ONLY to recognize a regression — a provider that says `accepted` after
 * having said `shipped` is correcting itself or is confused, and either way the
 * answer is to record the observation and raise it, never to move the machine
 * backwards. It is NOT the ordering key: two observations are ordered by the
 * PROVIDER's own `observedAt`, because a rank comparison cannot tell a stale
 * redelivery from a genuine correction.
 *
 * The three terminal states share the top rank with `delivered`: they are ends,
 * not steps, and ranking a cancellation below a shipment would make a
 * legitimate late cancellation read as a regression.
 */
export const SUPPLIER_ORDER_STATE_RANK: Record<SupplierOrderNormalizedState, number> = {
  unknown: 0,
  received: 1,
  accepted: 2,
  partially_accepted: 2,
  processing: 3,
  partially_shipped: 4,
  shipped: 5,
  delivered: 6,
  rejected: 6,
  cancelled: 6,
};

/**
 * The person a parcel is addressed to, as the supplier is told (ADR 0004 D2.7).
 *
 * `phone` exists because carriers in several launch markets refuse a
 * consignment without one; it is optional so a supplier that does not need it
 * is not sent one. There is deliberately no email member — see the module
 * docblock.
 */
export interface SupplierRecipient {
  name: string;
  company: string | null;
  phone: string | null;
}

/** A postal address, in the shape every carrier API agrees on. */
export interface SupplierAddress {
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  /** ISO-3166-1 alpha-2, upper case. */
  country: string;
}

/** Where the parcel goes, and nothing about who is buying it. */
export interface SupplierDestination {
  recipient: SupplierRecipient;
  address: SupplierAddress;
  /** Carrier instructions the buyer gave, when the agreement permits passing them. */
  deliveryInstructions: string | null;
}

/**
 * One line of a supplier order, with the exact SKU, quantity and the cost
 * Mercaria expects to be charged (#124 provider-neutral type 2).
 *
 * `expectedUnitCost` and `expectedLineTotal` are the QUOTE Mercaria is ordering
 * against, sent so the provider can refuse a mismatch rather than silently
 * billing something else. A provider that answers with a different total does
 * not get it applied: the difference is variance (#128) and, before shipment,
 * grounds for a `price_changed` rejection.
 */
export interface SupplierOrderLine {
  /** Mercaria's own purchase-order LINE id — the reference an outcome names. */
  clientLineReference: string;
  supplierSku: string;
  quantity: number;
  expectedUnitCost: Money;
  expectedLineTotal: Money;
  description: string | null;
}

/**
 * Everything a provider is given to create one order (#124 provider-neutral
 * type 4).
 *
 * `clientReference` is Mercaria's unique reference for this purchase order and
 * is what makes a repeat converge: a provider that honours idempotency keys
 * gets it as one, a provider that does not gets it as a searchable field, and
 * the ambiguity converger looks the order up by it before any retry.
 *
 * There is deliberately NO provider account id and no environment here. Both
 * are properties of the supplier ACCOUNT the call is made against, resolved by
 * the one chokepoint that makes provider calls, and a draft carrying its own
 * copies would be a second answer to a question `supplier_accounts` already
 * answers — the two could disagree, and the direction they would disagree in is
 * a test draft submitted against a live account. Keeping them out also keeps
 * them out of the request digest, so the digest answers exactly one question:
 * is this the same ORDER as last time.
 */
export interface SupplierOrderDraft {
  clientReference: string;
  currency: CurrencyCode;
  lines: readonly SupplierOrderLine[];
  destination: SupplierDestination;
  /** The service the preflight quoted, when one was pinned. */
  shippingServiceCode: string | null;
  /** The #122 quote this order was priced from, when the provider tracks one. */
  quoteReference: string | null;
  /** The supplier's own hold, when one was taken and is still live. */
  reservationReference: string | null;
  /** What Mercaria expects the whole order to cost, from the same quote. */
  expectedTotal: Money;
}

/** One line's outcome, as the provider reported it. */
export type SupplierOrderLineOutcomeKind =
  | 'accepted'
  | 'rejected'
  | 'shipped'
  | 'cancelled'
  | 'returned';

/** {@link SupplierOrderLineOutcomeKind} as the tuple the columns and CHECKs read. */
export const SUPPLIER_ORDER_LINE_OUTCOME_KINDS: readonly SupplierOrderLineOutcomeKind[] = [
  'accepted',
  'rejected',
  'shipped',
  'cancelled',
  'returned',
];

/**
 * Line-level provider evidence — what makes a partial acceptance, a partial
 * shipment and a partial cancellation different from a guess (#124 cancellation
 * 6).
 *
 * Only an adapter declaring `order_partial_acceptance` may produce an
 * `accepted`/`rejected` split; everything else is `assumed_partial_acceptance`
 * and is removed at the capability boundary.
 */
export interface SupplierOrderLineOutcome {
  clientLineReference: string;
  kind: SupplierOrderLineOutcomeKind;
  quantity: number;
  reasonCode: PurchaseOrderReasonCode | null;
}

/**
 * What a provider said when Mercaria submitted an order (#124 provider-neutral
 * type 5).
 *
 * `duplicateOfExistingOrder` is the provider telling us it recognised the
 * client reference and returned the order it already had — the outcome an
 * idempotency key is FOR, and a fact worth recording because it is also how a
 * successful convergence after an ambiguous attempt is distinguished from a
 * second order having been placed.
 */
export interface SupplierOrderSubmission {
  /** The provider's own order id, when it minted one. Never a Mercaria key. */
  externalOrderId: string | null;
  state: SupplierOrderNormalizedState;
  /** The provider's own status string, verbatim, for the operator trace. */
  providerState: string;
  /** Which version of this adapter's mapping produced {@link state}. */
  stateMappingVersion: number;
  /** The provider's own timestamp for this observation, ISO-8601. */
  observedAt: string;
  reasonCode: PurchaseOrderReasonCode | null;
  providerMessage: string | null;
  /** What the provider says the order costs — reconciled, never applied. */
  total: Money | null;
  lineOutcomes: readonly SupplierOrderLineOutcome[];
  duplicateOfExistingOrder: boolean;
}

/**
 * One parcel's contents, as the provider describes it (#124 provider-neutral
 * type 7).
 *
 * `lineQuantities` is what makes a partial shipment line-level evidence rather
 * than a guess from the parcel count.
 */
export interface SupplierPackage {
  packageReference: string | null;
  weightGrams: number | null;
  lineQuantities: readonly { clientLineReference: string; quantity: number }[];
}

/** A carrier scan. Location is COARSE — see the module docblock. */
export type SupplierTrackingStatus =
  | 'label_created'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'delivery_exception'
  | 'returned_to_sender';

/** {@link SupplierTrackingStatus} as the tuple the columns and CHECKs read. */
export const SUPPLIER_TRACKING_STATUSES: readonly SupplierTrackingStatus[] = [
  'label_created',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'delivery_exception',
  'returned_to_sender',
];

/** One carrier scan (#124 provider-neutral type 8). */
export interface SupplierTrackingEvent {
  status: SupplierTrackingStatus;
  /** The carrier's own timestamp, ISO-8601 — the ordering key. */
  occurredAt: string;
  description: string | null;
  /** ISO-3166-1 alpha-2. Coarse deliberately. */
  locationCountry: string | null;
  locationRegion: string | null;
}

/** One parcel (#124 provider-neutral type 7). */
export interface SupplierShipment {
  shipmentReference: string | null;
  trackingNumber: string;
  carrier: string | null;
  service: string | null;
  shippedAt: string;
  deliveredAt: string | null;
  packages: readonly SupplierPackage[];
  trackingEvents: readonly SupplierTrackingEvent[];
}

/**
 * One order as the provider currently sees it (#124 provider-neutral type 6).
 *
 * The submission's shape plus what only a READ can carry: the parcels, and
 * whether the provider says it can still be cancelled. `cancellable` is the
 * answer to cancellation item 1 and is the provider's, never inferred from a
 * state — several providers accept a cancellation on a `processing` order and
 * refuse it on one whose label was printed, and no state name distinguishes
 * those.
 */
export interface SupplierOrderState extends SupplierOrderSubmission {
  shipments: readonly SupplierShipment[];
  cancellable: boolean;
}

/**
 * The four distinct outcomes of asking a provider to cancel (#124 cancellation
 * 3).
 *
 * `ambiguous` is a genuine answer and is kept apart from `rejected` because
 * they route in opposite directions: a rejection means the goods are coming and
 * #127's return path applies, while an ambiguity means nobody knows and asking
 * again is the correct next act.
 */
export type SupplierCancellationState = 'requested' | 'accepted' | 'rejected' | 'ambiguous';

/** {@link SupplierCancellationState} as the tuple guards and tests read. */
export const SUPPLIER_CANCELLATION_STATES: readonly SupplierCancellationState[] = [
  'requested',
  'accepted',
  'rejected',
  'ambiguous',
];

/** What a provider said about a cancellation (#124 provider-neutral type 9). */
export interface SupplierCancellation {
  state: SupplierCancellationState;
  reasonCode: PurchaseOrderReasonCode | null;
  providerMessage: string | null;
  observedAt: string;
  /** Line-level evidence, where the provider cancels part of an order. */
  lineOutcomes: readonly SupplierOrderLineOutcome[];
}

/** Where a supplier RMA stands (#124 provider-neutral type 10). */
export type SupplierReturnState = 'requested' | 'authorized' | 'rejected' | 'received' | 'closed';

/** {@link SupplierReturnState} as the tuple guards and tests read. */
export const SUPPLIER_RETURN_STATES: readonly SupplierReturnState[] = [
  'requested',
  'authorized',
  'rejected',
  'received',
  'closed',
];

/** One supplier RMA. The CUSTOMER-facing return is #127's and is a different thing. */
export interface SupplierReturn {
  returnReference: string;
  state: SupplierReturnState;
  /** The provider's own reason string, redacted and bounded by the caller. */
  providerReason: string | null;
  observedAt: string;
  lineOutcomes: readonly SupplierOrderLineOutcome[];
  /** Whether the supplier supplied a return label. Never a URL — see the docblock. */
  returnLabelProvided: boolean;
}

/** A supplier document Mercaria is billed or credited by. */
export type SupplierDocumentKind = 'invoice' | 'credit_note';

/** {@link SupplierDocumentKind} as the tuple the columns and CHECKs read. */
export const SUPPLIER_DOCUMENT_KINDS: readonly SupplierDocumentKind[] = ['invoice', 'credit_note'];

/**
 * The B2B invoice for one purchase order (#124 provider-neutral type 11).
 *
 * Metadata only. #128 reconciles it against the purchase order one-to-one (ADR
 * 0004 D6.6); nothing here books anything, and there is no field for the
 * document's bytes or a link to them.
 */
export interface SupplierInvoice {
  documentReference: string;
  documentNumber: string | null;
  currency: CurrencyCode;
  /** Minor units, in {@link currency}. */
  totalAmount: number;
  taxAmount: number | null;
  issuedAt: string;
}

/** A credit note against a purchase order — the same shape, pointing at what it reverses. */
export interface SupplierCredit extends SupplierInvoice {
  relatedInvoiceReference: string | null;
}

/**
 * The six classes every provider failure is normalized into (#124
 * provider-neutral type 12).
 *
 *  - `retryable` — a transport failure, a 5xx, a lock contention.
 *  - `terminal` — the provider refused and will refuse again.
 *  - `auth` — the credential was rejected. Retrying with it cannot help.
 *  - `quota` — a rate limit or a daily cap. Retryable, later.
 *  - `validation` — the request was malformed or the data was refused.
 *  - `unknown` — the adapter could not classify it, which is retryable
 *    precisely because assuming otherwise turns a transient fault into a lost
 *    order.
 */
export type SupplierProviderErrorClass =
  | 'retryable'
  | 'terminal'
  | 'auth'
  | 'quota'
  | 'validation'
  | 'unknown';

/** {@link SupplierProviderErrorClass} as the tuple the columns and CHECKs read. */
export const SUPPLIER_PROVIDER_ERROR_CLASSES: readonly SupplierProviderErrorClass[] = [
  'retryable',
  'terminal',
  'auth',
  'quota',
  'validation',
  'unknown',
];

/**
 * The retry guidance each class carries — a TABLE, not a switch in a service.
 *
 * `auth` is not retryable, which is the entry worth defending: a rejected
 * credential retried on a backoff burns the account's rate budget and, on some
 * providers, locks it. Rotating the credential is an operator act and the
 * exception row says so. `unknown` IS retryable for the opposite reason: an
 * unclassified failure is far more often a transport fault than a refusal, and
 * a purchase order that a customer has already paid for must not be abandoned
 * because an adapter did not recognise a status code.
 */
export const SUPPLIER_PROVIDER_ERROR_RETRYABLE: Record<SupplierProviderErrorClass, boolean> = {
  retryable: true,
  terminal: false,
  auth: false,
  quota: true,
  validation: false,
  unknown: true,
};

/**
 * A normalized provider failure, with the one fact that decides ambiguity.
 *
 * `afterWrite` is the load-bearing field: a connection that was refused sent
 * nothing, so a retry is free, while a request whose bytes went out and whose
 * response never came back may have created an order. #124 idempotency item 4
 * ("treat `request timed out after write` as ambiguous rather than failed") is
 * this boolean — and it is the ADAPTER's to set, because only the code holding
 * the socket knows which side of the write the failure fell on.
 */
export interface SupplierProviderFailure {
  errorClass: SupplierProviderErrorClass;
  /** Whether the request may already have been applied at the provider. */
  afterWrite: boolean;
  /** The provider's own error code, when it gives one. */
  providerCode: string | null;
  /** Earliest a retry may be attempted, when the provider stated one. */
  retryAfterMs: number | null;
  /** The provider's message. Redacted and bounded before it is stored. */
  message: string;
}

/** Which provider call an attempt row records. */
export type SupplierOrderOperation =
  | 'draft_validate'
  | 'submit'
  | 'reference_lookup'
  | 'read'
  | 'cancel'
  | 'shipments'
  | 'invoice'
  | 'credit_note'
  | 'return_create'
  | 'return_read';

/** {@link SupplierOrderOperation} as the tuple the columns and CHECKs read. */
export const SUPPLIER_ORDER_OPERATIONS: readonly SupplierOrderOperation[] = [
  'draft_validate',
  'submit',
  'reference_lookup',
  'read',
  'cancel',
  'shipments',
  'invoice',
  'credit_note',
  'return_create',
  'return_read',
];

/**
 * How one provider call ended.
 *
 * `refused` is the framework declining to make the call at all — a kill switch,
 * a missing capability, an exhausted provider lease — and it is recorded rather
 * than skipped, because "we never asked" and "we asked and it failed" lead an
 * operator to opposite conclusions. `converged` is the lookup that resolved an
 * earlier ambiguity, which is a different fact from the `succeeded` call that
 * created something.
 */
export type SupplierOrderAttemptOutcome =
  | 'in_flight'
  | 'succeeded'
  | 'failed'
  | 'ambiguous'
  | 'converged'
  | 'refused';

/** {@link SupplierOrderAttemptOutcome} as the tuple the columns and CHECKs read. */
export const SUPPLIER_ORDER_ATTEMPT_OUTCOMES: readonly SupplierOrderAttemptOutcome[] = [
  'in_flight',
  'succeeded',
  'failed',
  'ambiguous',
  'converged',
  'refused',
];

/** Why the framework refused to make a provider call. */
export type SupplierOrderRefusalReason =
  | 'provider_unconfigured'
  | 'capability_not_declared'
  | 'account_not_active'
  | 'account_kill_switched'
  | 'supplier_suppressed'
  | 'credential_not_valid'
  | 'provider_fetch_disabled'
  | 'provider_lease_unavailable'
  | 'payment_not_authorized'
  | 'environment_refused';

/** {@link SupplierOrderRefusalReason} as the tuple the columns and CHECKs read. */
export const SUPPLIER_ORDER_REFUSAL_REASONS: readonly SupplierOrderRefusalReason[] = [
  'provider_unconfigured',
  'capability_not_declared',
  'account_not_active',
  'account_kill_switched',
  'supplier_suppressed',
  'credential_not_valid',
  'provider_fetch_disabled',
  'provider_lease_unavailable',
  'payment_not_authorized',
  'environment_refused',
];

/** How a provider event reached Mercaria. */
export type SupplierEventDelivery = 'webhook' | 'poll' | 'operator_probe';

/** {@link SupplierEventDelivery} as the tuple the columns and CHECKs read. */
export const SUPPLIER_EVENT_DELIVERIES: readonly SupplierEventDelivery[] = [
  'webhook',
  'poll',
  'operator_probe',
];

/**
 * How a provider event's authenticity was established.
 *
 * There is deliberately NO `unverified` member, and that absence is #124
 * polling-and-webhooks item 8 ("do not mark shipment or delivery from an
 * unverified client callback") made structural: an unverified callback has no
 * row shape, so it cannot be stored now and applied later by a sweep that never
 * re-checked. The ingress refuses it, counts it and logs it, and an operator
 * sees the count — the `STRIPE_ENABLED` mount rule, which refuses bytes it
 * cannot verify rather than storing a stranger's opinion.
 */
export type SupplierEventVerification =
  | 'signature'
  | 'shared_secret'
  | 'mutual_tls'
  | 'authenticated_poll';

/** {@link SupplierEventVerification} as the tuple the columns and CHECKs read. */
export const SUPPLIER_EVENT_VERIFICATIONS: readonly SupplierEventVerification[] = [
  'signature',
  'shared_secret',
  'mutual_tls',
  'authenticated_poll',
];

/** Where one stored provider event stands in its processing. */
export type SupplierEventStatus = 'received' | 'processing' | 'processed' | 'failed' | 'dead_letter';

/** {@link SupplierEventStatus} as the tuple the columns and CHECKs read. */
export const SUPPLIER_EVENT_STATUSES: readonly SupplierEventStatus[] = [
  'received',
  'processing',
  'processed',
  'failed',
  'dead_letter',
];

/**
 * The ALLOW-LIST of keys a provider payload may contribute to a stored summary.
 *
 * `services/payments/redact.ts` is the precedent and `CATALOG_SOURCE_PAYLOAD_FIELDS`
 * (#62) is the nearer one. A deny-list is correct only until the provider adds
 * a field, and a fulfilment API's next field is very often the recipient's name
 * or phone number, because that is what a fulfilment API is about. Nothing in
 * this list can hold an address, a person or a credential.
 */
export const SUPPLIER_EVENT_PAYLOAD_FIELDS: readonly string[] = [
  'eventType',
  'clientReference',
  'externalOrderId',
  'orderStatus',
  'occurredAt',
  'currency',
  'totalMinor',
  'lineCount',
  'reasonCode',
  'shipmentCount',
  'trackingNumbers',
  'carrier',
  'service',
  'cancellationState',
  'returnReference',
  'returnState',
  'documentKind',
  'documentNumber',
  'documentTotalMinor',
];

/**
 * The conditions only a person can close (#124 idempotency 5, observability
 * 3/6/10).
 *
 * The `payment_discrepancies` relationship: a row here is a RECORDING, and
 * every kind has an idempotent remedy an operator drives rather than a repair
 * this domain performs on its own.
 */
export type ProcurementExceptionKind =
  | 'ambiguous_submission'
  | 'unconverged_submission'
  | 'duplicate_external_order'
  | 'provider_state_regression'
  | 'unmapped_provider_state'
  | 'late_acceptance_after_cancellation'
  | 'shipment_after_cancellation'
  | 'webhook_poll_disagreement'
  | 'event_lag_sla_breach'
  | 'stuck_purchase_order'
  | 'credential_rejected'
  | 'quota_exhausted'
  | 'substitution_detected'
  | 'capability_not_declared'
  | 'cost_mismatch';

/** {@link ProcurementExceptionKind} as the tuple the columns and CHECKs read. */
export const PROCUREMENT_EXCEPTION_KINDS: readonly ProcurementExceptionKind[] = [
  'ambiguous_submission',
  'unconverged_submission',
  'duplicate_external_order',
  'provider_state_regression',
  'unmapped_provider_state',
  'late_acceptance_after_cancellation',
  'shipment_after_cancellation',
  'webhook_poll_disagreement',
  'event_lag_sla_breach',
  'stuck_purchase_order',
  'credential_rejected',
  'quota_exhausted',
  'substitution_detected',
  'capability_not_declared',
  'cost_mismatch',
];

/**
 * The exception kinds that STOP fulfilment and payment escalation (#124
 * idempotency 7).
 *
 * A duplicate supplier order and a substitution are the two where continuing is
 * actively harmful: the first means Mercaria is being billed twice for goods
 * one customer ordered once, the second means a supplier shipped something the
 * customer did not choose (ADR 0004 D9.5 — never a success). Raising either
 * marks the purchase order for operator intervention, which is what
 * `purchase_orders.operator_intervention_required` already means.
 */
export const PROCUREMENT_HALTING_EXCEPTION_KINDS: readonly ProcurementExceptionKind[] = [
  'duplicate_external_order',
  'substitution_detected',
  'late_acceptance_after_cancellation',
  'shipment_after_cancellation',
];

/** How an operator closed a procurement exception. */
export type ProcurementExceptionResolution =
  | 'converged'
  | 'duplicate_confirmed'
  | 'operator_cancelled'
  | 'operator_accepted'
  | 'provider_corrected'
  | 'no_action_required'
  | 'escalated';

/** {@link ProcurementExceptionResolution} as the tuple the columns and CHECKs read. */
export const PROCUREMENT_EXCEPTION_RESOLUTIONS: readonly ProcurementExceptionResolution[] = [
  'converged',
  'duplicate_confirmed',
  'operator_cancelled',
  'operator_accepted',
  'provider_corrected',
  'no_action_required',
  'escalated',
];

/**
 * The durable jobs the procurement orchestration runs on.
 *
 * The `payment_outboxes` vocabulary, one domain over: the row IS the job, its
 * id is derived from the fact rather than generated, and a repeat converges on
 * it instead of queueing the work twice.
 */
export type ProcurementOutboxEventType =
  | 'purchase_order_submission'
  | 'purchase_order_cancellation'
  | 'purchase_order_status_poll'
  | 'purchase_order_convergence'
  | 'purchase_order_accepted'
  | 'purchase_order_rejected'
  | 'purchase_order_exception';

/** {@link ProcurementOutboxEventType} as the tuple the columns and CHECKs read. */
export const PROCUREMENT_OUTBOX_EVENT_TYPES: readonly ProcurementOutboxEventType[] = [
  'purchase_order_submission',
  'purchase_order_cancellation',
  'purchase_order_status_poll',
  'purchase_order_convergence',
  'purchase_order_accepted',
  'purchase_order_rejected',
  'purchase_order_exception',
];

/** Where one procurement outbox row stands. */
export type ProcurementOutboxStatus = 'pending' | 'processing' | 'processed' | 'dead_letter';

/** {@link ProcurementOutboxStatus} as the tuple the columns and CHECKs read. */
export const PROCUREMENT_OUTBOX_STATUSES: readonly ProcurementOutboxStatus[] = [
  'pending',
  'processing',
  'processed',
  'dead_letter',
];

/**
 * Why a purchase order may not be submitted to a supplier yet (#124 submission
 * orchestration 2).
 *
 * The vocabulary #123 answers in. Every member is a REFUSAL: there is no
 * `authorized` value here, because authorization is the other branch of a
 * discriminated union and cannot be spelled as a reason.
 */
export type ProcurementAuthorizationRefusal =
  | 'authorization_reader_not_registered'
  | 'order_not_found'
  | 'order_not_retail'
  | 'order_not_paid'
  | 'payment_not_captured'
  | 'order_cancelled'
  | 'order_on_moderation_hold';

/** {@link ProcurementAuthorizationRefusal} as the tuple guards and tests read. */
export const PROCUREMENT_AUTHORIZATION_REFUSALS: readonly ProcurementAuthorizationRefusal[] = [
  'authorization_reader_not_registered',
  'order_not_found',
  'order_not_retail',
  'order_not_paid',
  'payment_not_captured',
  'order_cancelled',
  'order_on_moderation_hold',
];

/**
 * Whether a paid, captured retail order authorizes supplier submission.
 *
 * A discriminated union with no common field, the `CommerceActor` rule (ADR
 * 0003 I1) applied to money: a caller cannot read `paymentId` without having
 * established that the answer was `authorized`.
 */
export type ProcurementSubmissionAuthorization =
  | { authorized: true; orderId: string; paymentId: string; capturedAt: string }
  | { authorized: false; reason: ProcurementAuthorizationRefusal };
