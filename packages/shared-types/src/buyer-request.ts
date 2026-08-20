/**
 * Buyer post-purchase REQUESTS — cancellations, returns and support (#110,
 * ADR 0003 D5/D13/D16/D17).
 *
 * #105 let a guest place an order, #106 made it readable and ownable, #108 gave
 * them a scoped way back to it. This module is what they can ASK FOR once they
 * are there, and the whole design rests on one sentence.
 *
 * ## A buyer never sets order status; a buyer files a REQUEST
 *
 * The tempting shape is an endpoint that cancels. It is wrong for a reason that
 * has nothing to do with guests: cancelling a paid order has to return money,
 * restock goods and respect a seller's fulfilment state, and every one of those
 * belongs to a service that already exists and already gets it right. A
 * "cancel" endpoint would be a second, weaker copy of all three, reachable by
 * the least-authenticated actor in the system.
 *
 * So a buyer writes a row. A SELLER (or an operator) decides it. The decision
 * then drives `order.service.transition` or `refund.service.process` — the same
 * functions a merchant's own dashboard drives — and stamps the request
 * `completed` only once they have returned. Nothing in the request vocabulary
 * below can name an order status, a refund amount, a payment provider or an
 * inventory location, which is what makes "a guest cannot mutate status or
 * provider payment directly" (acceptance 2) a property of the types.
 *
 * ## What is deliberately ABSENT from every shape here
 *
 * No email, no phone, no postal address, no payment-method detail, no card
 * fingerprint, no guest token and no email hash. A buyer request is identified
 * by an ORDER and authorized by a credential resolved elsewhere; the contact it
 * would be answered to lives on `guest_checkouts` and is read only by the send
 * path. {@link BUYER_REQUEST_FORBIDDEN_IDENTIFIERS} names the prohibition as a
 * value so a scanned gate can assert it, the `RETAIL_FORBIDDEN_COMPONENT_KINDS`
 * device.
 */

/* -------------------------------------------------------------------------- */
/*  What a request may never be identified or authorized by                    */
/* -------------------------------------------------------------------------- */

/**
 * Handles that can never authorize or identify a buyer request (#110
 * authorization rule 6).
 *
 * Stated as VALUES rather than as prose, and asserted DISJOINT from everything
 * this domain does record, so "an order number plus an email address is not a
 * password" is a build failure rather than a review comment. The list is longer
 * than rule 6's five because the neighbouring ones are the plausible additions:
 * a Stripe customer id and a payment-method fingerprint are exactly what
 * somebody reaches for when a buyer writes in saying "it is my card".
 */
export const BUYER_REQUEST_FORBIDDEN_IDENTIFIERS = [
  'order_number',
  'buyer_email',
  'buyer_email_hash',
  'buyer_phone',
  'cart_session_token',
  'guest_session_id',
  'stripe_customer_id',
  'payment_method_fingerprint',
  'card_last_four',
  'client_ip_address',
] as const;

/** One of {@link BUYER_REQUEST_FORBIDDEN_IDENTIFIERS}. */
export type BuyerRequestForbiddenIdentifier =
  (typeof BUYER_REQUEST_FORBIDDEN_IDENTIFIERS)[number];

/* -------------------------------------------------------------------------- */
/*  Who acted                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The kinds of actor that can appear on a buyer request or its audit trail.
 *
 * Identical membership to `ORDER_ACTOR_KINDS` and deliberately its own tuple:
 * the order's audit records who moved a STATUS, this records who moved a
 * REQUEST, and collapsing them would make a future divergence in either
 * (a `system` sweep that may close a request but may never ship an order, say)
 * silently change the other.
 */
export const BUYER_REQUEST_ACTOR_KINDS = ['oxy', 'guest', 'operator', 'system'] as const;

/** One of {@link BUYER_REQUEST_ACTOR_KINDS}. */
export type BuyerRequestActorKind = (typeof BUYER_REQUEST_ACTOR_KINDS)[number];

/**
 * Why a completion step did not complete. BOUNDED, never a provider's string.
 *
 * The `guest_portal_messages.last_failure` reasoning: a rail's own error text is
 * somebody else's vocabulary, routinely quotes an amount or an account, and is
 * read here by a merchant rather than by an operator. A closed set is what lets
 * the merchant surface say what went wrong without quoting one.
 */
export const BUYER_REQUEST_COMPLETION_FAILURES = [
  /** The order moved underneath the decision (a concurrent transition). */
  'order_state_changed',
  /** The refund service refused — over-refund, unpaid order, closed order. */
  'refund_refused',
  /** No refund path exists for this order's seller shape. See the docs. */
  'refund_path_unavailable',
  /** Something else failed and was logged; the retry is the same call. */
  'unexpected_error',
] as const;

/** One of {@link BUYER_REQUEST_COMPLETION_FAILURES}. */
export type BuyerRequestCompletionFailure =
  (typeof BUYER_REQUEST_COMPLETION_FAILURES)[number];

/**
 * Why a DECISION was refused — the bounded `detail` on a `decision_refused`
 * event (#743).
 *
 * The `BUYER_REQUEST_COMPLETION_FAILURES` reasoning, for the other half of the
 * trail: an operator reads this during an incident, so it must say what happened
 * without quoting an exception's message. Every member names a refusal a SELLER
 * can actually meet, which is what makes the row worth reading — "somebody tried
 * to decide this and was told no, for this reason".
 *
 * A request that does not EXIST has no member here and cannot get one: the event
 * carries a foreign key to its request and `buyer_request_events_subject_check`
 * demands exactly one subject, so an attempt on a missing id has nowhere to be
 * recorded. That is a property of the trail being per-request, not an omission.
 */
export const BUYER_REQUEST_DECISION_REFUSALS = [
  /** Already decided, and not a converging repeat of the same decision. */
  'already_decided',
  /** A rejection arrived without the note that has to say why. */
  'rejection_note_missing',
  /** An approved line was never part of the request. */
  'line_not_requested',
  /** An approved quantity is more than the buyer asked for, or negative. */
  'quantity_exceeds_requested',
  /** The compare-and-swap lost: somebody else decided it first. */
  'concurrently_decided',
] as const;

/** One of {@link BUYER_REQUEST_DECISION_REFUSALS}. */
export type BuyerRequestDecisionRefusal = (typeof BUYER_REQUEST_DECISION_REFUSALS)[number];

/**
 * Why a transition OTHER than a decision was refused — the bounded `detail` on
 * the five refusal kinds #765 adds.
 *
 * A separate tuple from {@link BUYER_REQUEST_DECISION_REFUSALS} rather than a
 * widening of it, because the two answer different questions and a shared set
 * would admit `order_missing` on a decision and `rejection_note_missing` on a
 * receipt — codes that name nothing the reader of that row could act on. The
 * KIND says which transition was attempted and the reason says why it was
 * refused; keeping the pair that way is what lets one small tuple serve five
 * kinds without any of them acquiring a code it can never carry.
 *
 * Not every reason is reachable from every kind, exactly as
 * `rejection_note_missing` is reachable only from a rejection. What each kind
 * can actually carry is a property of its producer, and
 * `buyer-request-isolation.test.ts` requires every member here to have one.
 *
 * A request that does not EXIST has no member here either, for the reason the
 * decision tuple states: the event names its request by foreign key, so an
 * attempt on a missing id has nowhere to be recorded.
 */
export const BUYER_REQUEST_TRANSITION_REFUSALS = [
  /** The request is not in a state this transition may run from. */
  'state_not_eligible',
  /** The order the request names could not be loaded. */
  'order_missing',
  /** The compare-and-swap lost: the request moved under the attempt. */
  'concurrently_updated',
  /**
   * The refund service reported success and no refund carries the request's
   * key — an inconsistency rather than a refusal a seller could have met, and
   * the row worth having precisely because nothing else records it.
   */
  'refund_absent',
] as const;

/** One of {@link BUYER_REQUEST_TRANSITION_REFUSALS}. */
export type BuyerRequestTransitionRefusal = (typeof BUYER_REQUEST_TRANSITION_REFUSALS)[number];

/* -------------------------------------------------------------------------- */
/*  Cancellation requests                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where a cancellation request stands — #110 cancellation field 5.
 *
 * FIVE states, and the pair worth explaining is `accepted` versus `completed`.
 * Rule 2 asks that "a request does not mark the order cancelled before payment,
 * inventory and seller rules complete", so acceptance is the seller's DECISION
 * and completion is the world having changed. They are separated because the
 * step between them can fail — a rail that will not refund, a concurrent
 * transition — and a single state would have to lie about which side of the
 * failure the request is on.
 *
 * There is deliberately no `failed`. A completion that did not complete leaves
 * the request `accepted` with a bounded {@link BuyerRequestCompletionFailure}
 * recorded beside it, so the retry is the same idempotent call rather than a
 * separate resurrection path — the `payment_repairs` posture.
 */
export const CANCELLATION_REQUEST_STATES = [
  /** The buyer asked. Nothing has moved. */
  'submitted',
  /** A seller or operator agreed; completion is owed and may have failed. */
  'accepted',
  /** A seller or operator refused, with a reason the buyer can read. */
  'rejected',
  /** The buyer changed their mind before a decision. */
  'withdrawn',
  /** The order is cancelled or fully refunded, and the stock is back. */
  'completed',
] as const;

/** One of {@link CANCELLATION_REQUEST_STATES}. */
export type CancellationRequestState = (typeof CANCELLATION_REQUEST_STATES)[number];

/**
 * The states in which a cancellation request is still LIVE for its order.
 *
 * This tuple is rendered into the partial unique index that makes a repeated
 * submission converge (`cancellation_requests_open_order_key`), so the set the
 * service reasons about and the set the database enforces cannot drift.
 */
export const OPEN_CANCELLATION_REQUEST_STATES: readonly CancellationRequestState[] = [
  'submitted',
  'accepted',
];

/**
 * Why the buyer wants to cancel. A CLOSED taxonomy, never free text.
 *
 * The bounded note beside it is where a person writes a sentence; this is what a
 * seller filters on and what an aggregate counts. A free-text reason would be
 * both — and the aggregate would then be uncountable while the field quietly
 * accumulated addresses and phone numbers, which is the shape
 * `analytics_search_queries` spends a whole retention rule undoing.
 */
export const CANCELLATION_REQUEST_REASONS = [
  'ordered_by_mistake',
  'found_better_price',
  'changed_my_mind',
  'delivery_too_slow',
  'wrong_item_selected',
  'wrong_delivery_details',
  'no_longer_needed',
  'other',
] as const;

/** One of {@link CANCELLATION_REQUEST_REASONS}. */
export type CancellationRequestReason = (typeof CANCELLATION_REQUEST_REASONS)[number];

/**
 * How a cancellation, once accepted, actually undoes the order.
 *
 * Recorded on the request at SUBMISSION from the order's payment state at that
 * moment, and RE-DERIVED at completion — because the two can legitimately
 * differ (a buyer asks while the payment is still verifying, and it verifies a
 * second later) and the completion must follow the world rather than the
 * snapshot. The snapshot survives so the audit says what the buyer was told
 * when they asked.
 *
 * `release` returns a reservation and moves no money.
 * `refund` returns money AND stock, through `refund.service`, which is the only
 * thing in Mercaria that may do both.
 */
export const CANCELLATION_COMPLETION_MODES = ['release', 'refund'] as const;

/** One of {@link CANCELLATION_COMPLETION_MODES}. */
export type CancellationCompletionMode = (typeof CANCELLATION_COMPLETION_MODES)[number];

/**
 * Why an order cannot be cancelled — the "specific safe response" of rule 6.
 *
 * Every member says what the buyer should do NEXT, which is the whole reason
 * this is not one `not_cancellable` code: "it already shipped, open a return"
 * and "somebody already asked, look at that request" lead to opposite actions,
 * and a single code would send a person to the wrong one.
 *
 * None of them discloses anything about another buyer, another seller, another
 * sibling order or this order's contents.
 */
export const CANCELLATION_INELIGIBILITY_REASONS = [
  /**
   * The order is `mercaria_retail` and belongs to #127's domain.
   *
   * A CLEAN CUT rather than a shim. #110's decision path runs on
   * `requireStorePermission` against the order's STORE, and a `platform` order
   * has none — `orders.store_id` is NULL on one by CHECK — so a request filed
   * here would sit forever with nobody able to decide it. #127 answers the same
   * buyer with a decider that exists, and this reason names the path to take.
   */
  'retail_order',
  /** Dispatched or delivered. The remedy is a return — rule 6's "return path". */
  'order_already_dispatched',
  /** Already cancelled or fully refunded. There is nothing left to do. */
  'order_already_closed',
  /** A pickup order, while `STORE_PICKUP_ENABLED` is off in this deployment. */
  'pickup_not_supported',
  /** An imported connector order whose lifecycle Mercaria does not drive. */
  'external_order',
  /** A live request already exists; the buyer should read that one. */
  'request_already_open',
] as const;

/** One of {@link CANCELLATION_INELIGIBILITY_REASONS}. */
export type CancellationIneligibilityReason =
  (typeof CANCELLATION_INELIGIBILITY_REASONS)[number];

/**
 * The ineligibility reasons a RETURN is the buyer's next step for.
 *
 * Rule 6 asks that an ineligible order "may offer a return path", and this is
 * that offer as data rather than as a sentence in a template — so the storefront
 * renders a button from the same fact the service decided on.
 */
export const CANCELLATION_REASONS_OFFERING_RETURN: readonly CancellationIneligibilityReason[] =
  ['order_already_dispatched'];

/* -------------------------------------------------------------------------- */
/*  Return requests                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Where a return request stands — #110 return field 7.
 *
 * NINE states. Three pairs are worth explaining because each looks like one
 * state until you ask who acts next:
 *
 *  - `approved` vs `awaiting_item`. Approval is the seller agreeing the return
 *    is valid; `awaiting_item` is the seller having issued instructions and
 *    waiting for the parcel. The step between them carries the instructions
 *    themselves, which is the only place Mercaria records how goods come back —
 *    Moovo owns carriers and this issue explicitly forbids building one.
 *  - `withdrawn` vs `cancelled`. The buyer abandoned it, versus a seller or
 *    operator terminated an approved one. The issue's list says "cancelled";
 *    splitting it is the `ORDER_ACCESS_DENIAL_REASONS` habit — two facts about
 *    who acted should not share a word.
 *  - `refund_pending` vs `completed`. The commerce record has committed the
 *    refund and the rail has not finished. ADR 0001 D7 makes those two genuinely
 *    different facts and #49 already carries both; this state is where the
 *    difference is visible to the buyer.
 */
export const RETURN_REQUEST_STATES = [
  /** The buyer asked. Nothing has moved. */
  'requested',
  /** A seller or operator agreed the return is valid. */
  'approved',
  /** Instructions issued; the goods are on their way back. */
  'awaiting_item',
  /** The seller has the goods and can decide the resolution. */
  'received',
  /** A refund is committed and its money is still in flight. */
  'refund_pending',
  /** The resolution is done: money returned and stock restored. */
  'completed',
  /** A seller or operator refused, with a reason the buyer can read. */
  'rejected',
  /** The buyer changed their mind. */
  'withdrawn',
  /** A seller or operator terminated an approved return. */
  'cancelled',
] as const;

/** One of {@link RETURN_REQUEST_STATES}. */
export type ReturnRequestState = (typeof RETURN_REQUEST_STATES)[number];

/**
 * The states in which a return request is still LIVE for its order.
 *
 * Rendered into `return_requests_open_order_key`, so a buyer who taps twice, a
 * retried POST and two concurrent submissions all converge on one request
 * rather than opening a second one against the same order.
 */
export const OPEN_RETURN_REQUEST_STATES: readonly ReturnRequestState[] = [
  'requested',
  'approved',
  'awaiting_item',
  'received',
  'refund_pending',
];

/**
 * Why the buyer wants to return. A CLOSED taxonomy — #110 return field 2.
 *
 * The distinction that earns its own member is FAULT: `arrived_damaged`,
 * `wrong_item_sent` and `not_as_described` are the seller's problem and
 * `changed_my_mind` is not. Nothing in this domain acts on that difference
 * (Mercaria charges no return shipping and has no carrier), but a seller reading
 * a queue does, and folding them into one code would remove the only thing that
 * makes the queue triageable.
 */
export const RETURN_REQUEST_REASONS = [
  'arrived_damaged',
  'arrived_faulty',
  'wrong_item_sent',
  'not_as_described',
  'missing_parts',
  'wrong_size_or_fit',
  'changed_my_mind',
  'arrived_late',
  'other',
] as const;

/** One of {@link RETURN_REQUEST_REASONS}. */
export type ReturnRequestReason = (typeof RETURN_REQUEST_REASONS)[number];

/**
 * The reasons that assert the SELLER got it wrong.
 *
 * Not used to decide anything automatically, and that is deliberate: whether a
 * return is the seller's fault is a judgement about goods nobody in this domain
 * has seen. It exists so a merchant queue can sort by it and so the docs can
 * state that Mercaria does not adjudicate fault.
 */
export const SELLER_FAULT_RETURN_REASONS: readonly ReturnRequestReason[] = [
  'arrived_damaged',
  'arrived_faulty',
  'wrong_item_sent',
  'not_as_described',
  'missing_parts',
];

/**
 * What the buyer is asking for — #110 return field 5.
 *
 * `refund` is the supported outcome and drives `refund.service.process`.
 *
 * `replacement` is REPRESENTABLE and its approval is REFUSED, which is the
 * `role_email` decision from #83 rather than an omission. A replacement is a
 * second shipment against a line that is already paid: it needs an order that
 * charges nothing, reserves stock, and settles no seller — and Mercaria models
 * none of that. Keeping the value means the refusal names what the buyer asked
 * for, the merchant surface can offer "refund instead", and enabling it later is
 * a service change rather than a migration.
 */
export const RETURN_RESOLUTIONS = ['refund', 'replacement'] as const;

/** One of {@link RETURN_RESOLUTIONS}. */
export type ReturnResolution = (typeof RETURN_RESOLUTIONS)[number];

/** The resolutions this deployment can actually carry out. */
export const SUPPORTED_RETURN_RESOLUTIONS: readonly ReturnResolution[] = ['refund'];

/**
 * Why an order cannot be returned — the safe response, as for cancellations.
 *
 * `order_not_delivered` is the one to read: a return is a request to send goods
 * BACK, so it needs the goods to have gone out. An undispatched order's remedy
 * is a cancellation, and {@link RETURN_REASONS_OFFERING_CANCELLATION} says so as
 * data — the mirror of rule 6's return offer.
 */
export const RETURN_INELIGIBILITY_REASONS = [
  /** The order is `mercaria_retail` and belongs to #127. See the cancellation
   * reason of the same name for why this is a refusal rather than a fallback. */
  'retail_order',
  /** Not dispatched yet. The remedy is a cancellation. */
  'order_not_delivered',
  /** Already fully refunded or cancelled. */
  'order_already_closed',
  /** The return window closed. The deadline is snapshotted on the order's policy. */
  'return_window_closed',
  /** An imported connector order whose lifecycle Mercaria does not drive. */
  'external_order',
  /** A live request already exists; the buyer should read that one. */
  'request_already_open',
  /** Every unit of every line has already been returned or refunded. */
  'nothing_left_to_return',
] as const;

/** One of {@link RETURN_INELIGIBILITY_REASONS}. */
export type ReturnIneligibilityReason = (typeof RETURN_INELIGIBILITY_REASONS)[number];

/** The ineligibility reasons a CANCELLATION is the buyer's next step for. */
export const RETURN_REASONS_OFFERING_CANCELLATION: readonly ReturnIneligibilityReason[] = [
  'order_not_delivered',
];

/**
 * What a piece of buyer-supplied return evidence is a picture OF.
 *
 * Evidence is DECLARED, never attached — a bare Oxy `fileId` the buyer already
 * uploaded to their own Oxy storage, exactly as `abuse_reports` evidence is.
 * Mercaria stores the reference and never a URL, never a copy and never a
 * digest it cannot verify: it holds no Oxy service credential, so
 * `getServiceAssetMetadataByIds` would throw, and asserting a hash it never
 * computed would be worse than admitting it has none. That gap is stated in
 * `docs/buyer-requests.md` and is the SAME one the moderation domain documents.
 */
export const RETURN_EVIDENCE_KINDS = [
  'damage_photo',
  'packaging_photo',
  'item_photo',
  'label_photo',
  'other_photo',
] as const;

/** One of {@link RETURN_EVIDENCE_KINDS}. */
export type ReturnEvidenceKind = (typeof RETURN_EVIDENCE_KINDS)[number];

/* -------------------------------------------------------------------------- */
/*  Support threads                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Where a support thread stands.
 *
 * `closed` is reversible by anyone who may write to the thread — a buyer
 * replying reopens it — because a closed thread that cannot be reopened just
 * teaches people to open a second one. #110 support rule 9 ("thread closure does
 * not remove financial or dispute records") is a property of what closing does
 * NOT touch: it writes one column on one row and reads nothing else.
 */
export const SUPPORT_THREAD_STATES = ['open', 'closed'] as const;

/** One of {@link SUPPORT_THREAD_STATES}. */
export type SupportThreadState = (typeof SUPPORT_THREAD_STATES)[number];

/**
 * Who wrote a support message.
 *
 * A narrower set than {@link BUYER_REQUEST_ACTOR_KINDS} on purpose: `system` is
 * absent because every message in a thread has a person behind it, and a
 * system-authored message would be a notification wearing a conversation's
 * clothes — those go through `guest_portal_messages`, which the recipient can
 * suppress. The two guest/oxy buyer kinds collapse to `buyer` because a seller
 * reading the thread must not learn which one it was (#106's `Guest` label rule,
 * applied to a conversation).
 */
export const SUPPORT_MESSAGE_AUTHOR_KINDS = ['buyer', 'seller', 'operator'] as const;

/** One of {@link SUPPORT_MESSAGE_AUTHOR_KINDS}. */
export type SupportMessageAuthorKind = (typeof SUPPORT_MESSAGE_AUTHOR_KINDS)[number];

/**
 * What a redaction pass replaced in a support message body.
 *
 * Recorded per message so a reader knows something was removed rather than
 * wondering why a sentence stops. The set is what Mercaria can recognise with
 * confidence and no more: an over-eager rule that ate order numbers and postal
 * codes would make the channel useless for the thing it exists for.
 */
export const SUPPORT_REDACTION_KINDS = [
  'payment_card',
  'iban',
  'email_address',
  'phone_number',
  'access_token',
] as const;

/** One of {@link SUPPORT_REDACTION_KINDS}. */
export type SupportRedactionKind = (typeof SUPPORT_REDACTION_KINDS)[number];

/**
 * What a support thread may NEVER become, stated as values.
 *
 * #110 support rule 7 forbids a support message becoming a public review or a
 * CrowdSource case automatically, and rule 8 routes abuse to the existing
 * moderation path. Both are held by absence — this domain writes no `reviews`
 * row and no `abuse_reports` row, and `buyer-request-isolation.test.ts` fails
 * the build if a module here learns to. The tuple is what that gate asserts
 * against, so the prohibition is a value a reviewer can find rather than a
 * property of code that happens not to exist yet.
 */
export const SUPPORT_FORBIDDEN_AUTOMATIC_OUTCOMES = [
  'public_review',
  'crowdsource_case',
  'seller_rating',
  'trust_signal',
  'marketing_subscription',
] as const;

/** One of {@link SUPPORT_FORBIDDEN_AUTOMATIC_OUTCOMES}. */
export type SupportForbiddenAutomaticOutcome =
  (typeof SUPPORT_FORBIDDEN_AUTOMATIC_OUTCOMES)[number];

/* -------------------------------------------------------------------------- */
/*  The audit trail                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The five transitions whose REFUSAL the trail records, beside the six
 * successes it already did (#765).
 *
 * #743 gave the decision transition a refusal kind and left `decision_refused`
 * as the only one, so the trail still answered "did anybody try to mark this
 * received and get told no" with silence. Recording that under
 * `decision_refused` was rejected there and is rejected here: a trail that
 * MISLABELS what was refused is worse than one that is silent, because silence
 * at least does not send an operator looking at the wrong transition.
 *
 * One kind per refusable transition rather than one `attempt_refused` whose
 * detail names the transition — the second spelling has nowhere left to put the
 * REASON, and it would make `detail` mean the transition here and the reason on
 * a `decision_refused` row one line above it in the same trail.
 *
 * `refund_settled` has no member here on purpose. Its transition
 * (`reconcileReturnRefund`) refuses nothing: it converges when the rail has not
 * answered and records `completion_failed` when the rail says the money did not
 * go. A kind minted for symmetry would be one nothing could ever write, which is
 * the defect #743 was filed for.
 */
export const BUYER_REQUEST_TRANSITION_REFUSAL_KINDS = [
  /**
   * A cancellation completion did not run. The PAIR with `completion_failed` is
   * the point: that one says Mercaria tried and the world said no, this one says
   * Mercaria never asked. An operator reading the trail during an incident draws
   * opposite conclusions from them, which is why widening either to cover the
   * other would be worse than the silence #765 found.
   */
  'completion_refused',
  /** Return instructions were not issued. Mirrors `instructions_issued`. */
  'instructions_refused',
  /** A return was not marked received. Mirrors `item_received`. */
  'receipt_refused',
  /**
   * A return refund was not committed. Mirrors `refund_committed`, and spelled
   * for the COMMIT rather than as `refund_refused`, which is already a
   * {@link BUYER_REQUEST_COMPLETION_FAILURES} member meaning the rail said no —
   * one word appearing in the `kind` and the `detail` of one table with two
   * meanings is a trail that misleads whoever reads it fastest.
   */
  'refund_commit_refused',
  /**
   * A seller's termination of a return did not run. Mirrors `cancelled`, and
   * named for the RETURN because "cancellation" is also a request kind in this
   * domain — an event named `cancellation_refused` on a return's trail reads as
   * a refused cancellation REQUEST.
   */
  'return_cancellation_refused',
] as const;

/** One of {@link BUYER_REQUEST_TRANSITION_REFUSAL_KINDS}. */
export type BuyerRequestTransitionRefusalKind =
  (typeof BUYER_REQUEST_TRANSITION_REFUSAL_KINDS)[number];

/**
 * Every recorded transition of a buyer request — #110 cancellation field 6/7
 * and return field 11 ("full audit").
 *
 * Append-only, one row per ATTEMPT including refusals, the `payment_repairs`
 * posture. A refused decision is the row worth having: an audit that recorded
 * only successes answers "did anybody try to cancel this" with silence.
 */
export const BUYER_REQUEST_EVENT_KINDS = [
  'submitted',
  'withdrawn',
  'accepted',
  'rejected',
  'instructions_issued',
  'item_received',
  'refund_committed',
  'refund_settled',
  'completed',
  'cancelled',
  'completion_failed',
  /**
   * #743's refusal kind — the first of the six, and the only one with its own
   * reason vocabulary. The other five are spread in below.
   */
  'decision_refused',
  // SPREAD rather than repeated, so the tuple the CHECK is rendered from and the
  // tuple `refuseTransition` accepts cannot drift — a kind in the second and not
  // the first would type-check and then violate `buyer_request_events_kind_check`
  // at the moment somebody was being refused, which is the worst time to lose a
  // row.
  ...BUYER_REQUEST_TRANSITION_REFUSAL_KINDS,
] as const;

/** One of {@link BUYER_REQUEST_EVENT_KINDS}. */
export type BuyerRequestEventKind = (typeof BUYER_REQUEST_EVENT_KINDS)[number];

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/** The longest free-text note a buyer or a seller may attach to a request. */
export const BUYER_REQUEST_NOTE_MAX_LENGTH = 1_000;

/** The longest single support message body. */
export const SUPPORT_MESSAGE_MAX_LENGTH = 4_000;

/** The most evidence references one return request may declare. */
export const RETURN_EVIDENCE_MAX_COUNT = 10;

/**
 * How long after delivery a return may be opened, unless a store's own policy
 * says otherwise.
 *
 * A DEFAULT rather than the rule: #110 return field 9 asks for deadlines
 * "snapshotted from policy", and the snapshot is what a request carries. This
 * constant is what the snapshot is taken from when a store has stated nothing,
 * and it is a code constant rather than an environment variable for the reason
 * every policy key in this repository is — a deployment that can shorten a
 * consumer's return window from a dashboard has made a legal decision by
 * accident.
 */
export const DEFAULT_RETURN_WINDOW_DAYS = 30;

/* -------------------------------------------------------------------------- */
/*  DTOs — the buyer's view                                                    */
/* -------------------------------------------------------------------------- */

/** One order line a request covers, with the quantity actually agreed. */
export interface BuyerRequestLine {
  /** The variant the order line names. */
  variantId: string;
  /** How many units the buyer asked about. */
  requestedQuantity: number;
  /**
   * How many the seller agreed to — `null` until a decision.
   *
   * A separate number from the request rather than an edit of it, so "you asked
   * for three and we agreed two" is visible to both sides. It is also the ONLY
   * quantity the refund and the restock are computed from, which is #110 refund
   * rule 5 ("restock only approved quantities") held by having nothing else to
   * reach for.
   */
  approvedQuantity: number | null;
}

/** A declared piece of return evidence. A reference, never a copy. */
export interface ReturnEvidenceRef {
  /** The Oxy file id. Never a URL, and never a `mercaria.co` one. */
  fileId: string;
  kind: ReturnEvidenceKind;
  position: number;
}

/** What a BUYER sees of their own cancellation request. */
export interface CancellationRequestView {
  id: string;
  orderId: string;
  state: CancellationRequestState;
  reason: CancellationRequestReason;
  /** The buyer's own words, bounded. Absent when they wrote none. */
  note?: string;
  /** Whole-order when empty; otherwise the lines they named. */
  lines: BuyerRequestLine[];
  /** How this would be undone, as judged when it was asked. */
  completionMode: CancellationCompletionMode;
  /** Why a seller refused. Present only in `rejected`. */
  decisionNote?: string;
  /** What is still owed, when a completion has failed. */
  completionFailure?: BuyerRequestCompletionFailure;
  createdAt: string;
  decidedAt: string | null;
  completedAt: string | null;
}

/** What a BUYER sees of their own return request. */
export interface ReturnRequestView {
  id: string;
  orderId: string;
  state: ReturnRequestState;
  reason: ReturnRequestReason;
  resolution: ReturnResolution;
  note?: string;
  lines: BuyerRequestLine[];
  evidence: ReturnEvidenceRef[];
  /** How the goods come back. The seller's own words; Mercaria composes none. */
  returnInstructions?: string;
  decisionNote?: string;
  completionFailure?: BuyerRequestCompletionFailure;
  /** The deadline this request was opened under, snapshotted from policy. */
  returnWindowEndsAt: string;
  /** The buyer-visible deadline for sending the goods back, when one was set. */
  shipBackDeadlineAt: string | null;
  createdAt: string;
  decidedAt: string | null;
  completedAt: string | null;
}

/** One message in a support thread, as either side sees it. */
export interface SupportMessageView {
  id: string;
  authorKind: SupportMessageAuthorKind;
  /**
   * A stable, thread-local label for the author — `Buyer`, `Seller`, `Mercaria`.
   *
   * Never a name, never an email, never an Oxy handle and never a per-person
   * identifier: #106's `Guest` rule says any per-buyer label is a correlation
   * key wearing a display name, and the same is true of a seller's staff member.
   */
  authorLabel: string;
  body: string;
  /** What a redaction pass removed, if anything. */
  redactions: SupportRedactionKind[];
  createdAt: string;
}

/** A support thread and its messages. */
export interface SupportThreadView {
  id: string;
  orderId: string;
  /** Present when the thread is anchored to a specific return request. */
  returnRequestId: string | null;
  state: SupportThreadState;
  messages: SupportMessageView[];
  createdAt: string;
  updatedAt: string;
}

/**
 * What a buyer may do with one order right now, and why not when they may not.
 *
 * Computed rather than stored — the `deriveNativeCheckoutEligibility`
 * divergence from the one-stored-verdict rule, for the same reason: the inputs
 * are the live order status, the live payment status, the live refund history
 * and any open request, which sit on four tables this domain does not own. A
 * stored verdict would go stale the moment a seller shipped, and the place it
 * must not be stale is a button that says "cancel".
 */
export interface BuyerOrderRequestOptions {
  orderId: string;
  /** Whether a cancellation may be opened, and the safe reason when not. */
  cancellation:
    | { available: true }
    | {
        available: false;
        reason: CancellationIneligibilityReason;
        /** Rule 6's return offer, as data. */
        returnAvailable: boolean;
      };
  /** Whether a return may be opened, and the safe reason when not. */
  return:
    | { available: true; windowEndsAt: string }
    | {
        available: false;
        reason: ReturnIneligibilityReason;
        cancellationAvailable: boolean;
      };
  /** Whether this credential may write into a support thread. */
  supportAvailable: boolean;
}

/* -------------------------------------------------------------------------- */
/*  DTOs — the merchant's view                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every field a merchant projection is allowed to carry.
 *
 * An ALLOW-LIST as a value, not an `Omit`. `Omit<T, never>` was the first
 * spelling here and it is exactly the check this repository keeps finding: it
 * compiles, it looks like the `MerchantOrder` device, and it can never fail —
 * there is no buyer-identifying field on a request today, so subtracting the
 * empty set enforces nothing and would go on enforcing nothing after somebody
 * added one.
 *
 * This tuple is what `buyer-request-merchant-projection.test.ts` walks a REAL
 * emitted projection against, so a field added to the row and forwarded by a
 * serializer fails the build whether or not anybody remembered this file. The
 * runtime walk is the gate; the type below is the compiler's half of it.
 */
export const MERCHANT_BUYER_REQUEST_FIELDS = [
  'id',
  'orderId',
  'state',
  'reason',
  'note',
  'lines',
  'completionMode',
  'resolution',
  'evidence',
  'returnInstructions',
  'decisionNote',
  'completionFailure',
  'returnWindowEndsAt',
  'shipBackDeadlineAt',
  'createdAt',
  'decidedAt',
  'completedAt',
  'requesterLabel',
] as const;

/** One of {@link MERCHANT_BUYER_REQUEST_FIELDS}. */
export type MerchantBuyerRequestField = (typeof MERCHANT_BUYER_REQUEST_FIELDS)[number];

/**
 * What a MERCHANT sees of a cancellation request.
 *
 * Every field named explicitly, the `provider_accounts` status-projection rule.
 * The one addition to the buyer's view is `requesterLabel`, which is the literal
 * `Buyer` — never `Guest`, never `Guest #4821`, never an Oxy handle. #106
 * establishes that any per-buyer label is a correlation key wearing a display
 * name; #110 additionally refuses the BUYER-ORIGIN discriminant, because a
 * merchant deciding a cancellation must not be able to treat a guest's request
 * differently from an account holder's (merchant rule 7).
 */
export interface MerchantCancellationRequestView {
  id: string;
  orderId: string;
  state: CancellationRequestState;
  reason: CancellationRequestReason;
  note?: string;
  lines: BuyerRequestLine[];
  completionMode: CancellationCompletionMode;
  decisionNote?: string;
  completionFailure?: BuyerRequestCompletionFailure;
  createdAt: string;
  decidedAt: string | null;
  completedAt: string | null;
  /** Always the literal `Buyer`. See the docblock. */
  requesterLabel: string;
}

/** What a MERCHANT sees of a return request. Same rule as above. */
export interface MerchantReturnRequestView {
  id: string;
  orderId: string;
  state: ReturnRequestState;
  reason: ReturnRequestReason;
  resolution: ReturnResolution;
  note?: string;
  lines: BuyerRequestLine[];
  evidence: ReturnEvidenceRef[];
  returnInstructions?: string;
  decisionNote?: string;
  completionFailure?: BuyerRequestCompletionFailure;
  returnWindowEndsAt: string;
  shipBackDeadlineAt: string | null;
  createdAt: string;
  decidedAt: string | null;
  completedAt: string | null;
  /** Always the literal `Buyer`. See the docblock. */
  requesterLabel: string;
}

/* -------------------------------------------------------------------------- */
/*  Request bodies                                                             */
/* -------------------------------------------------------------------------- */

/** What a buyer sends to open a cancellation request. */
export interface SubmitCancellationRequestInput {
  reason: CancellationRequestReason;
  note?: string;
  /** Omit for the whole order. Naming lines cancels only those units. */
  lines?: { variantId: string; quantity: number }[];
}

/** What a buyer sends to open a return request. */
export interface SubmitReturnRequestInput {
  reason: ReturnRequestReason;
  resolution: ReturnResolution;
  note?: string;
  lines: { variantId: string; quantity: number }[];
  evidence?: { fileId: string; kind: ReturnEvidenceKind }[];
}

/** What a seller or operator sends to decide a request. */
export interface DecideBuyerRequestInput {
  decision: 'accept' | 'reject';
  /** Mandatory on a rejection — #110 cancellation rule 8. */
  note?: string;
  /** Per-line agreed quantities. Omit to agree to everything requested. */
  lines?: { variantId: string; quantity: number }[];
}
