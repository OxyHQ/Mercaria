/**
 * Discovery analytics and search-success measurement (#77).
 *
 * ONE versioned envelope, a closed event vocabulary, an ALLOW-LIST of typed
 * properties, and the metric definitions themselves — as data, so a dashboard
 * cannot render a number whose numerator, denominator, window, source of truth
 * and freshness are unstated.
 *
 * ## The privacy boundary this module exists to make structural
 *
 * ADR 0003 I12 binds it: analytics receives a pseudonymous actor dimension or,
 * only where a documented funnel metric requires continuity, an opaque
 * checkout correlation — never email, an email hash, a phone number, a card
 * fingerprint, a provider customer identity, an IP address, a device
 * fingerprint or a bearer token. None of those appears in any type here, which
 * is the point: a field that does not exist cannot be populated by mistake.
 *
 * Two consequences follow and are worth stating in the contract rather than in
 * a comment somewhere downstream:
 *
 *  - **A pseudonymous session id is not a user id.** It is a one-way hash under
 *    a SERVER-held salt that rotates on a schedule, so it identifies a session
 *    within one epoch and nothing across epochs — not even to Mercaria, because
 *    the old salt is deleted rather than archived.
 *  - **Financial truth is never a client event.** No event type in this module
 *    asserts that money moved. Native paid orders, refunds and affiliate
 *    conversions join through their own durable ids; every metric that counts
 *    them names `payments`, `orders`, `refunds` or `affiliate_reports` as its
 *    source of truth, and {@link ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES} makes
 *    it impossible for a browser to claim one.
 */

import type { GuestPaymentMethodCategory } from './guest-governance';

/**
 * The envelope contract version.
 *
 * Stored on every row, so a reader can tell which shape it is looking at
 * without inferring it from which columns happen to be populated. It moves when
 * a FIELD's meaning changes, not when a new event type is added — a new type is
 * additive and every existing metric keeps its definition.
 */
export const ANALYTICS_ENVELOPE_VERSION = '2026-08-09.1';

/* -------------------------------------------------------------------------- */
/*  Actor, surface and traffic dimensions                                      */
/* -------------------------------------------------------------------------- */

/**
 * The actor dimension — deliberately the SAME three words `CommerceActor`
 * uses (ADR 0003 D1).
 *
 * Not a convenience: a second vocabulary for "who was this" is a second thing
 * that can disagree with the authorization layer, and the disagreement that
 * matters is a funnel that reports a guest as authenticated. There is no
 * `claimed` kind and there must never be one — merchant-facing analytics must
 * not be able to say a named Oxy user began as a guest (issue rule 7), and the
 * cleanest way to guarantee that is to have no field that could.
 */
export const ANALYTICS_ACTOR_KINDS = ['oxy', 'guest', 'anonymous'] as const;

/** One of {@link ANALYTICS_ACTOR_KINDS}. */
export type AnalyticsActorKind = (typeof ANALYTICS_ACTOR_KINDS)[number];

/**
 * Which client produced the event.
 *
 * Platform is folded in (`storefront_web` vs `storefront_native`) because
 * "funnel drop-off by client platform" is a named dashboard and splitting the
 * app from the platform would need two columns that are only ever read
 * together.
 */
export const ANALYTICS_CLIENT_SURFACES = [
  'storefront_web',
  'storefront_native',
  'dashboard_web',
  'dashboard_native',
  'pos_web',
  'pos_native',
  'api',
] as const;

/** One of {@link ANALYTICS_CLIENT_SURFACES}. */
export type AnalyticsClientSurface = (typeof ANALYTICS_CLIENT_SURFACES)[number];

/**
 * Bot, preview and internal traffic — classified SEPARATELY, never dropped.
 *
 * Dropping a crawler's request would make "how much of our traffic is
 * automated" unanswerable, and the acceptance criterion is that previews do not
 * INFLATE offer impressions and affiliate CTR — which is a property of the
 * metric's denominator, not of what was collected. Every metric that could be
 * inflated names `humanOnly: true`, and the rollup filters on this column.
 *
 * `unknown` exists because an honest "we could not tell" is better than
 * silently defaulting to `human`: a metric that excludes bots must know which
 * rows it is unsure about.
 */
export const ANALYTICS_TRAFFIC_CLASSES = [
  'human',
  'internal',
  'crawler',
  'link_preview',
  'email_scanner',
  'automated_client',
  'unknown',
] as const;

/** One of {@link ANALYTICS_TRAFFIC_CLASSES}. */
export type AnalyticsTrafficClass = (typeof ANALYTICS_TRAFFIC_CLASSES)[number];

/**
 * The traffic classes a human-only metric counts. Exactly one member today,
 * and it is a TUPLE rather than a `=== 'human'` comparison so widening it (say,
 * to admit `unknown` in a market with no reliable signal) is one edit with one
 * place to argue about.
 */
export const ANALYTICS_HUMAN_TRAFFIC_CLASSES = ['human'] as const;

/**
 * Consent, as the launch jurisdiction requires it to be recorded.
 *
 * `not_required` is a real answer, not a synonym for `granted`: a purely
 * operational event in a jurisdiction with no consent requirement was never
 * asked, and recording it as granted would misstate what happened if the
 * requirement later changed.
 */
export const ANALYTICS_CONSENT_STATES = [
  'granted',
  'denied',
  'not_required',
  'unknown',
] as const;

/** One of {@link ANALYTICS_CONSENT_STATES}. */
export type AnalyticsConsentState = (typeof ANALYTICS_CONSENT_STATES)[number];

/**
 * How much this deployment collects — the flag that keeps production dark until
 * the privacy and retention review clears (acceptance 8).
 *
 * `off` never reaches a stored row: it is the mode in which nothing is
 * recorded at all, and it exists in the tuple so the configured value is always
 * one of a closed set rather than a boolean somebody has to remember the
 * polarity of.
 */
export const ANALYTICS_COLLECTION_MODES = ['off', 'essential', 'full'] as const;

/** One of {@link ANALYTICS_COLLECTION_MODES}. */
export type AnalyticsCollectionMode = (typeof ANALYTICS_COLLECTION_MODES)[number];

/**
 * The buyer-origin dimension — carried ONLY where a metric genuinely compares
 * the authenticated and guest flows (envelope field 12).
 *
 * There are two values and no third, deliberately. A `claimed` value would be
 * exactly the retroactive identity join ADR 0003 I12 forbids: it would say of a
 * named Oxy user that they began as a guest, which is issue rule 7's whole
 * subject.
 */
export const ANALYTICS_BUYER_ORIGINS = ['authenticated', 'guest'] as const;

/** One of {@link ANALYTICS_BUYER_ORIGINS}. */
export type AnalyticsBuyerOrigin = (typeof ANALYTICS_BUYER_ORIGINS)[number];

/* -------------------------------------------------------------------------- */
/*  Event vocabulary                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The initial discovery event set (#77 "Initial discovery events" 1–14).
 *
 * `native_add_to_cart` and `checkout_started` are here rather than in the guest
 * list because they are emitted for EVERY actor kind — the actor dimension is
 * what tells the two funnels apart, which is what "authenticated and guest
 * native checkout funnels with the same definitions" means mechanically.
 */
export const ANALYTICS_DISCOVERY_EVENT_TYPES = [
  'search_submitted',
  'search_results_returned',
  'search_zero_results',
  'search_result_impression',
  'search_result_click',
  'entity_suggestion_click',
  'product_page_view',
  'variant_selected',
  'offer_impression',
  'offer_expanded',
  'offer_selected',
  'external_outbound_click',
  'native_add_to_cart',
  'checkout_started',
  'save_action',
  'alert_action',
  'watchlist_action',
  'merchant_claim_entry',
  'sell_yours_entry',
  'surface_error',
] as const;

/**
 * The guest-commerce event set (#77 "Guest-commerce events" 1–14).
 *
 * Everything the code paths that exist TODAY can honestly emit, plus the ones
 * whose owning issue has not landed. The second group is not dropped and is not
 * faked: it is listed in {@link ANALYTICS_DEFERRED_EVENT_TYPES} with the issue
 * that owes it, and `analytics-seams.test.ts` fails the build if any module
 * emits one. A seam, never a fabricated event.
 */
export const ANALYTICS_GUEST_EVENT_TYPES = [
  // Emitted today.
  'guest_session_issued',
  'guest_cart_created',
  'guest_cart_item_added',
  'guest_cart_item_updated',
  'guest_cart_item_removed',
  'guest_cart_merged',
  'guest_checkout_started',
  'guest_feature_gate_blocked',
  // Emitted since #106, from the checkout controller's gate classification.
  'guest_contact_validated',
  'guest_contact_validation_failed',
  'guest_destination_validated',
  'guest_destination_validation_failed',
  'guest_eligibility_accepted',
  'guest_eligibility_rejected',
  // Below: some emitted, some deferred. `ANALYTICS_DEFERRED_EVENT_TYPES` is the
  // AUTHORITY on which is which and this ordering is not — the three #108
  // portal types are emitted and sit here because moving a member of a closed
  // tuple rewrites the `analytics_events_event_type_check` CHECK for no change
  // in what it admits, and a DROP/ADD pair whose member set is identical is
  // exactly the statement a migration reviewer must not have to reason about.
  'guest_payment_methods_shown',
  'guest_payment_method_selected',
  'guest_payment_action_required',
  'guest_payment_client_failed',
  'guest_payment_verified',
  // EMITTED since #108 — see the note above on why they stay in place.
  'guest_order_portal_opened',
  'guest_recovery_requested',
  'guest_recovery_exchanged',
  'guest_claim_offered',
  'guest_claim_started',
  'guest_claim_completed',
  'guest_claim_declined',
  'guest_claim_conflicted',
  'guest_cancellation_requested',
  'guest_return_requested',
  'guest_support_request_created',
] as const;

/** Experiment exposure — its own class, because its retention differs. */
export const ANALYTICS_EXPERIMENT_EVENT_TYPES = ['experiment_exposed'] as const;

/** Every event type Mercaria's analytics vocabulary contains. */
export const ANALYTICS_EVENT_TYPES = [
  ...ANALYTICS_DISCOVERY_EVENT_TYPES,
  ...ANALYTICS_GUEST_EVENT_TYPES,
  ...ANALYTICS_EXPERIMENT_EVENT_TYPES,
] as const;

/** One of {@link ANALYTICS_EVENT_TYPES}. */
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

/**
 * Event types whose owning issue has NOT landed, and which issue owes each.
 *
 * They are in the vocabulary — the CHECK admits them, the metric registry
 * refers to them, the retention class covers them — and NOTHING emits them.
 * That is the difference between a seam and a gap: a reader of the metric
 * definitions can see exactly which numbers are not yet producible and why,
 * instead of finding a metric that silently reads zero forever.
 */
export const ANALYTICS_DEFERRED_EVENT_TYPES: Readonly<
  Partial<Record<AnalyticsEventType, string>>
> = {
  // The six `#106` types that used to sit here are EMITTED now. #106 gave each
  // guest checkout gate a bounded refusal reason (`CheckoutRefusalReason`), so
  // `checkout.controller.ts` can classify an outcome without matching on
  // message text — which is the exact condition #77 recorded as what the seam
  // was waiting for.
  // The four CLIENT payment types that used to sit here are EMITTED now. #111
  // built the storefront analytics client #107 said was rollout instrumentation
  // rather than payment work, and each of the four is exactly what #107's
  // contract required: a browser fact, carrying a BOUNDED method category from
  // `GUEST_PAYMENT_METHOD_CATEGORIES` rather than the provider's own string.
  //
  // `guest_payment_verified` is NOT among them and never will be. It moved to
  // {@link ANALYTICS_STRUCTURALLY_UNEMITTED_EVENT_TYPES}, which is a different
  // and stronger statement than a seam — see the note there.
  // The three `#108` types (`guest_order_portal_opened`,
  // `guest_recovery_requested`, `guest_recovery_exchanged`) that used to sit
  // here are EMITTED now. What closed
  // the seam was not new plumbing but the GRANT ROW: a portal open and an
  // exchange both produce a row id that authorizes nothing and outlives
  // nothing, so the funnel can be counted without a token, an email or a hash
  // ever reaching a column — which is exactly the contract #77 recorded.
  // `guest_recovery_requested` carries NO checkout group, deliberately: it is
  // emitted on every request whether or not anything matched, and a group on it
  // would turn the metric into the enumeration oracle the 202 exists to close.
  // Three of `#109`'s five types are EMITTED now (`guest_claim_started`,
  // `guest_claim_completed`, `guest_claim_conflicted`). What closed that half
  // of the seam was the CLAIM ROW: a started attempt, a completed claim and a
  // contest each produce a stable row id and a checkout group, so the funnel is
  // countable without an account's email, the losing claimant's identity or a
  // credential ever reaching a column.
  //
  // #109's other two are EMITTED now, from the claim screen itself. They were
  // deferred here because an OFFER is a screen having been shown and a DECLINE
  // is somebody navigating away — facts a server cannot observe — and #111
  // supplied the only thing that could close them honestly: a client that
  // emits the offer when the review screen RENDERS (never when the preview
  // endpoint is read, which a client can poll) and the decline on an EXPLICIT
  // dismissal (never on "a preview was read and no claim followed", which is
  // indistinguishable from a lost connection).
  // The three `#110` types (`guest_cancellation_requested`,
  // `guest_return_requested`, `guest_support_request_created`) that used to sit
  // here are EMITTED now, from `controllers/buyer-requests.controller.ts` and
  // AFTER the write succeeded — so the numerator counts requests that were
  // FILED rather than requests that were attempted, which is what
  // `guest_post_purchase_demand`'s "requests, not outcomes" means. They carry
  // the ORDER (admitted for these types by
  // ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES) and the actor KIND, and nothing
  // else: the request's reason code, the buyer's note and every support message
  // body have no column here and must not acquire one.
};

/**
 * Event types that are in the vocabulary and will NEVER be emitted, with the
 * decision that settled it (#111).
 *
 * This is a different statement from {@link ANALYTICS_DEFERRED_EVENT_TYPES} and
 * the difference is the point. A deferred type is waiting for an issue; a type
 * here has been decided against, permanently, and the gate that refuses an
 * emission of it is no longer a temporary courtesy to a future author but the
 * enforcement of a design decision.
 *
 * Retiring the type from the tuple instead was considered and rejected twice
 * over. It would rewrite `analytics_events_event_type_check` for no change in
 * what any row can hold, and — the load-bearing half — it would DELETE the
 * record of why the obvious thing is not done, leaving the next person to
 * rediscover it by building it.
 */
export const ANALYTICS_STRUCTURALLY_UNEMITTED_EVENT_TYPES: Readonly<
  Partial<Record<AnalyticsEventType, string>>
> = {
  /**
   * `verified-conversion.ts` establishes a ONE-WAY seam: analytics reads
   * `payments`, and no payment path ever depends on telemetry.
   * `guest_verified_payment_conversion` already takes its numerator from
   * `payments` directly, carries no `seam` field and computes today — so an
   * event emitted from the #48 ingress would invert that direction to add a
   * second, weaker source for a number nothing would read it for. #107 declined
   * to emit it from the payment domain and #111, which inherited it, declines
   * to emit it at all. The rule the decision rests on is #111 analytics rule 5:
   * paid state joins from verified payment records, never from an event.
   */
  guest_payment_verified: 'Financial truth is read from `payments`; see verified-conversion.ts.',
};

/**
 * The ONLY event types a browser or app may assert.
 *
 * Acceptance 3 made structural: "native paid orders and network-reported
 * affiliate conversions cannot be forged by client analytics". The ingest
 * endpoint refuses every type outside this set, so the events that carry
 * commercial meaning — a session being issued, a cart merging, a payment being
 * verified, a claim completing — exist only where a server wrote them.
 *
 * An impression is on the list because only the client knows what rendered; a
 * click is on it for the same reason. Neither can move money or identity.
 */
export const ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES = [
  'search_result_impression',
  'search_result_click',
  'entity_suggestion_click',
  'product_page_view',
  'variant_selected',
  'offer_impression',
  'offer_expanded',
  'offer_selected',
  'external_outbound_click',
  'save_action',
  'alert_action',
  'watchlist_action',
  'merchant_claim_entry',
  'sell_yours_entry',
  'surface_error',
  'experiment_exposed',
  // #111's six. Each is a fact only a browser or a payment sheet knows, and
  // NONE of them can move money or identity: which methods a sheet OFFERED,
  // which one was pressed, whether the issuer demanded a step-up, whether the
  // confirmation failed on the client, whether a claim screen was rendered, and
  // whether it was explicitly dismissed. `guest_payment_verified` is
  // deliberately NOT here and never will be — the paid state comes from
  // `payments`, which is what makes forging one from a browser impossible
  // rather than merely refused.
  'guest_payment_methods_shown',
  'guest_payment_method_selected',
  'guest_payment_action_required',
  'guest_payment_client_failed',
  'guest_claim_offered',
  'guest_claim_declined',
] as const;

/** One of {@link ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES}. */
export type AnalyticsClientEmittableEventType =
  (typeof ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES)[number];

/**
 * The event types that may carry the RESTRICTED checkout/order correlation
 * (envelope field 5: "only for documented commerce metrics after checkout
 * begins").
 *
 * A CHECK renders this tuple, so a `product_page_view` carrying a checkout
 * group id is refused by the database rather than by whoever remembers the
 * rule. Note what the list does NOT contain: every discovery event before
 * `checkout_started`, which is exactly where "after checkout begins" bites.
 */
export const ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES = [
  'checkout_started',
  'guest_checkout_started',
  'guest_contact_validated',
  'guest_contact_validation_failed',
  'guest_destination_validated',
  'guest_destination_validation_failed',
  'guest_eligibility_accepted',
  'guest_eligibility_rejected',
  'guest_payment_methods_shown',
  'guest_payment_method_selected',
  'guest_payment_action_required',
  'guest_payment_client_failed',
  'guest_payment_verified',
  'guest_order_portal_opened',
  'guest_recovery_exchanged',
  'guest_claim_offered',
  'guest_claim_started',
  'guest_claim_completed',
  'guest_claim_declined',
  'guest_claim_conflicted',
  'guest_cancellation_requested',
  'guest_return_requested',
  'guest_support_request_created',
] as const;

/**
 * The event types that may carry the buyer-origin dimension (envelope field
 * 12) — the funnel events whose whole purpose is to compare the two flows.
 *
 * Deliberately narrow. A `search_submitted` carrying `buyer_origin` would let a
 * merchant-facing query report be sliced by whether the searcher was a guest,
 * which is the "guest-origin metrics cannot become an organic ranking input or
 * an automatic service-denial rule" boundary approached from the reporting
 * side.
 */
export const ANALYTICS_BUYER_ORIGIN_EVENT_TYPES = [
  'native_add_to_cart',
  'checkout_started',
  'guest_checkout_started',
  'guest_eligibility_accepted',
  'guest_eligibility_rejected',
  'guest_payment_verified',
] as const;

/**
 * The event types that may carry the bounded payment-method category (#111
 * analytics measure 5).
 *
 * A CHECK renders this tuple, so a `search_submitted` carrying a method
 * category is refused by the database — the `buyer_origin` device, and the
 * narrowness matters for the same reason: a method dimension on a discovery
 * event would let a merchant-facing report be sliced by how somebody paid.
 *
 * `guest_payment_action_required` and `guest_payment_client_failed` are on the
 * list because "which methods produce step-ups" and "which methods fail on the
 * client" are the two questions a rollout actually asks before enabling a new
 * one. `guest_payment_verified` is NOT — it is never emitted at all.
 *
 * {@link ANALYTICS_ENVELOPE_VERSION} deliberately does NOT move for this
 * addition. It moves when a field's MEANING changes, and no existing field's
 * has; and the ambiguity a new nullable column normally introduces ("is this
 * NULL because the row predates the field, or because the field does not
 * apply?") cannot arise here, because every type on this list was emitted by
 * nothing before #111 — so every pre-existing row is of a type that could never
 * have carried one.
 */
export const ANALYTICS_PAYMENT_METHOD_EVENT_TYPES = [
  'guest_payment_methods_shown',
  'guest_payment_method_selected',
  'guest_payment_action_required',
  'guest_payment_client_failed',
] as const;

/* -------------------------------------------------------------------------- */
/*  Retention classes                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Retention by event CLASS (data-lifecycle rule 1), never one blanket TTL.
 *
 * The class is stored on the row rather than derived from the type at sweep
 * time, so a type moving between classes is a migration with a visible
 * backfill decision instead of a silent change to how long existing rows live.
 */
export const ANALYTICS_EVENT_CLASSES = [
  /** Browse, search, impression, click. The highest-volume, shortest-lived. */
  'discovery',
  /** Cart, checkout, eligibility, portal, claim — the funnel. */
  'commerce_funnel',
  /** Experiment exposure. Outlives discovery so a finished test stays analysable. */
  'experiment',
  /** Errors and unavailable states — operational, read by on-call. */
  'operational',
] as const;

/** One of {@link ANALYTICS_EVENT_CLASSES}. */
export type AnalyticsEventClass = (typeof ANALYTICS_EVENT_CLASSES)[number];

/* -------------------------------------------------------------------------- */
/*  Bounded reason codes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every reason an event may carry — ONE closed vocabulary across errors,
 * eligibility refusals, validation failures, merge outcomes, gate blocks and
 * claim outcomes.
 *
 * One tuple rather than six because the column is one column: six vocabularies
 * in one field would need a per-event-type CHECK to keep a claim outcome out of
 * an eligibility refusal, and the value of that constraint is far below the
 * cost of the six-branch CHECK expression it would take. What matters — that
 * the value is BOUNDED and can never be a sentence, an email address or a
 * stack trace — is what a single tuple already gives.
 */
export const ANALYTICS_REASON_CODES = [
  // Surface errors and unavailable states.
  'not_found',
  'unavailable',
  'rate_limited',
  'upstream_timeout',
  'upstream_error',
  'validation_failed',
  'forbidden',
  'stale_offer',
  'out_of_stock',
  'listing_restricted',
  // Guest eligibility (ADR 0003 D18 and the readiness gate).
  'seller_not_payment_ready',
  'p2p_seller_excluded',
  'market_not_supported',
  'currency_not_supported',
  'guest_commerce_disabled',
  'guest_cart_disabled',
  'guest_issuance_disabled',
  'guest_checkout_disabled',
  // #107's rollout kill switches and the #85 activation seam. Two codes for
  // five levers: `guest_rollout_blocked` covers platform, market, merchant and
  // fulfilment because a metric wants "how often did a rollout gate refuse",
  // and WHICH lever fired is an operational fact that belongs in a log line
  // beside the operator who set it — not in an event a dashboard slices.
  'guest_rollout_blocked',
  'guest_seller_not_activated',
  // #123's retail gate. ONE code for its ten conditions, the same reasoning the
  // two above use and a stronger case for it: which condition fired would let a
  // dashboard — and anybody who can read one — infer a supplier's live stock
  // position and Mercaria's wholesale cost coverage from a metric. The
  // condition IS recorded, in the operator trace, where the reader is already
  // authorized to see what Mercaria pays its suppliers.
  'retail_line_ineligible',
  // Cart merge outcomes (the bounded set #104 already records).
  'merge_completed',
  'merge_already_done',
  'merge_nothing_to_move',
  'merge_quantity_clamped',
  'merge_line_flagged',
  'merge_discount_dropped',
  // Contact and destination validation.
  'contact_malformed',
  'contact_undeliverable',
  'destination_incomplete',
  'destination_unsupported',
  // Claim outcomes (#109's seam — the vocabulary exists, nothing emits it).
  'claim_offered',
  'claim_completed',
  'claim_declined',
  'claim_conflicted',
  // #111's abuse friction. THREE codes for one decision, unlike the single
  // `guest_rollout_blocked` above, and the asymmetry is deliberate: a rollout
  // lever is an operator's private choice a buyer cannot act on, while friction
  // is something the person is TOLD and must be able to act on — waiting, or
  // proving their inbox, or knowing a human will look. Naming the MEASURE
  // discloses nothing about the thresholds: which pattern fired and what the
  // count was stay in the intervention row, where the reader is an operator.
  'abuse_cooldown',
  'abuse_verification_required',
  'abuse_manual_review',
  // #85's activation gate. ONE code for four levers (an unaccepted fee
  // schedule, an unaccepted responsibilities policy, a merchant's own pause and
  // an operator's safety hold), the `guest_rollout_blocked` decision applied to
  // the authenticated path — a buyer cannot act on which of the four fired, and
  // a client able to vary one input at a time could read out whether a
  // particular merchant is under an operator hold, which is a moderation fact.
  // It is deliberately NOT `seller_not_payment_ready`: one seller cannot be
  // PAID, the other has not ACCEPTED, and the remedies are different screens.
  'seller_not_activated',
  // The honest fallback. Present so a new refusal is recorded as UNCLASSIFIED
  // rather than squeezed into a code that means something else.
  'other',
] as const;

/** One of {@link ANALYTICS_REASON_CODES}. */
export type AnalyticsReasonCode = (typeof ANALYTICS_REASON_CODES)[number];

/* -------------------------------------------------------------------------- */
/*  Search query privacy                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What a redaction pass FOUND, recorded as a bounded code beside the redacted
 * text.
 *
 * The codes are the point of the record: "this query contained something that
 * looked like a card number" is an operational fact worth aggregating (it says
 * people are pasting secrets into a search box), and it is storable without
 * storing the thing itself.
 */
export const ANALYTICS_QUERY_REDACTION_KINDS = [
  'email',
  'phone',
  'postal_address',
  'payment_card',
  'iban',
  'secret_token',
  'long_digit_run',
  'url_with_credentials',
  'oversized',
] as const;

/** One of {@link ANALYTICS_QUERY_REDACTION_KINDS}. */
export type AnalyticsQueryRedactionKind = (typeof ANALYTICS_QUERY_REDACTION_KINDS)[number];

/**
 * The marker a redaction leaves behind, so a reader sees the hole rather than a
 * plausible-looking shorter query.
 */
export const ANALYTICS_QUERY_REDACTED_MARKER = '[redacted]';

/**
 * How long the REDACTED query text is kept before it is nulled, leaving only
 * normalized tokens and counts.
 *
 * The decision #77 "Search query privacy" 1 asks for, stated here rather than
 * in prose: **raw query text is never retained at all** — only the redacted
 * form, and only for this long. Thirty days is the shortest window in which a
 * relevance regression reported by a merchant can still be reproduced against
 * the actual strings people typed; after it, the tokens answer every aggregate
 * question and the strings answer none.
 */
export const ANALYTICS_QUERY_TEXT_RETENTION_DAYS = 30;

/**
 * The minimum number of occurrences before a query may appear in ANY report —
 * merchant-facing or operator-facing.
 *
 * "Restrict access to low-frequency queries" (privacy rule 4) and "apply
 * minimum-count thresholds before merchant-facing query reporting" (rule 5) are
 * the same threshold applied to two audiences, because a rare query is a
 * near-identifier whoever is reading it. An operator who needs a specific query
 * reads the row by its own id in the trace surface, which is audited; a report
 * never surfaces one.
 */
export const ANALYTICS_QUERY_MIN_OCCURRENCES = 25;

/**
 * The minimum cohort size behind any merchant-facing breakdown (merchant rule
 * 2 and rule 5).
 *
 * Smaller than the query threshold on purpose: a query STRING is content
 * somebody typed and a count of checkout starts is not, so the two do not need
 * the same floor. Both are floors, and neither is zero.
 */
export const ANALYTICS_MERCHANT_MIN_COHORT = 10;

/* -------------------------------------------------------------------------- */
/*  Metric definitions                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Where a metric's numbers actually come from.
 *
 * `payments`, `orders`, `refunds` and `affiliate_reports` are the durable
 * records; `analytics_events` and `analytics_search_queries` are telemetry.
 * The distinction is the whole of identity rule 8, and it is a FIELD rather
 * than a convention so a conversion metric sourced from telemetry is a visible
 * error in the registry rather than an invisible one in a chart.
 */
export const ANALYTICS_METRIC_SOURCES = [
  'analytics_events',
  'analytics_search_queries',
  'payments',
  'orders',
  'refunds',
  'affiliate_reports',
] as const;

/** One of {@link ANALYTICS_METRIC_SOURCES}. */
export type AnalyticsMetricSource = (typeof ANALYTICS_METRIC_SOURCES)[number];

/** The durable, non-telemetry sources — the ones identity rule 8 names. */
export const ANALYTICS_FINANCIAL_METRIC_SOURCES = [
  'payments',
  'orders',
  'refunds',
  'affiliate_reports',
] as const;

/** How a metric's window is drawn. */
export const ANALYTICS_METRIC_WINDOWS = [
  /** One calendar day in UTC — the rollup grain. */
  'day',
  /** Seven calendar days ending on the bucket. */
  'rolling_7d',
  /** Twenty-eight calendar days ending on the bucket. */
  'rolling_28d',
  /**
   * A per-SESSION window: the qualifying action must follow within
   * {@link ANALYTICS_SEARCH_SUCCESS_WINDOW_SECONDS} of the search.
   */
  'search_session',
] as const;

/** One of {@link ANALYTICS_METRIC_WINDOWS}. */
export type AnalyticsMetricWindow = (typeof ANALYTICS_METRIC_WINDOWS)[number];

/**
 * The documented event window for search success (#77 metric 1).
 *
 * Thirty minutes. Long enough that a shopper who opens three products in tabs
 * and buys one still counts, short enough that an unrelated visit two hours
 * later does not attribute itself to a morning search.
 */
export const ANALYTICS_SEARCH_SUCCESS_WINDOW_SECONDS = 30 * 60;

/**
 * The qualifying actions for search success (#77 metric 1's "qualifying
 * actions").
 *
 * A click is not success on its own — a result someone clicked and bounced from
 * is the failure this metric exists to detect — so success requires an action
 * that expresses intent about the THING found.
 */
export const ANALYTICS_SEARCH_SUCCESS_ACTIONS = [
  'offer_selected',
  'external_outbound_click',
  'native_add_to_cart',
  'save_action',
  'watchlist_action',
] as const;

/**
 * One metric, completely stated.
 *
 * Acceptance 6 ("every dashboard metric names its denominator, time window and
 * freshness") is enforced by the shape: there is no optional field here, so a
 * metric with an unstated denominator does not compile. `metrics.test.ts`
 * closes the remaining gap — a non-empty string — because TypeScript cannot.
 */
export interface AnalyticsMetricDefinition {
  /** Stable key. Appears in rollup rows, so renaming one is a migration. */
  readonly key: string;
  /** What a reader sees. */
  readonly title: string;
  /** Exactly what is counted on top. */
  readonly numerator: string;
  /** Exactly what is counted underneath. Never "all traffic". */
  readonly denominator: string;
  /** How the window is drawn. */
  readonly window: AnalyticsMetricWindow;
  /** Where the numbers come from. */
  readonly source: AnalyticsMetricSource;
  /**
   * How stale the number may be, in seconds — the rollup interval plus the
   * source's own lag. A dashboard renders it beside the value.
   */
  readonly freshnessSeconds: number;
  /** Whether bots, previews and internal traffic are excluded. */
  readonly humanOnly: boolean;
  /** Whether a merchant may see it for their OWN offers. */
  readonly merchantVisible: boolean;
  /**
   * What this metric cannot tell you. Rendered beside it, because a
   * merchant-facing number with an unstated attribution limit is a number that
   * will be over-read (merchant rule 8).
   */
  readonly attributionLimit: string;
  /**
   * The issue that owes the events this metric needs, when they do not exist
   * yet. A metric with a seam is listed, is computable as zero-of-zero, and
   * says so — which is the difference between "not measured yet" and "measured
   * as nothing".
   */
  readonly seam?: string;
}

/**
 * Every metric #77 names, defined once.
 *
 * The order follows the issue's list, so a reader can check the two against
 * each other without a mapping table.
 */
export const ANALYTICS_METRICS: readonly AnalyticsMetricDefinition[] = [
  {
    key: 'search_success_rate',
    title: 'Search success rate',
    numerator:
      'search_results_returned events followed within the search session window by one of ' +
      'offer_selected, external_outbound_click, native_add_to_cart, save_action or watchlist_action ' +
      'carrying the same query_event_id',
    denominator: 'search_results_returned events in the window',
    window: 'search_session',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'Joins only through query_event_id, so a shopper who searches, leaves and returns by a ' +
      'bookmark counts as a failure. It measures the search, not the shopper.',
  },
  {
    key: 'zero_result_rate',
    title: 'Zero-result rate',
    numerator: 'search_zero_results events',
    denominator: 'search_submitted events',
    window: 'day',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'Counts a submitted query with no rows, not a query with bad rows. A filter combination ' +
      'nobody could satisfy and a term the catalogue has never heard of look identical here.',
  },
  {
    key: 'duplicate_product_rate',
    title: 'Duplicate-product rate in results',
    numerator:
      'result rows on a page whose canonical product id repeats an earlier row on the same page ' +
      '(analytics_search_queries.duplicate_result_count)',
    denominator: 'result rows returned (analytics_search_queries.result_count)',
    window: 'day',
    source: 'analytics_search_queries',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'Duplication is measured against the canonical product id a result carried AT QUERY TIME, ' +
      'and the native listing search does not resolve one — so this reads ZERO there and is ' +
      'currently a lower bound of nothing rather than an estimate. #58 landed the matcher and ' +
      'the link IS now reachable; what is missing is a batched resolver and a precedence rule ' +
      'between the two routes to a canonical product (a variant barcode through ' +
      '`product_identifiers`, and `native_listing_links` written by the matcher). Read it as ' +
      'unmeasured on that surface, never as "no duplicates".',
  },
  {
    key: 'search_to_product_click_rate',
    title: 'Search-to-product click rate',
    numerator: 'search_result_click events',
    denominator: 'search_result_impression events',
    window: 'day',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: true,
    attributionLimit:
      'An impression is what the client reported as rendered. A result scrolled past below the ' +
      'fold on a long page may never be reported, so the denominator is viewport-dependent.',
  },
  {
    key: 'product_to_offer_selection_rate',
    title: 'Product-to-offer selection rate',
    numerator: 'offer_selected events',
    denominator: 'product_page_view events',
    window: 'day',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: true,
    attributionLimit:
      'A product page with no eligible offers still counts in the denominator — deliberately, ' +
      'since that gap is the point of the "impressions but no eligible offers" dashboard.',
  },
  {
    key: 'external_click_through_rate',
    title: 'External click-through rate',
    numerator: 'external_outbound_click events from human traffic',
    denominator: 'offer_impression events on external offers from human traffic',
    window: 'day',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: true,
    attributionLimit:
      'Counts the click Mercaria served, never what happened on the merchant site. Affiliate ' +
      'conversion is a separate metric with a separate source, and the two must not be divided.',
  },
  {
    key: 'native_add_to_cart_rate',
    title: 'Native add-to-cart rate',
    numerator: 'native_add_to_cart events',
    denominator: 'product_page_view events on products with a native offer',
    window: 'day',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: true,
    attributionLimit:
      'An add is not a sale. Nothing here reads the cart back, so a line added and removed a ' +
      'second later counts once, as it should for an intent metric.',
  },
  {
    key: 'native_checkout_conversion',
    title: 'Native checkout conversion',
    numerator:
      'distinct checkout groups with a payment in a succeeded state (payments), not client events',
    denominator: 'checkout_started events carrying a checkout group id',
    window: 'day',
    source: 'payments',
    freshnessSeconds: 900,
    humanOnly: false,
    merchantVisible: true,
    attributionLimit:
      'The numerator is verified provider state and the denominator is telemetry, so a checkout ' +
      'that started while collection was off is invisible below the line and visible above it. ' +
      'Read the ratio as a floor.',
  },
  {
    key: 'authenticated_checkout_funnel',
    title: 'Authenticated native checkout funnel',
    numerator: 'succeeded payments on checkout groups whose orders carry buyer_origin oxy (orders)',
    denominator: 'checkout_started events with buyer_origin authenticated',
    window: 'day',
    source: 'orders',
    freshnessSeconds: 900,
    humanOnly: false,
    merchantVisible: false,
    attributionLimit:
      'Identical definition to the guest funnel below, which is the point: the two are comparable ' +
      'only because neither is defined in terms of the other.',
  },
  {
    key: 'guest_checkout_funnel',
    title: 'Guest native checkout funnel',
    numerator:
      'succeeded payments on checkout groups whose orders carry buyer_origin guest (orders)',
    denominator: 'checkout_started events with buyer_origin guest',
    window: 'day',
    source: 'orders',
    freshnessSeconds: 900,
    humanOnly: false,
    merchantVisible: false,
    attributionLimit:
      'A guest who signs in mid-checkout leaves this funnel and enters the authenticated one; ' +
      'nothing follows them across, because following them across is the identity join ADR 0003 ' +
      'I12 forbids.',
  },
  {
    key: 'guest_verified_payment_conversion',
    title: 'Guest checkout-to-verified-payment conversion',
    numerator:
      'checkout groups with a succeeded payment, derived from the #48 verified event ingress and ' +
      'never from a client success callback',
    denominator: 'guest_checkout_started events',
    window: 'day',
    source: 'payments',
    freshnessSeconds: 900,
    humanOnly: false,
    merchantVisible: false,
    attributionLimit:
      'A successful guest purchase with no Oxy claim is a COMPLETE conversion here. Claiming is a ' +
      'separate metric and a lower claim rate is never abandonment (#77 metrics note).',
  },
  {
    key: 'order_portal_delivery_success',
    title: 'Order-portal delivery and recovery success',
    numerator: 'guest_recovery_exchanged events',
    denominator: 'guest_recovery_requested events',
    window: 'day',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'Measures the exchange, not the email. A link that never arrived and one that arrived and ' +
      'was ignored are the same row here — and with no transport registered (#108 leaves it a ' +
      'named seam) the numerator is structurally zero until one is, which is a fact about the ' +
      'deployment rather than about buyers.',
  },
  {
    key: 'oxy_claim_funnel',
    title: 'Optional Oxy claim offer, start and completion rate',
    numerator: 'guest_claim_completed events',
    denominator: 'guest_claim_offered events',
    window: 'day',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'A decline is a valid outcome and is counted as one, never as an error and never as a lost ' +
      'conversion (identity rule 6). This ratio says nothing about whether commerce succeeded. ' +
      'The NUMERATOR computes today — #109 emits `guest_claim_completed` from the claim ' +
      'transaction — and the DENOMINATOR does not, because an offer is a screen having been ' +
      'shown and the storefront has no analytics client. Reading the ratio against a started ' +
      'claim instead would answer a different question (how often a confirmed claim succeeds, ' +
      'which is almost always) and quietly rename the metric.',
    seam: '#111',
  },
  {
    key: 'saved_intent_return_rate',
    title: 'Return rate for users with saves, alerts or watchlists',
    numerator:
      'actors with a save_action, alert_action or watchlist_action who produce any event on a ' +
      'later calendar day within the window',
    denominator: 'actors with a save_action, alert_action or watchlist_action in the window',
    window: 'rolling_28d',
    source: 'analytics_events',
    freshnessSeconds: 86400,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'For guests the actor is a pseudonymous session id, which ROTATES on the retention ' +
      'schedule — so a return across a rotation boundary is invisible. That is the privacy ' +
      'decision winning over the analytic one, deliberately, and it biases this number DOWN.',
  },
  {
    key: 'source_coverage_gap',
    title: 'Source and merchant coverage gaps',
    numerator: 'distinct canonical products with at least one active offer from a live source',
    denominator: 'distinct canonical products viewed in the window',
    window: 'day',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'Coverage is measured against DEMAND, not against the catalogue: a product nobody looked at ' +
      'contributes to neither side, so this cannot rank sources by absolute breadth.',
  },
  {
    key: 'query_latency_and_freshness',
    title: 'Query latency and result freshness',
    numerator: 'sum of analytics_search_queries.latency_ms',
    denominator: 'analytics_search_queries rows in the window',
    window: 'day',
    source: 'analytics_search_queries',
    freshnessSeconds: 3600,
    humanOnly: false,
    merchantVisible: false,
    attributionLimit:
      'Server-side latency only — the time the API spent, not the time the shopper waited. ' +
      'Network and render time are not measured and must not be inferred from this.',
  },
  {
    key: 'merchant_claim_funnel',
    title: 'Merchant claim funnel',
    numerator: 'merchants reaching claim_state verified in the window (merchants table)',
    denominator: 'merchant_claim_entry events',
    window: 'day',
    source: 'orders',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'The numerator is the durable claim verdict and the denominator is an entry click, so a ' +
      'claim begun from a link somebody was sent is a verified claim with no entry above it.',
  },
  {
    key: 'native_gmv',
    title: 'Native GMV',
    numerator: 'sum of shop-side order totals on orders whose payment succeeded',
    denominator: 'one — an absolute, not a ratio; the denominator names the currency scope',
    window: 'day',
    source: 'orders',
    freshnessSeconds: 900,
    humanOnly: false,
    merchantVisible: true,
    attributionLimit:
      'Summed per shop currency and never mixed. A cross-currency total is not produced here ' +
      'because it would need an FX rate this metric does not own.',
  },
  {
    key: 'marketplace_revenue',
    title: 'Marketplace revenue',
    numerator: 'commission_revenue ledger entries (ledger, through the payments source)',
    denominator: 'one — an absolute, not a ratio; the denominator names the currency scope',
    window: 'day',
    source: 'payments',
    freshnessSeconds: 900,
    humanOnly: false,
    merchantVisible: false,
    attributionLimit:
      'The ledger residual per ADR 0001 D3. It is NOT the sum of fee snapshots and must not be ' +
      'reconciled against them here; that is the reconciliation surface (#50).',
  },
  {
    key: 'affiliate_commission',
    title: 'Affiliate commission',
    numerator: 'commission reported by the affiliate network for the period',
    denominator: 'one — an absolute, not a ratio; the denominator names the network',
    window: 'day',
    source: 'affiliate_reports',
    freshnessSeconds: 172800,
    humanOnly: false,
    merchantVisible: false,
    attributionLimit:
      'Network-reported and revisable for weeks after the click. Never derived from ' +
      'external_outbound_click, and the two must never be divided into a "conversion rate".',
    seam: '#37',
  },
  {
    key: 'guest_post_purchase_demand',
    title: 'Guest cancellation, return, support and fraud-intervention rate',
    numerator:
      'guest_cancellation_requested, guest_return_requested and guest_support_request_created events',
    denominator: 'succeeded payments on guest-origin orders',
    window: 'rolling_28d',
    source: 'payments',
    freshnessSeconds: 3600,
    humanOnly: false,
    merchantVisible: false,
    attributionLimit:
      'Requests, not outcomes. A cancellation asked for and refused counts here exactly as one ' +
      'that was granted; the refund domain is where money is counted. A request filed by a ' +
      'CLAIMANT of a guest order counts too — it is the same purchase — which is why the ' +
      'numerator is the three event types rather than an actor-kind filter over them.',
  },
  {
    key: 'guest_eligibility_coverage',
    title: 'Merchant, market and platform guest-eligibility coverage',
    numerator: 'guest_eligibility_accepted events',
    denominator: 'guest_eligibility_accepted plus guest_eligibility_rejected events',
    window: 'day',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'Measured where a guest actually reached the gate. A merchant no guest ever tried is ' +
      'neither eligible nor ineligible here, so this cannot enumerate coverage across the ' +
      'catalogue. Both halves are emitted since #106, so the ratio is a measurement — but a ' +
      'refusal that is not one of the five bounded CheckoutRefusalReasons (an empty cart, a ' +
      'stale line, a database failure) is counted in NEITHER, deliberately: those are not ' +
      'eligibility verdicts, and folding them into the denominator would report a gate that ' +
      'never ran as a gate that said no.',
  },
  // ── #111's product metrics ────────────────────────────────────────────────
  // The issue names fourteen. SIX are already defined above and are not
  // duplicated (`guest_verified_payment_conversion`, `order_portal_delivery_success`,
  // `oxy_claim_funnel`, `guest_post_purchase_demand`, `guest_eligibility_coverage`,
  // `native_gmv`), and its eleventh — "platform and market differences" — is
  // deliberately NOT a metric at all: `client_surface` and `market` are
  // dimensions every one of these already carries and every rollup already
  // buckets by, so a separate metric would be the same numbers under a second
  // name that could disagree with the first.
  {
    key: 'guest_add_to_cart_rate',
    title: 'Guest versus authenticated add-to-cart rate',
    numerator: 'native_add_to_cart events, sliced by the buyer_origin the event carries',
    denominator: 'product_page_view events in the same window, sliced by actor kind',
    window: 'day',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'The two slices are NOT a controlled comparison. A signed-in shopper and a guest are ' +
      'self-selected populations that differ in intent before they differ in flow, so a gap ' +
      'here is a description of who uses which and never evidence that one flow converts ' +
      'better. Comparing them under an experiment is the only way to answer that, and #77 ' +
      'forbids the treatment that would be needed to try.',
  },
  {
    key: 'guest_cart_progression_rate',
    title: 'Guest cart-to-checkout rate',
    numerator: 'guest_checkout_started events',
    denominator: 'guest_cart_created events in the same window',
    window: 'rolling_7d',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'NOT a money metric, and the KEY says so deliberately: both halves are client-observed ' +
      'pre-payment events, and a checkout STARTED is not a purchase. The naming is load-bearing ' +
      'rather than stylistic — `findFinancialSourceViolations` treats any key containing ' +
      '"conversion" or "checkout" as a claim about money and demands a durable source, and it ' +
      'refused this metric under both of its first two names, correctly. The money questions are ' +
      '`guest_checkout_funnel` (from `orders`) and `guest_verified_payment_conversion` (from ' +
      '`payments`). ' +
      'A cart created near the end of a window is counted against a checkout that may fall ' +
      'into the next one, so the ratio is stable over a week and misleading over an hour. ' +
      'A guest whose pseudonym rotates mid-journey appears in both halves under two ' +
      'dimensions, which is the cost the 24-hour salt rotation was chosen knowing.',
  },
  {
    key: 'guest_funnel_step_failure_rate',
    title: 'Guest validation and payment drop-off',
    numerator:
      'guest_contact_validation_failed, guest_destination_validation_failed and ' +
      'guest_payment_client_failed events, reported per bounded reason code',
    denominator: 'guest_checkout_started events in the same window',
    window: 'day',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'The key carries no financial marker, for `guest_cart_progression_rate`\'s reason: every ' +
      'input is a client-observed failure and none of them is money. ' +
      'Counts FAILURES, not abandonment. Somebody who reaches the payment sheet and closes the ' +
      'tab appears nowhere in the numerator, and the server cannot tell that from a lost ' +
      'connection — which is the same reason guest_claim_declined has to come from an explicit ' +
      'dismissal rather than from a preview nobody acted on.',
  },
  {
    key: 'guest_express_method_usage',
    title: 'Express payment method usage',
    numerator: 'guest_payment_method_selected events carrying a wallet payment_method_category',
    denominator: 'guest_payment_methods_shown events that offered at least one wallet category',
    window: 'rolling_7d',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'The denominator is what the SHEET offered, which the device narrows — a browser with no ' +
      'wallet configured never sees one and never enters either half. So this measures uptake ' +
      'among people who could have used it, and can never be read as "how many buyers own a ' +
      'wallet".',
  },
  {
    key: 'guest_recovery_success_rate',
    title: 'Guest order recovery success',
    numerator: 'guest_recovery_exchanged events',
    denominator: 'guest_recovery_requested events in the same window',
    window: 'rolling_7d',
    source: 'analytics_events',
    freshnessSeconds: 3600,
    humanOnly: true,
    merchantVisible: false,
    attributionLimit:
      'The denominator counts every request whether or not an inbox matched — deliberately, ' +
      'because an event emitted only on a match would rebuild the enumeration oracle the ' +
      'uniform 202 exists to close. So a low rate can mean links are not arriving OR that ' +
      'people are typing addresses that never bought anything, and this metric cannot ' +
      'distinguish them. It will read ZERO while no mail transport is registered.',
    seam: '#108 transport',
  },
  {
    key: 'guest_abuse_intervention_rate',
    title: 'Guest abuse intervention rate',
    numerator: 'guest_abuse_interventions rows created in the window',
    denominator: 'succeeded payments plus guest_checkout_started events in the same window',
    window: 'rolling_7d',
    source: 'payments',
    freshnessSeconds: 3600,
    humanOnly: false,
    merchantVisible: false,
    attributionLimit:
      'A rate against ACTIVITY, not against people — the denominator deliberately mixes two ' +
      'units because the alternative is a per-person denominator this domain refuses to be ' +
      'able to compute. Read it as "how often does a control fire", never as "what fraction of ' +
      'shoppers are abusive".',
  },
  {
    key: 'guest_abuse_false_positive_rate',
    title: 'Abuse intervention false-positive correction rate',
    numerator: 'guest_abuse_interventions rows an operator moved to false_positive',
    denominator: 'guest_abuse_interventions rows created in the same window',
    window: 'rolling_28d',
    source: 'payments',
    freshnessSeconds: 86400,
    humanOnly: false,
    merchantVisible: false,
    attributionLimit:
      'A LOWER bound and known to be one: it counts the false positives somebody complained ' +
      'about and an operator agreed with. Most people who hit an unjust cooldown wait it out ' +
      'and never appear here, which is why a small number is not evidence the controls are ' +
      'accurate. It is measurable at all only because a corrected intervention is kept rather ' +
      'than deleted.',
  },
  {
    key: 'guest_share_of_native_gmv',
    title: 'Guest share of native GMV and support demand',
    numerator: 'succeeded payment totals on orders whose buyer_origin is guest, per shop currency',
    denominator: 'succeeded payment totals on all native orders, per shop currency',
    window: 'rolling_28d',
    source: 'payments',
    freshnessSeconds: 900,
    humanOnly: false,
    merchantVisible: false,
    attributionLimit:
      'Per shop currency and never mixed, for native_gmv’s reason. A claimed guest order stays ' +
      'in the guest numerator FOREVER — buyer_origin is immutable — so this measures which ' +
      'flow made the sale and never which kind of account exists today. Read beside ' +
      'guest_post_purchase_demand: a guest share of GMV above the guest share of support ' +
      'demand is the case for the flow, and below it is the case against.',
  },
  {
    key: 'guest_payment_return_recovery',
    title: 'Session-expiry and payment-return recovery success',
    numerator:
      'checkout groups with a succeeded payment that later produced a guest_order_portal_opened ' +
      'event, whether the credential came from the paying tab or from a recovery exchange',
    denominator: 'checkout groups with a succeeded payment on a guest-origin order',
    window: 'rolling_7d',
    source: 'payments',
    freshnessSeconds: 3600,
    humanOnly: false,
    merchantVisible: false,
    attributionLimit:
      'The one metric here whose FAILING half is the thing that matters: a buyer who paid and ' +
      'never opened their order is the worst state guest commerce has, and this is where it is ' +
      'visible. It cannot distinguish somebody who never came back from somebody who came back ' +
      'and could not get in — the security signal for portal-initialization lag is what ' +
      'separates those, and a rate here dropping without that signal moving means people are ' +
      'simply not returning.',
  },
  {
    key: 'guest_portal_initialization_lag',
    title: 'Portal initialization lag after verified payment',
    numerator:
      'seconds between a payment reaching succeeded and its guest_portal_initialization outbox ' +
      'row completing, reported as a p95',
    denominator: 'one — a latency, not a ratio; the denominator names the payment population',
    window: 'day',
    source: 'payments',
    freshnessSeconds: 900,
    humanOnly: false,
    merchantVisible: false,
    attributionLimit:
      'Measures the QUEUE, not the buyer’s experience. The row completing means a grant exists ' +
      'and, once a transport is registered, that a message was handed over — never that it ' +
      'arrived. Delivery is the mail provider’s to report and Mercaria has none.',
  },
] as const;

/** Every metric key, for the rollup CHECK and the read surfaces. */
export const ANALYTICS_METRIC_KEYS = ANALYTICS_METRICS.map((metric) => metric.key);

/* -------------------------------------------------------------------------- */
/*  Experimentation                                                            */
/* -------------------------------------------------------------------------- */

/** An experiment version's lifecycle. Immutable once it leaves `draft`. */
export const ANALYTICS_EXPERIMENT_STATUSES = [
  'draft',
  'active',
  'stopped',
  'completed',
] as const;

/** One of {@link ANALYTICS_EXPERIMENT_STATUSES}. */
export type AnalyticsExperimentStatus = (typeof ANALYTICS_EXPERIMENT_STATUSES)[number];

/**
 * What an experiment may randomize.
 *
 * Read the list for what it does NOT contain: there is no `checkout_account_wall`,
 * no `hide_guest_option`, no `auto_create_account` and no `marketing_consent_default`.
 * Experimentation rule 5 ("guest-checkout experiments cannot hide Continue as
 * guest, auto-create accounts or preselect marketing consent") and rule 9 ("do
 * not test coercive account walls") are therefore UNREPRESENTABLE rather than
 * forbidden by review: an experiment has no kind to declare that would mean it.
 * `experiment-guardrails.test.ts` asserts the absence by name, so adding one
 * fails the build with the rule quoted at it.
 *
 * Rule 3 ("do not experiment by secretly selling organic rank") is the same
 * shape: `ranking_policy` names a #74 policy VERSION, and a policy version is
 * organic by construction — the fee and referral domains are unreachable from
 * the ranking modules (`fee-ranking-isolation.test.ts` and its siblings).
 */
export const ANALYTICS_EXPERIMENT_TREATMENT_KINDS = [
  /** A #74 ranking policy version. Records the version; changes no eligibility. */
  'ranking_policy',
  /** Which fields a result card shows. */
  'result_presentation',
  /** How offers are grouped or ordered within one product. */
  'offer_presentation',
  /** Copy on a discovery or checkout surface, never a control's presence. */
  'copy_variant',
  /** Which of several equivalent checkout step orders a buyer sees. */
  'checkout_step_order',
] as const;

/** One of {@link ANALYTICS_EXPERIMENT_TREATMENT_KINDS}. */
export type AnalyticsExperimentTreatmentKind =
  (typeof ANALYTICS_EXPERIMENT_TREATMENT_KINDS)[number];

/**
 * Treatment names that must never become representable.
 *
 * A negative list beside the positive one above is unusual and is here on
 * purpose: the positive list alone cannot express "and never add these", and
 * these three are named in the issue as prohibitions rather than as omissions.
 * The gate scans {@link ANALYTICS_EXPERIMENT_TREATMENT_KINDS} against these
 * substrings, which is what makes a plausible-looking future addition
 * (`guest_option_visibility`) fail rather than pass review on a tired Friday.
 */
export const ANALYTICS_FORBIDDEN_EXPERIMENT_TREATMENTS = [
  'hide_guest',
  'guest_option',
  'account_wall',
  'auto_create_account',
  'auto_account',
  'marketing_consent',
  'consent_default',
  'paid_rank',
  'rank_boost',
  'sponsored_rank',
] as const;

/**
 * What may STOP an experiment (experimentation rule 6).
 *
 * A closed set because a stop condition nobody can name is a stop condition
 * nobody monitors. Every one of them maps to a guardrail metric or to a
 * durable record outside analytics, which is why an experiment can be stopped
 * even when analytics is unavailable (rule 7).
 */
export const ANALYTICS_EXPERIMENT_STOP_CONDITIONS = [
  'trust_regression',
  'duplicate_rate_regression',
  'stale_offer_regression',
  'payment_failure_regression',
  'portal_access_regression',
  'fraud_regression',
  'refund_regression',
  'support_volume_regression',
  'error_rate_regression',
  'sample_size_reached',
  'operator_stopped',
] as const;

/** One of {@link ANALYTICS_EXPERIMENT_STOP_CONDITIONS}. */
export type AnalyticsExperimentStopCondition =
  (typeof ANALYTICS_EXPERIMENT_STOP_CONDITIONS)[number];

/**
 * What an assignment is keyed on.
 *
 * Both are pseudonymous or account-scoped; neither can be contact or payment
 * identity, which is experimentation rule 8 made structural — there is no third
 * value, so an analyst cannot key a test on an email hash even if one existed
 * to key it on (it does not).
 */
export const ANALYTICS_EXPERIMENT_ASSIGNMENT_UNITS = [
  'oxy_user',
  'pseudonymous_session',
] as const;

/** One of {@link ANALYTICS_EXPERIMENT_ASSIGNMENT_UNITS}. */
export type AnalyticsExperimentAssignmentUnit =
  (typeof ANALYTICS_EXPERIMENT_ASSIGNMENT_UNITS)[number];

/** The bucket space deterministic assignment hashes into. */
export const ANALYTICS_EXPERIMENT_BUCKETS = 10_000;

/* -------------------------------------------------------------------------- */
/*  The envelope                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Entity ids an event may carry (envelope field 7).
 *
 * An ALLOW-LIST of typed, nullable fields — never a free `jsonb` bag. The
 * payments domain's `redact.ts` is the precedent and the reasoning is
 * identical: a deny-list is correct only until somebody adds a field, which is
 * exactly when a sensitive one appears. Here the failure mode is worse than a
 * provider payload, because the thing being added would be OUR OWN identifier
 * for a person.
 */
export interface AnalyticsEntityIds {
  /** The search that produced this event, joining a click back to its query. */
  readonly queryEventId?: string;
  /** A Mercaria listing. */
  readonly listingId?: string;
  /** A Mercaria product variant. */
  readonly productVariantId?: string;
  /** A canonical product (#56). */
  readonly canonicalProductId?: string;
  /** A canonical variant (#56). */
  readonly canonicalVariantId?: string;
  /** An offer (#57). */
  readonly offerId?: string;
  /** A canonical merchant (#54). */
  readonly merchantId?: string;
  /** A storefront (#54). */
  readonly storefrontId?: string;
  /** A category slug or id. */
  readonly categoryId?: string;
  /** A native store — the merchant-analytics scope. */
  readonly storeId?: string;
}

/**
 * The typed numeric properties an event may carry.
 *
 * Five, and adding a sixth is a schema change with a migration. That friction
 * is the feature: an untyped property bag is how "just this one extra field"
 * becomes a postal address in production.
 */
export interface AnalyticsMeasures {
  /** Zero-based rank of an impression or click within its result page. */
  readonly position?: number;
  /** How many rows a search returned. */
  readonly resultCount?: number;
  /** Server-side duration in milliseconds. */
  readonly latencyMs?: number;
  /** A cart line quantity. Never a price. */
  readonly quantity?: number;
  /** How many distinct items an event concerns (cart lines, offers shown). */
  readonly itemCount?: number;
}

/**
 * The versioned analytics envelope — every field #77's "Event contract" lists,
 * and nothing else.
 *
 * Deliberately ABSENT, and each absence is a rule from the issue's identity
 * section: `email`, `emailHash`, `phone`, `cardFingerprint`, `providerCustomerId`,
 * `walletIdentity`, `ip`, `deviceFingerprint`, `userAgent`, `token`,
 * `orderNote`, and any open `properties` object. A reviewer looking for the
 * enforcement of "do not use X as a general analytics user id" will find that
 * X has no field.
 */
export interface AnalyticsEnvelope {
  /** Field 1a — unique per event. Server-minted; a client cannot choose it. */
  readonly eventId: string;
  /** Field 1b. */
  readonly eventType: AnalyticsEventType;
  /** The retention class this type belongs to. */
  readonly eventClass: AnalyticsEventClass;
  /** The envelope contract version this row was written under. */
  readonly envelopeVersion: string;
  /** Field 2a — when it happened, as the emitter observed it. */
  readonly occurredAt: Date;
  /** Field 2b — when Mercaria received it. Never client-supplied. */
  readonly receivedAt: Date;
  /** Which kind of actor. Always present; the other identity fields are not. */
  readonly actorKind: AnalyticsActorKind;
  /**
   * Field 3 — present ONLY when signed in AND consent permits. A denied-consent
   * event from an Oxy user carries a pseudonymous id instead, which is what
   * "only when permitted" has to mean if it is to mean anything.
   */
  readonly oxyUserId?: string;
  /**
   * Field 4 — the short-lived pseudonymous session id.
   *
   * A one-way hash of the session handle under a rotating SERVER salt. It is
   * not the guest session id, it cannot be reversed to one, and it changes
   * every rotation epoch — so it is a session dimension and never a person.
   */
  readonly pseudonymousSessionId?: string;
  /** Which salt epoch produced {@link pseudonymousSessionId}. */
  readonly pseudonymEpoch?: number;
  /**
   * Field 5 — RESTRICTED. Only on
   * {@link ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES}, only server-set, and
   * refused outright from a client.
   */
  readonly checkoutGroupId?: string;
  /** Field 5, the order half. Same restriction. */
  readonly orderId?: string;
  /** Field 6a. */
  readonly clientSurface: AnalyticsClientSurface;
  /** Field 6b — bounded shape, so a build string cannot become free text. */
  readonly appVersion?: string;
  /** Field 6c — an ISO 3166-1 alpha-2 market. */
  readonly market?: string;
  /** Field 7. */
  readonly entities: AnalyticsEntityIds;
  /** Field 8a — the search policy version in force (#74's seam). */
  readonly searchPolicyVersion?: string;
  /** Field 8b — the ranking policy version in force (#74's seam). */
  readonly rankingPolicyVersion?: string;
  /** Field 9a. */
  readonly experimentKey?: string;
  /** Field 9b. */
  readonly experimentVersion?: number;
  /** Field 9c. */
  readonly experimentVariant?: string;
  /** Field 10. */
  readonly trafficClass: AnalyticsTrafficClass;
  /** Field 11a. */
  readonly consentState: AnalyticsConsentState;
  /** Field 11b. */
  readonly collectionMode: AnalyticsCollectionMode;
  /** Field 12 — only on {@link ANALYTICS_BUYER_ORIGIN_EVENT_TYPES}. */
  readonly buyerOrigin?: AnalyticsBuyerOrigin;
  /**
   * The BOUNDED payment-method category (#111 analytics measure 5), only on
   * {@link ANALYTICS_PAYMENT_METHOD_EVENT_TYPES}.
   *
   * A real typed column and not a measure, because it is a category rather than
   * a number — and a real column rather than a reuse of `reasonCode`, because a
   * method and a refusal are different facts and one column holding both would
   * make "how many people were shown Apple Pay" unanswerable without knowing
   * which values in it are methods.
   */
  readonly paymentMethodCategory?: GuestPaymentMethodCategory;
  /** A bounded reason code. Never a message. */
  readonly reasonCode?: AnalyticsReasonCode;
  /** The typed measures allow-list. */
  readonly measures: AnalyticsMeasures;
}

/* -------------------------------------------------------------------------- */
/*  Read-surface DTOs                                                          */
/* -------------------------------------------------------------------------- */

/** One rolled-up metric value, with its whole definition attached. */
export interface AnalyticsMetricPoint {
  readonly metricKey: string;
  /** The UTC calendar day the bucket covers. */
  readonly bucketDate: string;
  readonly numerator: number;
  readonly denominator: number;
  /** `null` when the denominator is zero — never a silent zero. */
  readonly value: number | null;
  /** When the rollup ran. A dashboard renders this beside the value. */
  readonly computedAt: Date;
  readonly market?: string;
  readonly clientSurface?: AnalyticsClientSurface;
  readonly actorKind?: AnalyticsActorKind;
  readonly buyerOrigin?: AnalyticsBuyerOrigin;
}

/** A metric series, with the definition a dashboard must render beside it. */
export interface AnalyticsMetricSeries {
  readonly definition: AnalyticsMetricDefinition;
  readonly points: readonly AnalyticsMetricPoint[];
}

/**
 * An aggregate query row, after the minimum-count threshold.
 *
 * There is no raw-text field and no actor field. A merchant reading this can
 * see what people search for in aggregate and cannot see who searched, which is
 * merchant rules 3 and 4 expressed as a projection rather than as a filter.
 */
export interface AnalyticsQueryAggregate {
  /** The normalized token sequence, joined. Never the string somebody typed. */
  readonly normalizedQuery: string;
  readonly occurrences: number;
  readonly zeroResultOccurrences: number;
  readonly clickOccurrences: number;
  readonly market?: string;
}

/**
 * What a merchant may see about their OWN offers.
 *
 * Every field is a count over a stated denominator; none of them names a user,
 * a guest, a query string, a contact, a portal access, a claim status or a
 * payment-method identity, because none of those has a field here.
 */
export interface MerchantAnalyticsSummary {
  readonly storeId: string;
  readonly from: string;
  readonly to: string;
  /** True when every figure below cleared {@link ANALYTICS_MERCHANT_MIN_COHORT}. */
  readonly aboveThreshold: boolean;
  readonly impressions: number;
  readonly productViews: number;
  readonly offerActions: number;
  readonly checkoutStarts: number;
  /** From `orders`, not from telemetry. */
  readonly paidOrders: number;
  /** Which metric definitions produced the figures, so each names its limit. */
  readonly definitions: readonly AnalyticsMetricDefinition[];
}
