/**
 * Supplier-fulfilled Mercaria-retail fulfilment (#126, ADR 0004 D9.4/D9.6/D9.9,
 * D2.7, D10).
 *
 * One coherent customer order while an approved supplier prepares or dispatches
 * the goods and **Moovo owns the physical logistics**. This file is the half
 * Mercaria owns: the immutable order-role snapshot, the mapping from customer
 * order lines to fulfilment intent, who controls the transport booking, and the
 * delivery promise a buyer accepted.
 *
 * ## What is deliberately ABSENT, and why the absence is the design
 *
 * #126 acceptance 2 is *"Mercaria contains no carrier adapter, tracking poller
 * or carrier-state mapping for this flow"*. So there is no member here that
 * names a carrier, a carrier service level, a package, a parcel dimension, a
 * label, a manifest, a proof-of-delivery reference or a carrier scan status —
 * and no type into which one could be put. {@link RETAIL_FULFILMENT_FORBIDDEN_FACTS}
 * states the prohibition as VALUES disjoint from everything this vocabulary
 * records, so a future addition under a plausible name fails a test rather than
 * passing review (the `RetailForbiddenComponentKind` device, #120).
 *
 * The reason is not tidiness. A carrier status vocabulary in Mercaria is a
 * SECOND normalization of the same physical event, and two normalizations of
 * one fact disagree in the direction nobody notices: Moovo says
 * `awaiting_collection` and Mercaria's copy says `shipped`, so a buyer is told
 * their parcel is on its way while it sits on a supplier's bench.
 *
 * ## Two modes, ONE column
 *
 * #126 §"Immutable order-role snapshot" lists *"Fulfilment mode and who
 * controls booking"* as one numbered item, and they are one fact:
 * {@link RETAIL_FULFILMENT_MODES} names WHO BOOKS. A separate
 * `transportController` column would be a second spelling of the same answer,
 * and the house rule is that two representations of one fact eventually
 * disagree.
 *
 * ## Permitted is not chosen
 *
 * What the supply agreement PERMITS is knowable at checkout and immutable
 * afterwards; which mode is actually USED cannot be known until a supplier has
 * accepted and confirmed package readiness (#126 Mode A step 2). Those are two
 * different facts with two different clocks, so they are two columns —
 * {@link RetailPermittedFulfilmentMode} frozen at purchase, and
 * {@link RetailFulfilmentMode} written exactly once when transport is actually
 * arranged. Collapsing them would either freeze a mode nobody could yet know or
 * leave the contractual grant rewritable after the sale.
 */

/**
 * Who books the transport — #126's two supplier-to-Moovo fulfilment modes.
 *
 *  - `moovo_controlled` (Mode A) — Moovo books the fleet or carrier and
 *    produces the label; the supplier receives only the label and the dispatch
 *    instructions. Requires a contractual grant, because it puts a Mercaria
 *    logistics document into a third party's warehouse.
 *  - `supplier_controlled` (Mode B) — the supplier books its own carrier and
 *    reports dispatch facts; Mercaria registers a TRACKING-ONLY transport with
 *    Moovo so the buyer timeline still has one authority.
 *
 * There is no third member and no `unknown`. An undecided mode is the ABSENCE
 * of a value (a NULL column, an `undecided` branch of
 * {@link RetailFulfilmentModeDecision}) rather than a value that could be
 * stored and later read as a decision somebody made.
 */
export const RETAIL_FULFILMENT_MODES = ['moovo_controlled', 'supplier_controlled'] as const;
export type RetailFulfilmentMode = (typeof RETAIL_FULFILMENT_MODES)[number];

/**
 * What the supply agreement permitted at the moment of purchase.
 *
 * A superset of {@link RETAIL_FULFILMENT_MODES} plus `either`, and deliberately
 * with NO `neither`: an order whose agreement permits no fulfilment path at all
 * cannot be placed, so a snapshot recording one would describe a sale that
 * never happened. The refusal lives at checkout, where the buyer can act on it.
 */
export const RETAIL_PERMITTED_FULFILMENT_MODES = [
  'moovo_controlled',
  'supplier_controlled',
  'either',
] as const;
export type RetailPermittedFulfilmentMode = (typeof RETAIL_PERMITTED_FULFILMENT_MODES)[number];

/**
 * Why no fulfilment mode is permitted — the refusal half of the determination.
 *
 * Each names a CONTRACTUAL fact, never a live logistics one: this decision is
 * taken at checkout against a versioned agreement, and a decision that read a
 * carrier's availability would be a different decision taken at a different
 * time.
 */
export const RETAIL_FULFILMENT_MODE_REFUSALS = [
  /** The agreement grants neither dropship dispatch nor Moovo label dispatch. */
  'no_dispatch_right_granted',
  /** The agreement is not approved, has lapsed, or does not cover the destination. */
  'agreement_not_in_force',
] as const;
export type RetailFulfilmentModeRefusal = (typeof RETAIL_FULFILMENT_MODE_REFUSALS)[number];

/** What the agreement permits, or why it permits nothing. */
export type RetailFulfilmentModeDecision =
  | { outcome: 'permitted'; permitted: RetailPermittedFulfilmentMode }
  | { outcome: 'refused'; reason: RetailFulfilmentModeRefusal };

/**
 * Why a mode cannot yet be CHOSEN even though one is permitted.
 *
 * Every member is a missing fact rather than a failure, which is what keeps
 * `undecided` from reading as an error an operator should act on. A retail
 * order sits here for as long as it takes a supplier to accept and confirm what
 * it is about to hand over, which is ordinary.
 */
export const RETAIL_FULFILMENT_MODE_UNDECIDED_REASONS = [
  /** Mode A needs verified package facts (#126 Mode A requirement 2). */
  'package_facts_unverified',
  /** Mode A needs a Moovo booking path (#156/#159). */
  'moovo_booking_unavailable',
  /** The supplier has not accepted the purchase order yet. */
  'procurement_not_accepted',
] as const;
export type RetailFulfilmentModeUndecidedReason =
  (typeof RETAIL_FULFILMENT_MODE_UNDECIDED_REASONS)[number];

/** Which mode is actually used, or why that is not yet answerable. */
export type RetailFulfilmentModeChoice =
  | { outcome: 'chosen'; mode: RetailFulfilmentMode }
  | { outcome: 'undecided'; reason: RetailFulfilmentModeUndecidedReason };

/**
 * The state of Mercaria's COMMERCIAL intent to fulfil these lines this way.
 *
 * Read the members and notice what is not among them: nothing here says
 * `shipped`, `in_transit`, `out_for_delivery` or `delivered`. Those describe
 * where a parcel physically is, which Moovo owns and which this domain projects
 * rather than stores (#126 §"State separation" example 1: *supplier accepted
 * does not mean shipped*). {@link RETAIL_FULFILMENT_FORBIDDEN_INTENT_STATUSES}
 * names them as prohibitions, disjoint from this tuple by a test.
 *
 *  - `planned` — the allocation exists; nothing has been handed anywhere.
 *  - `active` — the intent has been handed to its transport path.
 *  - `superseded` — a replacement intent took over these quantities.
 *  - `cancelled` — Mercaria withdrew the intent; the allocation no longer
 *    consumes the order line's quantity.
 *  - `closed` — the obligation is discharged.
 */
export const RETAIL_FULFILMENT_INTENT_STATUSES = [
  'planned',
  'active',
  'superseded',
  'cancelled',
  'closed',
] as const;
export type RetailFulfilmentIntentStatus = (typeof RETAIL_FULFILMENT_INTENT_STATUSES)[number];

/**
 * Statuses this domain may never grow, because each asserts a PHYSICAL fact
 * Moovo owns. Disjoint from {@link RETAIL_FULFILMENT_INTENT_STATUSES} by test.
 */
export const RETAIL_FULFILMENT_FORBIDDEN_INTENT_STATUSES = [
  'shipped',
  'dispatched',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'returned_to_sender',
  'label_created',
  'picked_up',
] as const;
export type RetailFulfilmentForbiddenIntentStatus =
  (typeof RETAIL_FULFILMENT_FORBIDDEN_INTENT_STATUSES)[number];

/**
 * Facts this domain may never record, because recording one would be Mercaria
 * building the carrier system #126 acceptance 2 forbids.
 *
 * Disjoint from every vocabulary in this file by test — the
 * `RETAIL_FORBIDDEN_COMPONENT_KIND` device. They are not merely "fields we did
 * not add": each is the first column of a second carrier integration, and the
 * cheapest moment to refuse one is before it has a name somebody defends.
 */
export const RETAIL_FULFILMENT_FORBIDDEN_FACTS = [
  'carrier_account',
  'carrier_api_credential',
  'carrier_service_code',
  'carrier_scan_status',
  'package_dimensions',
  'package_weight',
  'shipping_label_document',
  'carrier_manifest',
  'proof_of_delivery_document',
  'tracking_poll_cursor',
] as const;
export type RetailFulfilmentForbiddenFact = (typeof RETAIL_FULFILMENT_FORBIDDEN_FACTS)[number];

/**
 * Whether an allocation is the original obligation or a replacement of it.
 *
 * The distinction is load-bearing arithmetic rather than a label: an `original`
 * allocation CONSUMES an order line's quantity and the sum of them may never
 * exceed it (#126 fulfilment mapping 8, *"reconciliation preventing duplicate
 * or lost line allocation"*), while a `replacement` re-ships goods that were
 * already allocated and must therefore NOT count toward that cap. Folding them
 * together makes every replacement look like an over-allocation, and the
 * obvious fix — raising the cap — makes a genuine double-ship invisible.
 */
export const RETAIL_FULFILMENT_INTENT_KINDS = ['original', 'replacement'] as const;
export type RetailFulfilmentIntentKind = (typeof RETAIL_FULFILMENT_INTENT_KINDS)[number];

/**
 * What a delivery-promise observation is ABOUT (#126 §"Delivery promises and
 * estimates" 1–3).
 *
 *  - `accepted_at_checkout` — the promise the buyer agreed to. Exactly one per
 *    order, immutable, and never overwritten by a later estimate: #126 rule 9
 *    is *"never silently rewrite past promises"*.
 *  - `supplier_handling` — how long the supplier says it needs before dispatch.
 *  - `supplier_dispatch` — when the supplier says it dispatched or will.
 *  - `logistics_estimate` — Moovo's transport estimate. Mercaria records the
 *    observation; Moovo owns the estimate and its history (#126 rule 3).
 */
export const RETAIL_DELIVERY_PROMISE_KINDS = [
  'accepted_at_checkout',
  'supplier_handling',
  'supplier_dispatch',
  'logistics_estimate',
] as const;
export type RetailDeliveryPromiseKind = (typeof RETAIL_DELIVERY_PROMISE_KINDS)[number];

/** Who said it (#126 §"Delivery promises" 7: record source and observation time). */
export const RETAIL_DELIVERY_PROMISE_SOURCES = [
  'mercaria_checkout',
  'supplier_adapter',
  'moovo_logistics',
  'operator',
] as const;
export type RetailDeliveryPromiseSource = (typeof RETAIL_DELIVERY_PROMISE_SOURCES)[number];

/**
 * How strong the statement is.
 *
 * #126 rule 5: *"do not present supplier SLA as guaranteed customer delivery
 * without policy support"*. A supplier's stated SLA arrives as `advisory` and
 * only Mercaria's own accepted promise may be `guaranteed`; there is no code
 * path that upgrades one, which is the #122 downgrade rule pointed at a
 * promise.
 */
export const RETAIL_DELIVERY_PROMISE_BASES = ['guaranteed', 'advisory'] as const;
export type RetailDeliveryPromiseBasis = (typeof RETAIL_DELIVERY_PROMISE_BASES)[number];

/**
 * What the observation attempt produced.
 *
 * `refresh_failed` is a first-class OUTCOME rather than an absence, because
 * #126 rule 6 requires estimates to be *marked stale when supplier or Moovo
 * updates fail* — and the only way an append-only trail can say "we asked and
 * could not find out" is to record that we asked. An outcome that is not
 * `observed` carries NO window at all: rule 10 is *"unknown cost/estimate is
 * not zero/on time"*, and the enforcement is that there is no column to put a
 * zero in.
 */
export const RETAIL_DELIVERY_OBSERVATION_OUTCOMES = [
  'observed',
  'unknown',
  'refresh_failed',
] as const;
export type RetailDeliveryObservationOutcome =
  (typeof RETAIL_DELIVERY_OBSERVATION_OUTCOMES)[number];

/**
 * The seller of record on a `mercaria_retail` order — ONE member, forever.
 *
 * ADR 0004's responsibility matrix puts the contract of sale, the receipt, the
 * customer terms and every consumer right on Mercaria, and the supply agreement
 * cannot move any of them. A second member would make "the supplier is the
 * seller" a storable claim, and the first place it would be read is a customer
 * receipt.
 */
export const RETAIL_SELLERS_OF_RECORD = ['mercaria'] as const;
export type RetailSellerOfRecord = (typeof RETAIL_SELLERS_OF_RECORD)[number];

/**
 * The seven states #126 §"State separation" requires to stay distinct, named
 * exactly as the issue names them.
 *
 * They are an ENUM rather than seven fields on one object so that
 * {@link RetailFulfilmentStateView} can be indexed exhaustively and a new axis
 * fails `tsc` at every reader — the arrangement that stops somebody adding an
 * eighth axis and having six surfaces silently ignore it.
 */
export const RETAIL_FULFILMENT_STATE_AXES = [
  'customer_order_payment',
  'supplier_procurement',
  'preparation_fulfilment',
  'transport_projection',
  'return_authorization',
  'return_transport',
  'refund_reconciliation',
] as const;
export type RetailFulfilmentStateAxis = (typeof RETAIL_FULFILMENT_STATE_AXES)[number];

/**
 * One axis's answer.
 *
 * The `known: false` branch has NO `state` property, so a surface cannot read
 * an unknown axis as a state at all — #126 §"State separation" example 5,
 * *"unknown supplier or Moovo state remains unknown/stale"*, held by the type
 * rather than by a sentinel value everyone must remember not to display.
 */
export type RetailFulfilmentAxisState =
  | { known: true; state: string; observedAt: string; stale: boolean }
  | { known: false; reason: string };

/** All seven axes, each derived from its own source and none from another's. */
export type RetailFulfilmentStateView = {
  readonly [K in RetailFulfilmentStateAxis]: RetailFulfilmentAxisState;
};

/**
 * The coarse transport states Mercaria may PROJECT from Moovo (#157's
 * projection, read through the port).
 *
 * They are listed here because a projection needs a vocabulary to be projected
 * into, and they are deliberately COARSE — a buyer-facing summary rather than a
 * carrier state machine. Mercaria never maps a carrier's own status string into
 * one; Moovo does that (its ownership item 5, *"versioned carrier status
 * normalization"*) and hands over the result. That distinction is what makes
 * this list not a violation of acceptance 2, and it is why every member is a
 * word a buyer would use rather than a carrier scan code.
 */
export const MOOVO_TRANSPORT_PROJECTION_STATES = [
  'not_created',
  'requested',
  'label_created',
  'awaiting_collection',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'returned_to_sender',
  'cancelled',
] as const;
export type MoovoTransportProjectionState = (typeof MOOVO_TRANSPORT_PROJECTION_STATES)[number];

/**
 * What Mercaria reads back from Moovo about one transport.
 *
 * A TYPE and not a table. #157 owns the aggregate and its persistence, #158 the
 * events that keep it current; #126 owns only the READ contract, so that the
 * state derivation and the customer projection can be written, tested and
 * reviewed before either exists. Materialising a table nobody can populate
 * would be a second source of truth for a fact Mercaria does not hold.
 *
 * `freshness` is the observation's age as Moovo reports it. `stale` is derived
 * against the reader's clock rather than stored, so a projection that stopped
 * being refreshed degrades on its own instead of waiting for a sweep.
 */
export interface MoovoTransportProjection {
  transportRequestId: string;
  state: MoovoTransportProjectionState;
  /** ISO-8601. When Moovo last confirmed this state. */
  observedAt: string;
  /** Moovo's own version/checkpoint, so a reader can tell two reads apart. */
  sourceVersion: number;
  /** How many shipments Moovo holds for this transport. A COUNT, never contents. */
  shipmentCount: number;
  /** ISO-8601 window, absent when Moovo has no estimate. Never a zero. */
  estimatedEarliestAt?: string;
  estimatedLatestAt?: string;
}

/** The Moovo operations #126 needs and #156/#157/#159 will implement. */
export const MOOVO_LOGISTICS_OPERATIONS = [
  'register_tracking_only_transport',
  'book_transport',
  'read_transport_projection',
  'cancel_transport',
  'request_return_transport',
] as const;
export type MoovoLogisticsOperation = (typeof MOOVO_LOGISTICS_OPERATIONS)[number];

/**
 * Why a Moovo operation produced nothing.
 *
 * Every member is a reason a caller must treat as *unknown*, never as *no* —
 * the #122 rule that every downgrade lands on the value that BLOCKS. A refused
 * booking is not a booking that will not happen; it is a booking Mercaria
 * cannot currently make, and a customer-facing surface that read it as the
 * former would tell a buyer their order is not shipping.
 */
export const MOOVO_UNAVAILABLE_REASONS = [
  /** No port is registered — the shipped state until #156 lands. */
  'client_not_registered',
  /** A port is registered and this operation is not implemented by it. */
  'operation_not_supported',
  /** Moovo answered, and could not serve this request. */
  'provider_refused',
  /** Moovo did not answer within the caller's bound. */
  'provider_unreachable',
] as const;
export type MoovoUnavailableReason = (typeof MOOVO_UNAVAILABLE_REASONS)[number];

/**
 * Every Moovo call answers this, and the unavailable branch names the ISSUE
 * that owes the implementation.
 *
 * Carrying the issue number in the VALUE rather than only in a comment is what
 * makes an operator trace say "#159 has not landed" instead of "logistics
 * failed" — the `deferred: #NN` device #48 established for a webhook handler,
 * applied to a port.
 */
export type MoovoOperationResult<T> =
  | { outcome: 'ok'; value: T }
  | { outcome: 'unavailable'; reason: MoovoUnavailableReason; owedBy: string };

/**
 * What Moovo is given to quote or arrange transport (#126 privacy 2: *"Moovo
 * receives only logistics data required for quote/transport"*).
 *
 * An ALLOW-LIST expressed as a type. There is no buyer id, no Oxy identity, no
 * email, no guest portal credential, no payment reference, no order total, no
 * supplier cost and no supplier identity — a parcel needs a destination and a
 * content declaration, and everything else about the purchase is Mercaria's.
 *
 * `sourceReference` is Mercaria's own application-scoped handle for the
 * fulfilment intent, which is what makes a booking idempotent (#126 Mode A
 * requirement 3) and what an inbound Moovo event resolves against. It is
 * derived deterministically from the intent's id, so a replay produces the same
 * value and two racers converge rather than creating two transports.
 */
export interface MoovoTransportRequest {
  sourceReference: string;
  mode: RetailFulfilmentMode;
  origin: MoovoTransportEndpoint;
  destination: MoovoTransportEndpoint;
  lines: readonly MoovoTransportLine[];
  /** Supplier-reported dispatch facts, on the tracking-only path only. */
  existingCarriage?: MoovoExistingCarriage;
}

/** One end of a movement. A place and a contact, and nothing about a person's account. */
export interface MoovoTransportEndpoint {
  contactName: string;
  contactPhone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  /** ISO-3166-1 alpha-2, upper case. */
  country: string;
}

/**
 * What is in the movement, at the grain a buyer's timeline needs.
 *
 * `orderItemId` is Mercaria's own line handle so Moovo can report package
 * contents back against exact lines (#157 line-allocation item 7). There is no
 * price on it: what a parcel is worth is a customs and insurance question
 * nobody has asked yet, and a total handed over "in case it is useful" is the
 * commercial data #126 privacy 2 keeps out.
 */
export interface MoovoTransportLine {
  orderItemId: string;
  quantity: number;
  description: string;
}

/**
 * The tracking-only path's input: what the SUPPLIER already booked (#126 Mode B).
 *
 * Mercaria passes it through and normalizes nothing — `carrierName` is the
 * supplier's own string, handed to the authority that owns carrier
 * normalization. Mercaria mapping it to a canonical carrier list is exactly the
 * carrier-state mapping acceptance 2 forbids.
 */
export interface MoovoExistingCarriage {
  carrierName: string;
  trackingReference: string;
  /** ISO-8601, as the supplier reported it. */
  dispatchedAt: string;
}

/**
 * The order-role snapshot #126 requires on every retail customer order.
 *
 * Read this beside the issue's ten numbered items: items 3 (product, variant,
 * quantity, accepted price), 4's tax and shipping charge, 5's agreement, offer
 * and cost-quote citations, and 6's purchase-order reference already have
 * immutable homes — `order_items`, `orders.totals`, `retail_procurement_intents`
 * and its append-only lines. Copying them here would be a SECOND immutable
 * record of one fact, which is the failure mode the whole snapshot exists to
 * prevent.
 *
 * What this type carries is everything that had no home: who the seller is,
 * what was disclosed, what terms the buyer bought under, and — on the intent
 * rows it is read with — which mode was permitted and which was used.
 */
export interface RetailOrderRoleSnapshot {
  orderId: string;
  sellerOfRecord: RetailSellerOfRecord;
  sellerLegalEntityName: string;
  /** ISO-3166-1 alpha-2 of the selling entity. */
  sellerLegalEntityCountry: string;
  /** The #117 disclosure that was shown, by key and version. */
  supplierFulfilmentDisclosureKey: string;
  supplierFulfilmentDisclosureVersion: number;
  /** The customer terms version these four windows were read from. */
  customerTermsVersion: string;
  /** Hours a buyer may cancel within before dispatch. */
  cancellationWindowHours: number;
  /** Days of statutory withdrawal (EU 14 at launch, ADR 0004 D2.6). */
  withdrawalWindowDays: number;
  /** Days of Mercaria's own return policy. */
  returnWindowDays: number;
  /** Months of legal conformity guarantee (36 in ES at launch). */
  warrantyMonths: number;
  createdAt: string;
}

/**
 * How Mercaria reaches this buyer — DERIVED per read, never stored.
 *
 * `orders.buyer_origin` (#106) plus the presence of a `guest_checkouts` row
 * already answers it completely, so a column here would be a second answer that
 * could disagree with the one an access check uses. That is the
 * `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict
 * rule, and it is the safe direction: the copy that goes stale is the one a
 * notification would be sent to.
 */
export const RETAIL_BUYER_CONTACT_PATHS = [
  'oxy_account',
  'guest_contact_snapshot',
  'unavailable',
] as const;
export type RetailBuyerContactPath = (typeof RETAIL_BUYER_CONTACT_PATHS)[number];
