/**
 * Retail cancellations, returns, warranties, supplier RMAs and customer refunds
 * (#127, ADR 0004 D2.6/D8.5, diagrams 8–11).
 *
 * A `mercaria_retail` order is one Mercaria sells ITSELF and procures per order
 * from a B2B supplier (#123). Everything in this file exists to hold one
 * sentence from the issue:
 *
 * > *The buyer must not be stranded between Mercaria, Stripe and an undisclosed
 * > supplier.*
 *
 * ## The wall this vocabulary is built around
 *
 * There are TWO parties on Mercaria's side of a retail sale and they answer
 * different questions on different clocks:
 *
 *  - **The CUSTOMER side.** What Mercaria owes the buyer, decided by Mercaria
 *    under the terms snapshotted on their order and the law of their market.
 *    ADR 0004 D2.6: the EU 14-day withdrawal right and Spain's three-year
 *    conformity guarantee are Mercaria's to honour *whatever the supply
 *    agreement says about recourse*.
 *  - **The SUPPLIER side.** What Mercaria can recover from the supplier — an
 *    RMA, a credit note, a defect allowance. ADR 0004 D8.5: the customer's
 *    refund is *never contingent on, sized by, or delayed for* it.
 *
 * So the two are separate TYPES with no shared amount, no shared state and no
 * field on one that could name the other's money.
 * {@link RETAIL_SERVICE_FORBIDDEN_CUSTOMER_INPUTS} states the prohibition as
 * VALUES so a scanned gate can assert it (the `RetailForbiddenComponentKind`
 * device, #120), and {@link SupplierRecovery} carries no customer-facing amount
 * at all.
 *
 * ## What is deliberately ABSENT
 *
 * No email, no phone, no postal address, no email hash, no guest session id, no
 * payment-method detail, no card fingerprint, no IP address and no supplier
 * wholesale figure in any customer-facing shape. A request is identified by its
 * ORDER and its LINES; the contact it would be answered to lives on
 * `guest_checkouts` and is read only by the send path — #110's posture,
 * unchanged, because a retail buyer and a marketplace buyer are the same person
 * with the same rights to privacy.
 */

import type { CurrencyCode, Money } from './money';

/* -------------------------------------------------------------------------- */
/*  The twelve request kinds                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The twelve service requests #127 §"Retail service-request model" enumerates.
 *
 * ONE closed vocabulary rather than three (a cancellation kind, a return kind, a
 * warranty kind), because the thing they have in common is the thing that
 * matters: each is a customer asking Mercaria for a remedy, decided by Mercaria
 * under one policy snapshot, tracked on one clock and answered by one refund
 * path. Splitting them by remedy would put the deadline arithmetic, the evidence
 * rules and the duplicate-quantity guard in three places, and the place they
 * would first disagree is a buyer who filed a "defective" case for goods a
 * "wrong item" case had already brought back.
 *
 * The KIND is the customer's stated reason. There is deliberately no separate
 * `reason` enum beside it: two closed sets describing why somebody asked would
 * be two answers to one question, and the free-text
 * {@link RetailServiceRequestView.customerNote} carries what a taxonomy cannot.
 */
export const RETAIL_SERVICE_REQUEST_KINDS = [
  /** 1. The supplier has not accepted the purchase order yet. */
  'pre_acceptance_cancellation',
  /** 2. Accepted, not yet dispatched. */
  'pre_dispatch_cancellation',
  /** 3. Statutory withdrawal or change of mind, goods received. */
  'withdrawal_return',
  /** 4. Arrived broken. */
  'damaged_on_arrival',
  /** 5. Not what was ordered. */
  'wrong_item',
  /** 6. Short-shipped — nothing to send back, so never a return case. */
  'missing_item',
  /** 7. Faulty or not as described. */
  'defective_product',
  /** 8. The parcel never arrived or was lost in transit. */
  'delivery_failure',
  /** 9. The parcel came back — NOT a cancellation (#126 state example 6). */
  'return_to_sender',
  /** 10. Legal guarantee or commercial warranty. */
  'warranty_claim',
  /** 11. A recall Mercaria raises against goods already delivered. */
  'safety_recall',
  /** 12. Coordinating a card dispute the buyer opened with their bank. */
  'chargeback_coordination',
] as const;

/** One of {@link RETAIL_SERVICE_REQUEST_KINDS}. */
export type RetailServiceRequestKind = (typeof RETAIL_SERVICE_REQUEST_KINDS)[number];

/**
 * Who may RAISE each kind, and what a portal credential must carry to do it.
 *
 * A TABLE, not a switch — the `claim-methods.ts` device from #83 and
 * `BUYER_REQUEST_ACTIONS` from #110. The services read properties off it and
 * never ask "is this kind a cancellation", so adding a thirteenth means adding a
 * row and deciding every column rather than finding every branch.
 *
 * The interesting column is `customerSubmittable`. Three of the twelve are NOT
 * things a buyer files:
 *
 *  - `return_to_sender` is reported by a carrier or a supplier. A buyer whose
 *    parcel bounced knows only that it never came, which is `delivery_failure`.
 *  - `safety_recall` is Mercaria acting on a #121 suppression. Letting a buyer
 *    declare one would put an unreviewed product-safety assertion into the
 *    record that decides whether other buyers are contacted.
 *  - `chargeback_coordination` is opened by a Stripe dispute event. A buyer who
 *    "files a chargeback" with Mercaria has actually filed one with their bank,
 *    and recording their claim as the dispute would make Mercaria's evidence
 *    deadline depend on when somebody happened to tell us.
 *
 * `evidenceRequired` is the other one worth reading. #127 policy rule 6 —
 * *"do not require unnecessary photos or documents for ordinary withdrawal"* —
 * is this column being `false` for `withdrawal_return`, and it is enforced at
 * SUBMIT: a request whose kind does not require evidence cannot be moved to
 * `evidence_required` at all.
 */
export interface RetailServiceRequestPolicy {
  /** May a buyer file this themselves? */
  readonly customerSubmittable: boolean;
  /** Does a decision need evidence before it can be taken? */
  readonly evidenceRequired: boolean;
  /** Does an accepted request bring goods back, and therefore open a return case? */
  readonly opensReturnCase: boolean;
  /** Does an accepted request open a durable warranty case? */
  readonly opensWarrantyCase: boolean;
  /** Which window on the order's terms snapshot bounds it. */
  readonly window: RetailServiceWindow;
}

/**
 * Which snapshotted window a kind is measured against.
 *
 * `none` is a real answer and not a gap: a wrong item, a lost parcel and a
 * recall are not bounded by a withdrawal clock, and #127 policy rule 8 says so
 * outright — *"safety and defective-product cases can remain actionable beyond
 * ordinary withdrawal windows"*. Giving them a window would be the mechanism by
 * which a recall expires.
 */
export const RETAIL_SERVICE_WINDOWS = [
  'cancellation',
  'withdrawal',
  'return',
  'warranty',
  'none',
] as const;

/** One of {@link RETAIL_SERVICE_WINDOWS}. */
export type RetailServiceWindow = (typeof RETAIL_SERVICE_WINDOWS)[number];

/** The per-kind contract, read by every service and by the schema's CHECKs. */
export const RETAIL_SERVICE_REQUEST_POLICIES = {
  pre_acceptance_cancellation: {
    customerSubmittable: true,
    evidenceRequired: false,
    opensReturnCase: false,
    opensWarrantyCase: false,
    window: 'cancellation',
  },
  pre_dispatch_cancellation: {
    customerSubmittable: true,
    evidenceRequired: false,
    opensReturnCase: false,
    opensWarrantyCase: false,
    window: 'cancellation',
  },
  withdrawal_return: {
    customerSubmittable: true,
    evidenceRequired: false,
    opensReturnCase: true,
    opensWarrantyCase: false,
    window: 'withdrawal',
  },
  damaged_on_arrival: {
    customerSubmittable: true,
    evidenceRequired: true,
    opensReturnCase: true,
    opensWarrantyCase: false,
    window: 'return',
  },
  wrong_item: {
    customerSubmittable: true,
    evidenceRequired: true,
    opensReturnCase: true,
    opensWarrantyCase: false,
    window: 'return',
  },
  missing_item: {
    customerSubmittable: true,
    evidenceRequired: true,
    opensReturnCase: false,
    opensWarrantyCase: false,
    window: 'return',
  },
  defective_product: {
    customerSubmittable: true,
    evidenceRequired: true,
    opensReturnCase: true,
    opensWarrantyCase: true,
    window: 'warranty',
  },
  delivery_failure: {
    customerSubmittable: true,
    evidenceRequired: false,
    opensReturnCase: false,
    opensWarrantyCase: false,
    window: 'none',
  },
  return_to_sender: {
    customerSubmittable: false,
    evidenceRequired: false,
    opensReturnCase: true,
    opensWarrantyCase: false,
    window: 'none',
  },
  warranty_claim: {
    customerSubmittable: true,
    evidenceRequired: true,
    opensReturnCase: true,
    opensWarrantyCase: true,
    window: 'warranty',
  },
  safety_recall: {
    customerSubmittable: false,
    evidenceRequired: false,
    opensReturnCase: true,
    opensWarrantyCase: false,
    window: 'none',
  },
  chargeback_coordination: {
    customerSubmittable: false,
    evidenceRequired: false,
    opensReturnCase: false,
    opensWarrantyCase: false,
    window: 'none',
  },
} as const satisfies Record<RetailServiceRequestKind, RetailServiceRequestPolicy>;

/** The kinds a buyer may file, derived rather than re-listed. */
export const CUSTOMER_SUBMITTABLE_RETAIL_REQUEST_KINDS: readonly RetailServiceRequestKind[] =
  RETAIL_SERVICE_REQUEST_KINDS.filter(
    (kind) => RETAIL_SERVICE_REQUEST_POLICIES[kind].customerSubmittable,
  );

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where one request stands.
 *
 * Eight states, and three pairs look like one until you ask who acts next.
 *
 *  - **`accepted` vs `in_progress`.** Acceptance is Mercaria's DECISION;
 *    `in_progress` is the remedy actually running — a return in the post, a
 *    supplier cancellation requested, a refund committed and its rail pending.
 *    #110 separated `accepted` from `completed` for the same reason and this
 *    adds the middle one, because a retail remedy routinely has a supplier step
 *    between the decision and the money.
 *  - **`withdrawn` vs `cancelled`.** The buyer abandoned it, versus Mercaria
 *    terminating an accepted one. Two facts about who acted should not share a
 *    word.
 *  - **`evidence_required` vs `submitted`.** #127 policy rule 5 asks for a
 *    distinct evidence-needed state precisely so a buyer can be told what to do
 *    next rather than watching a request sit.
 *
 * There is deliberately no `failed`. A completion that did not complete leaves
 * the request `in_progress` with a bounded failure code beside it and the retry
 * is the same idempotent call — #110's `payment_repairs` posture.
 *
 * And there is deliberately no state a SUPPLIER can drive. #127 policy rule 9 —
 * *"a missing supplier response does not cause the request to disappear"* — is
 * held by the absence of any transition triggered by supplier silence: nothing
 * sweeps a request closed, and the only writers of a terminal state are a
 * decision, a completion and a withdrawal.
 */
export const RETAIL_SERVICE_REQUEST_STATES = [
  'submitted',
  'evidence_required',
  'accepted',
  'rejected',
  'in_progress',
  'completed',
  'withdrawn',
  'cancelled',
] as const;

/** One of {@link RETAIL_SERVICE_REQUEST_STATES}. */
export type RetailServiceRequestState = (typeof RETAIL_SERVICE_REQUEST_STATES)[number];

/**
 * The states in which one order may hold only ONE request of a kind.
 *
 * The partial unique index's predicate is rendered from this tuple, so the
 * database and the service reason about the same set. A buyer double-tapping,
 * a retried POST and two concurrent submissions all collide and the loser reads
 * the winner back — #110's convergence, unchanged.
 */
export const OPEN_RETAIL_SERVICE_REQUEST_STATES: readonly RetailServiceRequestState[] = [
  'submitted',
  'evidence_required',
  'accepted',
  'in_progress',
];

/** Where a request came from. */
export const RETAIL_SERVICE_REQUEST_ORIGINS = ['customer', 'operator', 'system'] as const;

/** One of {@link RETAIL_SERVICE_REQUEST_ORIGINS}. */
export type RetailServiceRequestOrigin = (typeof RETAIL_SERVICE_REQUEST_ORIGINS)[number];

/**
 * Who acted, as a KIND — the `order_status_history` triple, three domains down.
 *
 * A guest is recorded as having acted without recording WHICH guest, because the
 * per-guest correlation key is #106 invariant 11's problem and a request is
 * attached to an order that already names its buyer.
 */
export const RETAIL_SERVICE_ACTOR_KINDS = ['oxy', 'guest', 'operator', 'system'] as const;

/** One of {@link RETAIL_SERVICE_ACTOR_KINDS}. */
export type RetailServiceActorKind = (typeof RETAIL_SERVICE_ACTOR_KINDS)[number];

/**
 * Why a completion did not complete. A bounded code, never provider text.
 *
 * `dispute_suspension` is the one to read: an open card dispute on the order
 * suspends the automatic refund path (#127 chargeback rule 5), and recording
 * that as the reason is what makes the suspension visible instead of looking
 * like a stuck request.
 */
export const RETAIL_SERVICE_COMPLETION_FAILURES = [
  'refund_path_unavailable',
  'order_state_changed',
  'dispute_suspension',
  'remedy_not_supported',
  'refund_refused',
] as const;

/** One of {@link RETAIL_SERVICE_COMPLETION_FAILURES}. */
export type RetailServiceCompletionFailure = (typeof RETAIL_SERVICE_COMPLETION_FAILURES)[number];

/* -------------------------------------------------------------------------- */
/*  Eligibility and policy                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The verdict on whether Mercaria will entertain a request.
 *
 * THREE-valued, and `evidence_needed` is not a soft no. #127 policy rule 5 asks
 * that eligible, ineligible and evidence-needed be *explained to the customer*,
 * and they route to three different next actions: proceed, stop, or send us a
 * photograph. Collapsing the third into either of the others is how a buyer with
 * a valid claim is told they have none.
 *
 * `ineligible` beats `evidence_needed` beats `eligible` — the
 * `deriveRetailCompleteness` severity rule (#120), applied to a remedy.
 */
export const RETAIL_SERVICE_ELIGIBILITY_VERDICTS = [
  'eligible',
  'evidence_needed',
  'ineligible',
] as const;

/** One of {@link RETAIL_SERVICE_ELIGIBILITY_VERDICTS}. */
export type RetailServiceEligibilityVerdict =
  (typeof RETAIL_SERVICE_ELIGIBILITY_VERDICTS)[number];

/**
 * Why a request is not eligible.
 *
 * Every member names an action the buyer or Mercaria can take next, which is
 * what stops a refusal being a dead end. None of them discloses anything about
 * a supplier, another buyer, another order or the order's stock position.
 */
export const RETAIL_SERVICE_INELIGIBILITY_REASONS = [
  /** The order is not a Mercaria-retail order — #110's domain owns it. */
  'not_a_retail_order',
  /** The applicable window closed. The response names the deadline that passed. */
  'window_closed',
  /** Nothing was paid, so there is nothing to undo. */
  'order_not_paid',
  /** Goods have not been delivered, so a return cannot start. */
  'not_yet_delivered',
  /** Already dispatched — a cancellation is too late and a return is offered. */
  'already_dispatched',
  /** A request of this kind is already open on this order. */
  'request_already_open',
  /** Every unit of the named lines is already covered by a resolved request. */
  'quantity_already_resolved',
  /** A reviewed category exception removes this remedy for these goods. */
  'category_exception',
  /** The kind is not one a buyer may raise. */
  'not_customer_submittable',
] as const;

/** One of {@link RETAIL_SERVICE_INELIGIBILITY_REASONS}. */
export type RetailServiceIneligibilityReason =
  (typeof RETAIL_SERVICE_INELIGIBILITY_REASONS)[number];

/**
 * The reasons whose correct next action is a RETURN rather than the thing asked
 * for.
 *
 * #110's `CANCELLATION_REASONS_OFFERING_RETURN`, stated as data for the same
 * reason: "it already shipped, open a return" and "the window closed" lead to
 * opposite actions, and a client that has to match a message string to tell them
 * apart is a client that will get it wrong in one locale.
 */
export const RETAIL_REASONS_OFFERING_RETURN: readonly RetailServiceIneligibilityReason[] = [
  'already_dispatched',
];

/**
 * Where a deadline comes from, and the whole reason the two are separate
 * columns.
 *
 * #127 policy rules 2 and 3: *"record statutory and commercial policy
 * separately"* and *"statutory rights cannot be silently reduced by a supplier's
 * narrower policy"*. A single `deadline_at` column cannot express the second —
 * once the two are one number, the narrower one has already won and nothing
 * records that it did.
 *
 * So a request stores BOTH deadlines and derives the effective one with
 * {@link resolveEffectiveServiceDeadline}, which returns the LATER of them. A
 * commercial policy may extend a statutory right and may never shorten it, and
 * that is arithmetic rather than a review comment.
 */
export const RETAIL_POLICY_BASES = ['statutory', 'commercial'] as const;

/** One of {@link RETAIL_POLICY_BASES}. */
export type RetailPolicyBasis = (typeof RETAIL_POLICY_BASES)[number];

/**
 * The LATER of a statutory and a commercial deadline.
 *
 * Pure, total and the single place the precedence between them is expressed. An
 * absent commercial deadline means Mercaria's own policy states nothing about
 * this kind, which leaves the statutory one standing; an absent statutory one
 * means the market grants no minimum, which leaves Mercaria's own.
 *
 * The direction is what matters: `Math.max` can only ever move a deadline LATER,
 * so there is no argument pair for which this function shortens a buyer's
 * rights. A test drives randomized pairs and asserts exactly that.
 */
export function resolveEffectiveServiceDeadline(
  statutoryAt: Date | null,
  commercialAt: Date | null,
): Date | null {
  if (statutoryAt === null) return commercialAt;
  if (commercialAt === null) return statutoryAt;
  return commercialAt.getTime() > statutoryAt.getTime() ? commercialAt : statutoryAt;
}

/**
 * Where a category exception may come from.
 *
 * #127 policy rule 7: *"category exceptions must be explicit and reviewed"*.
 * There are two legitimate sources and a supplier is neither of them — a
 * statutory instrument (EU CRD Article 16's sealed-goods and custom-made
 * carve-outs, and their national transpositions) or Mercaria's own reviewed
 * policy.
 *
 * DISJOINT from {@link RETAIL_FORBIDDEN_POLICY_EXCEPTION_SOURCES}, which is what
 * makes policy rule 3 structural: a supplier's narrower returns policy has no
 * value it could be recorded under, so it cannot reduce a customer right by
 * being written down, whatever a service does.
 */
export const RETAIL_POLICY_EXCEPTION_SOURCES = ['statutory_instrument', 'mercaria_policy'] as const;

/** One of {@link RETAIL_POLICY_EXCEPTION_SOURCES}. */
export type RetailPolicyExceptionSource = (typeof RETAIL_POLICY_EXCEPTION_SOURCES)[number];

/**
 * Sources a category exception may NEVER cite. Disjoint from
 * {@link RETAIL_POLICY_EXCEPTION_SOURCES}, gated by a test.
 *
 * A supply agreement's `returnsResponsibility` describes Mercaria's RECOURSE
 * against a supplier. Reading it as a limit on what a buyer may ask for is
 * exactly the substitution ADR 0004 D2.6 forbids, and it is a plausible-looking
 * change: the agreement is right there, it says "no returns after 14 days", and
 * copying that number onto the customer's clock reads as diligence.
 */
export const RETAIL_FORBIDDEN_POLICY_EXCEPTION_SOURCES = [
  'supplier_agreement',
  'supplier_policy',
  'supplier_request',
  'supplier_rejection',
  'procurement_cost',
  'marketplace_fee_schedule',
] as const;

/** One of {@link RETAIL_FORBIDDEN_POLICY_EXCEPTION_SOURCES}. */
export type RetailForbiddenPolicyExceptionSource =
  (typeof RETAIL_FORBIDDEN_POLICY_EXCEPTION_SOURCES)[number];

/* -------------------------------------------------------------------------- */
/*  Customer outcomes                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What Mercaria decided the customer gets.
 *
 * All eight are REPRESENTABLE because #127's warranty section asks for a case
 * *capable of representing* repair, replacement, price reduction and refund —
 * and because a buyer who asked for a repair and was given a refund is a fact
 * the record has to be able to state.
 *
 * Only {@link SUPPORTED_RETAIL_CUSTOMER_OUTCOMES} can be EXECUTED, and the gap
 * is stated rather than hidden — see that constant.
 */
export const RETAIL_CUSTOMER_OUTCOMES = [
  'full_refund',
  'partial_refund',
  'price_reduction',
  'cancellation_refund',
  'replacement',
  'repair',
  'redelivery',
  'no_remedy',
] as const;

/** One of {@link RETAIL_CUSTOMER_OUTCOMES}. */
export type RetailCustomerOutcome = (typeof RETAIL_CUSTOMER_OUTCOMES)[number];

/**
 * The outcomes Mercaria can actually deliver today.
 *
 * The three that are missing all mean *send the buyer another physical item*,
 * and every one of them needs a SECOND purchase order against the same customer
 * order and the same supplier. #124 derives a purchase order's idempotency key
 * as `po:<orderId>:<supplierId>` — deliberately, because that pair is what makes
 * a redelivered success, a reclaimed lease and an operator retry converge on one
 * purchase order instead of three. A replacement is therefore not a missing
 * function here; it is a key #124 owns and a second charge-free procurement
 * authorization #123's reader does not grant.
 *
 * The refusal is at DECISION time and names the outcome the buyer asked for, so
 * nobody is told "yes" and then "actually no" a week later — #110's
 * `replacement` decision, and #83's `role_email` before it. `price_reduction`
 * IS supported: it is a partial refund with a different meaning, and the
 * meaning is worth recording because it is the remedy EU conformity law names
 * between repair and rescission.
 *
 * **Mercaria must not advertise a warranty period it cannot operationally
 * support** is the issue's own sentence. Refund-shaped remedies are always
 * available and are never worse for the buyer than the remedy they replace,
 * which is why this set is a real answer rather than a placeholder.
 */
export const SUPPORTED_RETAIL_CUSTOMER_OUTCOMES: readonly RetailCustomerOutcome[] = [
  'full_refund',
  'partial_refund',
  'price_reduction',
  'cancellation_refund',
  'no_remedy',
];

/** The outcomes that move money back to the buyer. */
export const REFUNDING_RETAIL_CUSTOMER_OUTCOMES: readonly RetailCustomerOutcome[] = [
  'full_refund',
  'partial_refund',
  'price_reduction',
  'cancellation_refund',
];

/**
 * Inputs a customer request may NEVER be decided from.
 *
 * Disjoint from everything this vocabulary records, gated by a test and by a
 * scanned wall over the service directory. The first four are ADR 0004 D8.5 as
 * values: a customer's remedy sized by, contingent on or delayed for a supplier
 * credit is the exact failure #127 exists to prevent, and it is a plausible
 * change — the supplier's answer is right there in the same trace.
 */
export const RETAIL_SERVICE_FORBIDDEN_CUSTOMER_INPUTS = [
  'supplier_credit_state',
  'supplier_credit_amount',
  'supplier_rma_state',
  'supplier_wholesale_cost',
  'supplier_agreement_returns_policy',
  'buyer_email',
  'buyer_phone',
  'buyer_postal_address',
  'buyer_email_hash',
  'guest_session_id',
  'card_fingerprint',
  'payment_method_detail',
  'ip_address',
] as const;

/** One of {@link RETAIL_SERVICE_FORBIDDEN_CUSTOMER_INPUTS}. */
export type RetailServiceForbiddenCustomerInput =
  (typeof RETAIL_SERVICE_FORBIDDEN_CUSTOMER_INPUTS)[number];

/* -------------------------------------------------------------------------- */
/*  Evidence                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a buyer may attach to a request.
 *
 * A bare Oxy `fileId` the buyer already uploaded to their own Oxy storage — the
 * `abuse_reports` posture #110 adopted, never a URL and never a `mercaria.co`
 * one. The moderation domain already establishes why: a reviewer's browser
 * fetching a Mercaria URL would tell this host when its content is being looked
 * at.
 *
 * **The gap, stated:** Mercaria holds no Oxy service credential, so it cannot
 * read the file's metadata, compute a digest or scan it. Asserting any of the
 * three would be worse than admitting it has none — the same gap
 * `services/moderation/` and #110 both document, and closing it closes all
 * three.
 */
export const RETAIL_SERVICE_EVIDENCE_KINDS = [
  'photo',
  'video',
  'document',
  'serial_number_photo',
  'packaging_photo',
] as const;

/** One of {@link RETAIL_SERVICE_EVIDENCE_KINDS}. */
export type RetailServiceEvidenceKind = (typeof RETAIL_SERVICE_EVIDENCE_KINDS)[number];

/** How many evidence references one request may carry. */
export const RETAIL_SERVICE_EVIDENCE_MAX_COUNT = 12;

/** The longest note a buyer or an operator may attach. */
export const RETAIL_SERVICE_NOTE_MAX_LENGTH = 1_000;

/* -------------------------------------------------------------------------- */
/*  Return cases                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Where the goods physically go back to.
 *
 * #127 return rule 2 asks Mercaria to *determine whether the item returns to the
 * supplier, Mercaria, manufacturer or another approved location*. All four are
 * here and the choice is Mercaria's — never the supplier's, and never disclosed
 * to the buyer as an instruction to contact somebody else (#127 return rule 5).
 * A buyer sending a parcel to a supplier's warehouse is still a buyer whose only
 * counterparty is Mercaria.
 */
export const RETAIL_RETURN_DESTINATIONS = [
  'supplier',
  'mercaria',
  'manufacturer',
  'other_approved',
] as const;

/** One of {@link RETAIL_RETURN_DESTINATIONS}. */
export type RetailReturnDestination = (typeof RETAIL_RETURN_DESTINATIONS)[number];

/**
 * Where one internal return case stands.
 *
 * #127 return rule 7 names six trackable states and they are NOT all states of
 * the case: `shipped`, `received`, `accepted` and `rejected` are things that
 * happen to QUANTITIES, and a case covering three units of which two arrived is
 * in none of them. So the case carries a coarse lifecycle and the quantities
 * carry their own dispositions — see {@link RETAIL_RETURN_DISPOSITIONS}.
 *
 * `authorization_unavailable` is a real state and the honest one for today: a
 * return to a SUPPLIER needs an RMA from an adapter that declared
 * `return_authorization`, and no registered adapter does. The case exists, the
 * buyer is told Mercaria is arranging it, and nothing pretends an authorization
 * was obtained.
 */
export const RETAIL_RETURN_CASE_STATES = [
  'authorization_pending',
  'authorization_unavailable',
  'authorized',
  'in_transit',
  'partially_received',
  'received',
  'inspected',
  'closed',
  'cancelled',
] as const;

/** One of {@link RETAIL_RETURN_CASE_STATES}. */
export type RetailReturnCaseState = (typeof RETAIL_RETURN_CASE_STATES)[number];

/**
 * What happened to some number of units, as an APPEND-ONLY movement.
 *
 * #127 return rule 10 is *"prevent the same quantity from being returned or
 * refunded twice"*, and a mutable `received_quantity` column is the mechanism by
 * which it is not prevented: two concurrent scans both read three, both write
 * six. Movements sum instead, the repository holds the cross-row cap, and the
 * trail says who reported what and when — which is also #127 return rule 12's
 * lost-parcel escalation, because "we shipped four and received none" is two
 * rows rather than an absence.
 *
 * `credited` is here and it is a SUPPLIER fact, deliberately recorded on the
 * customer's return case as well: knowing which units a supplier credited is how
 * an operator sees the two sides side by side. It carries NO amount — the money
 * is on {@link SupplierRecovery}, and putting a figure here would be the first
 * place a customer projection could reach one.
 */
export const RETAIL_RETURN_DISPOSITIONS = [
  'shipped',
  'received',
  'inspected',
  'accepted',
  'rejected',
  'credited',
  'lost_in_transit',
] as const;

/** One of {@link RETAIL_RETURN_DISPOSITIONS}. */
export type RetailReturnDisposition = (typeof RETAIL_RETURN_DISPOSITIONS)[number];

/**
 * The dispositions that CONSUME a unit's returnability.
 *
 * Derived by naming them rather than by subtraction, because the two that are
 * absent are absent for opposite reasons: `rejected` means the supplier refused
 * the unit and it is Mercaria's problem now, not the buyer's second chance, and
 * `credited` is a supplier-side fact that must never bound what a buyer may do.
 */
export const RETAIL_RETURN_CONSUMING_DISPOSITIONS: readonly RetailReturnDisposition[] = [
  'shipped',
];

/**
 * How a buyer gets the goods back to where they are going.
 *
 * `unavailable` is the shipped state of this deployment and it is not a
 * placeholder. #127 return rule 6 — *"generate or obtain shipping labels only
 * through an approved carrier or supplier path"* — leaves exactly two sources: a
 * supplier RMA label (no adapter declares `return_authorization`) and Moovo
 * reverse transport (#159, unbuilt, and #126's port refuses). Mercaria composing
 * one itself is precisely what rule 6 forbids and what the #126 logistics gate
 * fails the build over.
 */
export const RETAIL_RETURN_LABEL_SOURCES = ['supplier_rma', 'moovo', 'unavailable'] as const;

/** One of {@link RETAIL_RETURN_LABEL_SOURCES}. */
export type RetailReturnLabelSource = (typeof RETAIL_RETURN_LABEL_SOURCES)[number];

/* -------------------------------------------------------------------------- */
/*  Warranty                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Which body honours a warranty claim.
 *
 * The path is a fact about RECOURSE and never about who the buyer deals with:
 * whichever member this is, #127 experience rule 1 still puts Mercaria in front
 * of the customer, and no customer-facing projection carries this column.
 */
export const RETAIL_WARRANTY_PATHS = ['mercaria', 'supplier', 'manufacturer'] as const;

/** One of {@link RETAIL_WARRANTY_PATHS}. */
export type RetailWarrantyPath = (typeof RETAIL_WARRANTY_PATHS)[number];

/**
 * Which guarantee a claim is made under.
 *
 * Separate from {@link RetailPolicyBasis} because a claim can be made under both
 * at once and the answers differ: the legal conformity guarantee runs three
 * years in Spain and cannot be shortened, while a commercial warranty is
 * whatever Mercaria published and may be longer.
 */
export const RETAIL_WARRANTY_BASES = ['legal_guarantee', 'commercial_warranty'] as const;

/** One of {@link RETAIL_WARRANTY_BASES}. */
export type RetailWarrantyBasis = (typeof RETAIL_WARRANTY_BASES)[number];

/** Where a warranty case stands. */
export const RETAIL_WARRANTY_CASE_STATES = [
  'reported',
  'assessing',
  'awaiting_item',
  'in_repair',
  'resolved',
  'rejected',
  'escalated_safety',
] as const;

/** One of {@link RETAIL_WARRANTY_CASE_STATES}. */
export type RetailWarrantyCaseState = (typeof RETAIL_WARRANTY_CASE_STATES)[number];

/* -------------------------------------------------------------------------- */
/*  Supplier recoveries — Mercaria's side of the wall                          */
/* -------------------------------------------------------------------------- */

/**
 * The ten normalized supplier recovery records #127 §"Supplier credits and
 * recoveries" enumerates.
 *
 * A recovery is Mercaria trying to get its COST back from a supplier. It is not
 * a customer refund, it is not sized by one, and it does not delay one — ADR
 * 0004 D8.5. The two sides meet in exactly one place, an operator screen that
 * shows them side by side, and nowhere in code: no function takes a recovery and
 * returns a customer amount, and no customer projection has a member one could
 * be put in.
 */
export const SUPPLIER_RECOVERY_KINDS = [
  'cancelled_order_refund',
  'return_credit',
  'defect_allowance',
  'lost_parcel_claim',
  'shipping_refund',
  'warranty_reimbursement',
  'replacement_at_no_charge',
  'partial_credit',
  'rejected_claim',
  'credit_note',
] as const;

/** One of {@link SUPPLIER_RECOVERY_KINDS}. */
export type SupplierRecoveryKind = (typeof SUPPLIER_RECOVERY_KINDS)[number];

/**
 * Where a recovery stands with the supplier.
 *
 * `rejected` is TERMINAL and is a perfectly ordinary outcome. #127 responsibility
 * rule 4 — *"a supplier rejecting a credit does not automatically remove a refund
 * or remedy already owed to the customer"* — is held by this state existing on a
 * row that no customer path reads.
 */
export const SUPPLIER_RECOVERY_STATES = [
  'claimed',
  'acknowledged',
  'accepted',
  'rejected',
  'credited',
  'settled',
  'abandoned',
] as const;

/** One of {@link SUPPLIER_RECOVERY_STATES}. */
export type SupplierRecoveryState = (typeof SUPPLIER_RECOVERY_STATES)[number];

/**
 * Everything a supplier recovery record deliberately does NOT do.
 *
 * ADR 0004 D7 assigns the five retail ledger accounts and the four transaction
 * kinds to #128, *together with the code that writes them*. #127 therefore
 * CLASSIFIES and never BOOKS — the same division #123's
 * `retail_cost_variance_records` already holds, and for the same reason: a
 * domain that both decides an amount and books it has no independent record to
 * reconcile against.
 *
 * The enforcement is the absence of an account column and of any ledger import,
 * both gated by `retail-service-isolation.test.ts`. These values name the
 * prohibition so the gate can assert it by NAME rather than by a regular
 * expression somebody can widen.
 */
export const SUPPLIER_RECOVERY_FORBIDDEN_EFFECTS = [
  'ledger_account',
  'ledger_transaction',
  'customer_refund_amount',
  'customer_refund_timing',
  'order_status_change',
  'inventory_movement',
] as const;

/** One of {@link SUPPLIER_RECOVERY_FORBIDDEN_EFFECTS}. */
export type SupplierRecoveryForbiddenEffect = (typeof SUPPLIER_RECOVERY_FORBIDDEN_EFFECTS)[number];

/* -------------------------------------------------------------------------- */
/*  Chargeback coordination                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a dispute does to Mercaria's own refund paths.
 *
 * #127 chargeback rules 5 and 10: *"suspend duplicate refund paths according to
 * an explicit policy"* and *"a chargeback cannot also produce an unnoticed
 * duplicate refund"*. The policy is explicit because it is a stored value on the
 * coordination row rather than a branch:
 *
 *  - `suspended` — the ordinary state while a dispute is open. An automatic
 *    refund would return money the card network is already clawing back, and the
 *    buyer would be paid twice at Mercaria's expense.
 *  - `released` — the dispute closed, or an operator decided the refund is owed
 *    regardless and recorded WHY. Never a default, and never reached by a sweep.
 *
 * The word *unnoticed* is the load-bearing one. A refund committed while a
 * dispute is open is not forbidden — sometimes it is right — but it must be a
 * decision somebody made and can be shown to have made.
 */
export const RETAIL_REFUND_SUSPENSION_STATES = ['suspended', 'released'] as const;

/** One of {@link RETAIL_REFUND_SUSPENSION_STATES}. */
export type RetailRefundSuspensionState = (typeof RETAIL_REFUND_SUSPENSION_STATES)[number];

/* -------------------------------------------------------------------------- */
/*  Refund allocation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * How much of a refund is items, delivery, tax and discount.
 *
 * #127 refund rule 4 asks for *item, shipping, tax and discount allocations
 * explicitly*, and "explicitly" is the whole point: a single total cannot say
 * whether delivery came back, and whether delivery comes back is the difference
 * between a cancellation and a return in every consumer regime there is.
 *
 * Every component is a minor-unit integer in ONE currency, and the currency is
 * the order's PRESENTMENT currency because that is what the buyer paid and what
 * a refund returns. `total` is not stored anywhere and is re-derived by
 * {@link retailRefundAllocationTotal}, so the parts and the sum cannot disagree.
 */
export interface RetailRefundAllocation {
  readonly currency: CurrencyCode;
  /** Line totals for the returned units, net of the item-level discount below. */
  readonly itemsMinor: number;
  /** Delivery, refunded on a cancellation and withheld on an ordinary return. */
  readonly deliveryMinor: number;
  /** Tax attributable to what is coming back. */
  readonly taxMinor: number;
  /**
   * What the buyer did not pay in the first place, as a NEGATIVE contribution.
   *
   * Stored as the amount ALREADY DEDUCTED rather than as a positive number to
   * subtract, so a caller cannot add it by accident. Every arithmetic path in
   * this domain sums the four members and one of them being signed is what makes
   * that safe.
   */
  readonly discountMinor: number;
}

/** The sum of an allocation's parts. Never stored; always derived. */
export function retailRefundAllocationTotal(allocation: RetailRefundAllocation): Money {
  return {
    amount:
      allocation.itemsMinor +
      allocation.deliveryMinor +
      allocation.taxMinor +
      allocation.discountMinor,
    currency: allocation.currency,
  };
}

/* -------------------------------------------------------------------------- */
/*  Views                                                                      */
/* -------------------------------------------------------------------------- */

/** One order line and how many of its units a request names. */
export interface RetailServiceRequestLineView {
  readonly orderItemId: string;
  readonly variantId: string;
  readonly quantity: number;
}

/** A declared piece of evidence — a bare Oxy file id and nothing derived from it. */
export interface RetailServiceEvidenceView {
  readonly kind: RetailServiceEvidenceKind;
  readonly fileId: string;
  readonly caption?: string;
}

/**
 * What the CUSTOMER sees.
 *
 * #127 experience rules 1–8. Every field is named explicitly (the
 * `provider_accounts` #46 device) and the omissions are the design: no supplier
 * name, no supplier state, no wholesale amount, no recovery, no RMA reference
 * and no purchase-order id. A buyer reading this cannot tell that a supplier
 * exists, which is #127 experience rule 8 and ADR 0004 D2.8.
 *
 * `nextAction` is rule 2's *"show request status and next action"* as a bounded
 * code rather than a sentence, so the copy lives in the client and a correction
 * does not require rewriting what a stored request says.
 */
export interface RetailServiceRequestView {
  readonly id: string;
  readonly orderId: string;
  readonly kind: RetailServiceRequestKind;
  readonly state: RetailServiceRequestState;
  readonly lines: readonly RetailServiceRequestLineView[];
  readonly evidence: readonly RetailServiceEvidenceView[];
  readonly customerNote?: string;
  /** The deadline that actually applies — the later of the two stored ones. */
  readonly customerDeadlineAt?: string;
  /** What Mercaria decided, once it has. */
  readonly outcome?: RetailCustomerOutcome;
  readonly outcomeNote?: string;
  /** Present once a refund exists. Amount and method, #127 experience rule 4. */
  readonly refund?: RetailServiceRefundView;
  /** Present once goods are coming back, #127 experience rules 3 and 5. */
  readonly returnCase?: RetailServiceReturnCaseView;
  /** A safety notice stays prominent whatever else the request says (rule 7). */
  readonly safetyNotice: boolean;
  readonly nextAction: RetailServiceNextAction;
  readonly submittedAt: string;
  readonly updatedAt: string;
}

/**
 * What the buyer is waiting for, or what they must do.
 *
 * A closed set, because rule 2 asks for a NEXT ACTION and a free-text status
 * line is what a system produces when nobody decided what the next action is.
 */
export const RETAIL_SERVICE_NEXT_ACTIONS = [
  'none',
  'send_evidence',
  'awaiting_mercaria_decision',
  'ship_the_item_back',
  'awaiting_item_receipt',
  'awaiting_refund',
  'closed',
] as const;

/** One of {@link RETAIL_SERVICE_NEXT_ACTIONS}. */
export type RetailServiceNextAction = (typeof RETAIL_SERVICE_NEXT_ACTIONS)[number];

/**
 * The refund as the buyer sees it.
 *
 * `settled` is DERIVED from the rail's own state and is deliberately separate
 * from the request being `completed`: #127 experience rule 5 is *"distinguish
 * return received from refund completed"*, and the two really are different days.
 */
export interface RetailServiceRefundView {
  readonly refundId: string;
  readonly amount: Money;
  readonly allocation: RetailRefundAllocation;
  /** Where the money went back to. Always the original path (#127 refund rule 3). */
  readonly destination: 'original_payment_method';
  readonly settled: boolean;
}

/**
 * The return as the buyer sees it.
 *
 * No destination, no supplier, no RMA reference and no address: rule 5 forbids
 * exposing the supplier as customer support, and an address is exactly how a
 * buyer learns who their parcel is really going to. `instructions` is the copy
 * key #129 renders, and `labelAvailable` is honest about the state of #159.
 */
export interface RetailServiceReturnCaseView {
  readonly id: string;
  readonly state: RetailReturnCaseState;
  readonly shipBackDeadlineAt?: string;
  readonly labelAvailable: boolean;
  readonly instructionsKey?: string;
  readonly shippedQuantity: number;
  readonly receivedQuantity: number;
}

/**
 * The OPERATOR view: customer obligation and supplier recovery side by side.
 *
 * #127 experience: *"operator surfaces must show customer obligation and
 * supplier recovery side by side without conflating them"*. Two named members
 * rather than a merged total — there is no field here that adds a recovery to a
 * refund, and no arithmetic in this domain that could produce one.
 */
export interface RetailServiceOperatorView {
  readonly request: RetailServiceRequestView;
  /** What Mercaria owes the customer. The customer half, unmodified. */
  readonly customerObligation: {
    readonly outcome?: RetailCustomerOutcome;
    readonly refundAmount?: Money;
    readonly refundSettled: boolean;
    readonly decidedAt?: string;
  };
  /** What Mercaria is trying to recover. Never netted against the above. */
  readonly supplierRecoveries: readonly SupplierRecoveryView[];
  /** Present when a card dispute is coordinating with this request. */
  readonly disputeCoordination?: {
    readonly disputeId: string;
    readonly suspension: RetailRefundSuspensionState;
    readonly suspensionReason?: string;
  };
}

/** One supplier recovery, as an operator reads it. */
export interface SupplierRecoveryView {
  readonly id: string;
  readonly kind: SupplierRecoveryKind;
  readonly state: SupplierRecoveryState;
  readonly expectedAmount?: Money;
  readonly creditedAmount?: Money;
  readonly purchaseOrderId?: string;
  readonly supplierReturnAuthorizationId?: string;
  readonly creditNoteReference?: string;
  readonly openedAt: string;
  readonly closedAt?: string;
}

/* -------------------------------------------------------------------------- */
/*  Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/** What a buyer sends to file a request. */
export interface SubmitRetailServiceRequestInput {
  readonly kind: RetailServiceRequestKind;
  readonly lines: readonly { readonly orderItemId: string; readonly quantity: number }[];
  readonly customerNote?: string;
  readonly evidence?: readonly RetailServiceEvidenceView[];
}

/** What Mercaria records when it decides. */
export interface DecideRetailServiceRequestInput {
  readonly accept: boolean;
  readonly outcome: RetailCustomerOutcome;
  readonly outcomeNote?: string;
  /** Where the goods go, on an accepted request whose kind opens a return case. */
  readonly returnDestination?: RetailReturnDestination;
}
