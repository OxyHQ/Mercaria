/**
 * Guest-commerce governance (#111): the data inventory, the retention policy,
 * the abuse vocabulary, the security-signal register, the feature-gate register
 * and the staged rollout.
 *
 * ## Why every one of these is DATA rather than prose
 *
 * #77 established the shape one domain over: `ANALYTICS_METRICS` is a tuple, a
 * CHECK renders it, and a number whose definition is unstated cannot be stored
 * OR served. The same reasoning applies with more force here, because every
 * artefact in this file is something an auditor asks for and a document is
 * exactly the form in which it goes stale without anybody noticing.
 *
 *  - A data-class inventory written in Markdown drifts the first time a table
 *    is added. Written as a tuple with a census test behind it, a new guest
 *    table fails the build until somebody classifies it — the
 *    `merge-plan-census.test.ts` device, applied to privacy.
 *  - A retention schedule written in prose can disagree with the sweep. Written
 *    as a tuple the sweep's registry is checked against, it cannot.
 *  - A list of "signals we must never use for abuse decisions" written in a
 *    review comment is advice. Written as a tuple DISJOINT from the permitted
 *    one, a plausible-looking future addition fails the build — the
 *    `RETAIL_FORBIDDEN_COMPONENT_KINDS` device.
 *
 * ## What this file deliberately does NOT contain
 *
 * No lever, threshold or allow-list that another domain already answers. #103
 * through #110 shipped nine flags and five block lists between them, and the
 * one thing #111 must not do is add a tenth answer to a question one of them
 * already answers. {@link GUEST_FEATURE_GATES} is a REGISTER of the capabilities
 * the issue enumerates and the lever that answers each — including the four it
 * answers with "structurally none, and here is why".
 */

/* -------------------------------------------------------------------------- */
/*  1. The data inventory                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every guest-commerce data class (#111 "Data inventory and classification"
 * 1–16), in the issue's own order so the two can be checked against each other
 * without a mapping table.
 *
 * The sixteenth is deliberately present and deliberately empty of tables: ADR
 * 0006 G4/G5 decided Mercaria configures no Stripe Customer, no CustomerSession
 * and no wallet reference, so the class exists to record that the answer is
 * NONE rather than to leave the question unasked. A class that had been dropped
 * would read, to the next person, as one nobody thought about.
 */
export const GUEST_DATA_CLASSES = [
  'guest_session_metadata',
  'cart_and_discount_intent',
  'pending_guest_checkout',
  'paid_guest_checkout',
  'order_buyer_and_contact_snapshot',
  'destination_snapshot',
  'access_grants_and_portal_sessions',
  'email_verification_and_recovery',
  'claim_operations',
  'post_purchase_requests',
  'transactional_notification_events',
  'payment_refund_dispute_ledger_payout',
  'security_and_audit_events',
  'product_analytics_and_experimentation',
  'merchant_facing_aggregates',
  'provider_customer_wallet_reference',
] as const;

/** One of {@link GUEST_DATA_CLASSES}. */
export type GuestDataClass = (typeof GUEST_DATA_CLASSES)[number];

/**
 * How sensitive a class is, in the only three bands this domain acts on.
 *
 * `identifying` is the band that decides whether erasure has to reach it:
 * anything that names or can be used to look up a person. `correlating` is the
 * subtler one — a value that names nobody by itself and joins two records that
 * ADR 0003 I11 says must not be joined, which is why a keyed hash sits here
 * rather than in `operational`.
 */
export const GUEST_DATA_SENSITIVITIES = ['identifying', 'correlating', 'operational'] as const;

/** One of {@link GUEST_DATA_SENSITIVITIES}. */
export type GuestDataSensitivity = (typeof GUEST_DATA_SENSITIVITIES)[number];

/**
 * What happens to a class when a guest asks for erasure, or when its retention
 * deadline arrives.
 *
 * `minimized` is the one worth reading: the ROW survives because a commercial
 * or statutory record needs it, and the identifying columns inside it do not.
 * ADR 0003 D15 chose it for the contact snapshot precisely so an order can stay
 * auditable without the address on it, and #106 kept the snapshot off the
 * immutable order for the same reason.
 */
export const GUEST_DATA_DISPOSITIONS = [
  /** The row is DELETED, by the expiry sweep or by a request. */
  'deleted',
  /** The row survives; its identifying columns are overwritten. */
  'minimized',
  /** The row is retained under an obligation a request cannot override. */
  'retained_under_obligation',
  /** Nothing is stored, so there is nothing to dispose of. */
  'not_stored',
] as const;

/** One of {@link GUEST_DATA_DISPOSITIONS}. */
export type GuestDataDisposition = (typeof GUEST_DATA_DISPOSITIONS)[number];

/**
 * Who may read a class. These are the SIX operator allow-lists plus the two
 * non-operator readers, named so the inventory can state access without
 * inventing a seventh vocabulary for it.
 */
export const GUEST_DATA_ACCESS_ROLES = [
  /** The person the data is about, through their own credential. */
  'data_subject',
  /** The seller of an order, through store permissions. */
  'merchant',
  /** `GUEST_OPERATOR_OXY_USER_IDS`. */
  'guest_operator',
  /** `PAYMENT_OPERATOR_OXY_USER_IDS`. */
  'payment_operator',
  /** `ANALYTICS_OPERATOR_OXY_USER_IDS`. */
  'analytics_operator',
  /** Nobody: the value exists only as a digest or ciphertext nothing projects. */
  'none',
] as const;

/** One of {@link GUEST_DATA_ACCESS_ROLES}. */
export type GuestDataAccessRole = (typeof GUEST_DATA_ACCESS_ROLES)[number];

/** One data class, completely stated (#111 inventory: every field it asks for). */
export interface GuestDataClassRecord {
  /** The class. */
  readonly dataClass: GuestDataClass;
  /** What a reader sees. */
  readonly title: string;
  /** The issue that owns the code writing it. */
  readonly owner: string;
  /** Why it exists at all. One sentence, no hedging. */
  readonly purpose: string;
  /**
   * The lawful or contractual basis, where one applies. `contract_performance`
   * for anything a purchase cannot happen without, `legal_obligation` for the
   * financial records, `legitimate_interest` for the security and abuse
   * evidence, `consent` for marketing.
   */
  readonly basis: 'contract_performance' | 'legal_obligation' | 'legitimate_interest' | 'consent';
  /** How sensitive. */
  readonly sensitivity: GuestDataSensitivity;
  /** Whether the identifying values are encrypted or digested at rest. */
  readonly encryptedAtRest: boolean;
  /** Who may read it. */
  readonly accessRoles: readonly GuestDataAccessRole[];
  /** The retention class that governs its clock. */
  readonly retentionClass: GuestRetentionClass;
  /** What happens at that deadline, or on an erasure request. */
  readonly disposition: GuestDataDisposition;
  /**
   * Whether a verified data subject may EXPORT it, and what they get. `false`
   * where the class is somebody else's record (a merchant's fulfilment copy, an
   * operator's audit trail) — #111 export requirement 7.
   */
  readonly exportable: boolean;
  /**
   * Every third party that receives it. Empty means it never leaves Mercaria's
   * own database, which is the answer for most of these and is worth stating.
   */
  readonly downstreamProcessors: readonly string[];
  /** The tables that hold it. Empty ONLY where nothing is stored. */
  readonly tables: readonly string[];
}

/* -------------------------------------------------------------------------- */
/*  2. Retention classes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The retention classes (#111 "Retention policy" 1–13), in the issue's order.
 *
 * A CLASS rather than a per-table TTL, for the reason #77's event classes are
 * classes: the policy lives where somebody can read it as a policy, and the
 * sweep is one rule. `db/expiryTargets.ts` stays the mechanism — this names
 * what each of its entries is FOR, and `retention-policy-census.test.ts` fails
 * the build if a guest table is registered there under no class or classified
 * here with no mechanism.
 */
export const GUEST_RETENTION_CLASSES = [
  'unused_guest_session',
  'abandoned_cart',
  'unpaid_pending_checkout',
  'failed_or_cancelled_payment_attempt',
  'transaction_record',
  'plaintext_equivalent_contact',
  'lookup_hash',
  'access_grant_and_portal_session',
  'notification_delivery_log',
  'support_and_return_evidence',
  'security_audit_event',
  'aggregated_analytics',
  'provider_side_reference',
] as const;

/** One of {@link GUEST_RETENTION_CLASSES}. */
export type GuestRetentionClass = (typeof GUEST_RETENTION_CLASSES)[number];

/**
 * How a class's deletion is actually PERFORMED.
 *
 * Three mechanisms, and the distinction is not bookkeeping. `expiry_sweep` is
 * `db/expiryTargets.ts`, a hard DELETE on a stamped deadline. `minimization_job`
 * overwrites columns in place and is the ONLY thing that can serve a class whose
 * row must survive its contents. `none` is a class with no deletion at all,
 * which is a real and deliberate answer for the financial records — and one that
 * has to be stated, because a class silently absent from every sweep and a class
 * deliberately exempt from every sweep look identical from the outside.
 */
export const GUEST_RETENTION_MECHANISMS = ['expiry_sweep', 'minimization_job', 'none'] as const;

/** One of {@link GUEST_RETENTION_MECHANISMS}. */
export type GuestRetentionMechanism = (typeof GUEST_RETENTION_MECHANISMS)[number];

/** One retention class, completely stated. */
export interface GuestRetentionClassDefinition {
  /** The class. */
  readonly retentionClass: GuestRetentionClass;
  /** What a reader sees. */
  readonly title: string;
  /**
   * The COLUMN the clock runs from, named in prose because it differs per
   * table. "From the deadline the writer stamped" is the common case and says
   * so.
   */
  readonly clock: string;
  /** How long, in seconds. `null` where the class is retained indefinitely. */
  readonly retentionSeconds: number | null;
  /** How the deletion happens. */
  readonly mechanism: GuestRetentionMechanism;
  /**
   * Whether a legal hold or an open dispute PAUSES this class's deletion
   * (#111 retention rule 7). Deliberately per class: a hold on an order's
   * financial evidence must not also freeze the cart TTL, or one dispute pins
   * an unbounded amount of unrelated temporary data.
   */
  readonly pausableByLegalHold: boolean;
  /**
   * Why this figure. Not decoration — a retention nobody can justify is one
   * nobody can defend, and this is the field an auditor reads.
   */
  readonly rationale: string;
}

/* -------------------------------------------------------------------------- */
/*  3. Data subject requests                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a verified guest may ASK for (#111 "Guest data export and deletion").
 *
 * `minimization` is separate from `deletion` because they have different
 * answers: deletion of a paid checkout is impossible (the order is a financial
 * record) while minimization of its contact snapshot is exactly what ADR 0003
 * D15 designed for. Collapsing them would force the response to say "we cannot
 * delete this" where the honest answer is "we removed everything we could".
 */
export const GUEST_DATA_REQUEST_KINDS = ['export', 'deletion', 'minimization'] as const;

/** One of {@link GUEST_DATA_REQUEST_KINDS}. */
export type GuestDataRequestKind = (typeof GUEST_DATA_REQUEST_KINDS)[number];

/**
 * What authorized the request.
 *
 * There are TWO and there is deliberately no third. A verified portal grant
 * (#108, inbox proven) and an Oxy account that has completed a claim (#109,
 * two-sided proof). #111 export requirement 1 — "email alone cannot authorize
 * an export or deletion" — is held by this tuple having no `email_match`
 * member, the same device `RelationshipVerificationMethod` uses to make a
 * name match unrepresentable.
 */
export const GUEST_DATA_REQUEST_PROOFS = ['verified_portal_grant', 'completed_oxy_claim'] as const;

/** One of {@link GUEST_DATA_REQUEST_PROOFS}. */
export type GuestDataRequestProof = (typeof GUEST_DATA_REQUEST_PROOFS)[number];

/** Where a request has got to. */
export const GUEST_DATA_REQUEST_STATES = [
  'received',
  'completed',
  'partially_completed',
  'refused',
] as const;

/** One of {@link GUEST_DATA_REQUEST_STATES}. */
export type GuestDataRequestState = (typeof GUEST_DATA_REQUEST_STATES)[number];

/**
 * Why a class was NOT erased, when it was not.
 *
 * Bounded, because the response tells the requester which classes remain and a
 * free-text reason there is a sentence somebody writes once and nobody
 * maintains. `provider_record` is the ADR 0006 / #111 retention rule 12 case:
 * Stripe holds its own financial records and deleting a Mercaria session does
 * not and must not attempt to destroy them.
 */
export const GUEST_DATA_RETENTION_REASONS = [
  'financial_record',
  'open_dispute',
  'fraud_investigation',
  'legal_hold',
  'merchant_fulfilment_copy',
  'security_audit',
  'provider_record',
] as const;

/** One of {@link GUEST_DATA_RETENTION_REASONS}. */
export type GuestDataRetentionReason = (typeof GUEST_DATA_RETENTION_REASONS)[number];

/**
 * What a requester is told, per class.
 *
 * The response is a LIST of these and never a sentence claiming full deletion
 * (#111 export requirement 3). A class that was erased says so; a class that
 * was not names the reason from the bounded set above.
 */
export interface GuestDataRequestClassOutcome {
  readonly dataClass: GuestDataClass;
  readonly disposition: GuestDataDisposition;
  /** Present exactly when the disposition is `retained_under_obligation`. */
  readonly retainedReason?: GuestDataRetentionReason;
}

/**
 * The whole answer to a request.
 *
 * It carries NO value from any class — an export's payload is delivered
 * separately, through the portal credential that authorized it, and this
 * summary is what the audit row stores.
 */
export interface GuestDataRequestReceipt {
  readonly requestId: string;
  readonly kind: GuestDataRequestKind;
  readonly state: GuestDataRequestState;
  readonly checkoutGroupId: string;
  readonly outcomes: readonly GuestDataRequestClassOutcome[];
  readonly completedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/*  4. Abuse controls                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The rate-limit SCOPES (#111 abuse control 1), one per thing a guest can do
 * that is worth doing too often.
 *
 * Separate scopes rather than one budget, because the alternative is that a
 * shopper who adds ten things to a cart has spent the allowance they need in
 * order to recover their order later — which is the failure mode a single
 * bucket always has and which is worst for the person least able to work
 * around it.
 */
export const GUEST_ABUSE_SCOPES = [
  'session_issuance',
  'cart_write',
  'checkout_creation',
  'payment_attempt',
  'magic_link_request',
  'token_exchange',
  'recovery_request',
  'claim_attempt',
  'return_request',
  'support_message',
] as const;

/** One of {@link GUEST_ABUSE_SCOPES}. */
export type GuestAbuseScope = (typeof GUEST_ABUSE_SCOPES)[number];

/**
 * The AXES a durable counter may be keyed on (#111 abuse control 2).
 *
 * Every one of these is either a value Mercaria minted (a session id, a
 * checkout id), a keyed digest of a value the requester supplied (an email
 * hash), or a COARSE network range. None of them identifies a device, and that
 * is the whole point of the tuple existing: "layered controls that avoid device
 * fingerprinting" is a property of what the counters may be keyed on, not a
 * promise about how they are used.
 *
 * `network_range` is a /24 or /64 rather than an address, the #108 device: it
 * bounds a flood and identifies nobody.
 */
export const GUEST_ABUSE_AXES = [
  'actor',
  'guest_checkout',
  'email_hash',
  'network_range',
  'merchant',
  'provider_outcome',
] as const;

/** One of {@link GUEST_ABUSE_AXES}. */
export type GuestAbuseAxis = (typeof GUEST_ABUSE_AXES)[number];

/**
 * Signals an abuse decision may NOT read, ever (#111 abuse controls 11–14).
 *
 * DISJOINT from {@link GUEST_ABUSE_AXES} by a test, the
 * `RETAIL_FORBIDDEN_COMPONENT_KINDS` device — so the prohibition is a value the
 * build checks rather than a paragraph in a review.
 *
 * Three of them deserve their reason stated, because each is the one somebody
 * reaches for first:
 *
 *  - `guest_status` — being a guest is not evidence of anything. Using it is
 *    how "we deprioritise guests" becomes true without anybody deciding it.
 *  - `stripe_customer_grouping` — Stripe groups payments for its own purposes
 *    and those groupings are not Mercaria identity (ADR 0006 G4, #111 abuse 8
 *    and 13). Reusing a RISK OUTCOME is permitted and is a different thing:
 *    `provider_outcome` above is the outcome of ONE payment, keyed to that
 *    payment.
 *  - `affiliate_commission` — a commercial relationship must never decide
 *    whether somebody is treated as an abuser. Same wall the ranking domain
 *    has, for the same reason.
 */
export const GUEST_FORBIDDEN_ABUSE_SIGNALS = [
  'device_fingerprint',
  'canvas_or_font_signature',
  'user_agent_string',
  'screen_metrics',
  'guest_status',
  'card_fingerprint',
  'stripe_customer_grouping',
  'stripe_link_identity',
  'wallet_identity',
  'affiliate_commission',
  'fair_acceptance',
  'merchant_plan',
] as const;

/** One of {@link GUEST_FORBIDDEN_ABUSE_SIGNALS}. */
export type GuestForbiddenAbuseSignal = (typeof GUEST_FORBIDDEN_ABUSE_SIGNALS)[number];

/**
 * The friction an intervention may apply (#111 abuse control 9).
 *
 * "Increasing friction through explicit policy … rather than silent shadow
 * failure" is held by this tuple: every member is something the person is TOLD,
 * and {@link GUEST_FORBIDDEN_FRICTION_MEASURES} names the ones that would not
 * be. A refusal a requester cannot see is indistinguishable from a bug, both to
 * them and to the on-call engineer they eventually reach.
 */
export const GUEST_FRICTION_MEASURES = [
  /** A stated wait, with an end time the response carries. */
  'cooldown',
  /** The action needs a proven inbox first — #108's existing verification. */
  'email_verification_required',
  /** An operator looks at it. The person is told it is queued, not refused. */
  'manual_review',
] as const;

/** One of {@link GUEST_FRICTION_MEASURES}. */
export type GuestFrictionMeasure = (typeof GUEST_FRICTION_MEASURES)[number];

/**
 * Responses this domain may NEVER produce. DISJOINT from
 * {@link GUEST_FRICTION_MEASURES} by a test.
 *
 * `ranking_demotion` and `merchant_visibility_reduction` are here rather than
 * in the ranking domain's own list because this is where the temptation lives:
 * an abuse score is exactly the input somebody would reach for, and #111
 * acceptance 6 forbids it. `silent_failure` and `shadow_ban` are the same
 * prohibition on the buyer side.
 */
export const GUEST_FORBIDDEN_FRICTION_MEASURES = [
  'silent_failure',
  'shadow_ban',
  'ranking_demotion',
  'merchant_visibility_reduction',
  'service_denial_without_policy',
] as const;

/** One of {@link GUEST_FORBIDDEN_FRICTION_MEASURES}. */
export type GuestForbiddenFrictionMeasure = (typeof GUEST_FORBIDDEN_FRICTION_MEASURES)[number];

/** Where an intervention has got to. */
export const GUEST_INTERVENTION_STATES = [
  'active',
  'expired',
  'lifted',
  /** An operator judged it a false positive. Kept, so the rate is measurable. */
  'false_positive',
] as const;

/** One of {@link GUEST_INTERVENTION_STATES}. */
export type GuestInterventionState = (typeof GUEST_INTERVENTION_STATES)[number];

/**
 * The abuse PATTERNS this domain names (#111 abuse controls 4–7).
 *
 * A pattern is a named reason an intervention exists. It is bounded for the
 * reason every reason code here is bounded: it reaches an operator's queue and
 * a metric, and neither can carry a sentence.
 */
export const GUEST_ABUSE_PATTERNS = [
  'session_farming',
  'abandoned_checkout_flood',
  'recovery_spraying',
  'repeated_claim_conflict',
  'return_or_support_spam',
  'payment_attempt_churn',
] as const;

/** One of {@link GUEST_ABUSE_PATTERNS}. */
export type GuestAbusePattern = (typeof GUEST_ABUSE_PATTERNS)[number];

/**
 * One abuse policy, completely stated — the thresholds are DATA so a change is
 * reviewable and so the operator surface can show what fired.
 */
export interface GuestAbusePolicy {
  readonly pattern: GuestAbusePattern;
  /** The scope whose counters feed it. */
  readonly scope: GuestAbuseScope;
  /** The axis the counter is keyed on. */
  readonly axis: GuestAbuseAxis;
  /** The counting window, in seconds. */
  readonly windowSeconds: number;
  /** The count at or above which the friction applies. */
  readonly threshold: number;
  /** What happens. */
  readonly measure: GuestFrictionMeasure;
  /** How long the friction lasts, in seconds. */
  readonly frictionSeconds: number;
  /**
   * Why this shape. The field exists because a threshold with no stated
   * reasoning is one nobody can safely change.
   */
  readonly rationale: string;
}

/* -------------------------------------------------------------------------- */
/*  5. Security monitoring                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The signals #111 "Security monitoring" 1–15 asks for, in its order.
 *
 * They are COUNTERS and not events, and that is a privacy decision rather than
 * an efficiency one: a row per token-verification failure is a row per
 * attacker's attempt, which is both an amplification primitive and a log of
 * activity nobody consented to. A count per signal per window answers "is this
 * happening more than usual" — the only question an alert asks — and answers
 * "who did it" with nothing.
 */
export const GUEST_SECURITY_SIGNALS = [
  'guest_token_verification_failure',
  'csrf_failure',
  'session_issuance_rate',
  'recovery_request_spike',
  'magic_link_exchange_failure',
  'scanner_consumption_anomaly',
  'cross_order_authorization_failure',
  'duplicate_payment_or_idempotency_conflict',
  'claim_conflict',
  'cleanup_lag',
  'encryption_failure',
  'notification_delivery_failure',
  'operator_sensitive_access',
  'provider_metadata_missing_ids',
  'provider_identity_used_as_access',
  'payment_verified_portal_initialization_lag',
] as const;

/** One of {@link GUEST_SECURITY_SIGNALS}. */
export type GuestSecuritySignal = (typeof GUEST_SECURITY_SIGNALS)[number];

/** How loud a signal is. */
export const GUEST_SIGNAL_SEVERITIES = ['info', 'warning', 'critical'] as const;

/** One of {@link GUEST_SIGNAL_SEVERITIES}. */
export type GuestSignalSeverity = (typeof GUEST_SIGNAL_SEVERITIES)[number];

/**
 * The correlation handles an alert may carry (#111: "safe correlation ids and
 * runbooks, never tokens, full email, full address or payment-method details").
 *
 * Every member is a Mercaria-minted id that authorizes nothing. There is no
 * member for a token, an email, an address or a card, so an alert composer has
 * nothing unsafe to reach for — the `tracePayment` five-handle device.
 */
export const GUEST_SIGNAL_CORRELATION_KINDS = [
  'checkout_group_id',
  'order_id',
  'payment_id',
  'grant_id',
  'claim_id',
  'guest_session_id',
  'none',
] as const;

/** One of {@link GUEST_SIGNAL_CORRELATION_KINDS}. */
export type GuestSignalCorrelationKind = (typeof GUEST_SIGNAL_CORRELATION_KINDS)[number];

/** One security signal, completely stated. */
export interface GuestSecuritySignalDefinition {
  readonly signal: GuestSecuritySignal;
  readonly title: string;
  readonly severity: GuestSignalSeverity;
  /** What it means when the count rises. */
  readonly meaning: string;
  /** The correlation handles an alert on it may carry. */
  readonly correlationKinds: readonly GuestSignalCorrelationKind[];
  /**
   * `<file>#<anchor>` under `docs/runbooks/`. An alert with no runbook is a
   * page at 3am with no next action, which is why this is required rather than
   * optional — and why a test asserts the FILE exists and carries the anchor,
   * rather than only that the string is well shaped. A slug pointing at nothing
   * is the same failure as no slug at all, arriving later and looking fine.
   *
   * ONE file with a section per signal rather than sixteen files: an on-call
   * engineer reading one of these is usually about to read a neighbouring one,
   * and sixteen documents that each need the same four paragraphs of context is
   * how a runbook set goes stale.
   */
  readonly runbook: string;
}

/* -------------------------------------------------------------------------- */
/*  6. Feature gates                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The capabilities #111 "Feature flags" 1–13 asks to be independently gateable,
 * and the lever that answers each.
 *
 * This is a REGISTER, not a set of new levers. Nine flags and five block lists
 * already exist across #103–#110 and ADR 0006, and adding a tenth answer to a
 * question one of them already answers is the specific mistake this file was
 * written to avoid. THREE entries answer `null`, and each states why the
 * absence is a decision:
 *
 *  - the ORDER PORTAL, because #108 decided no lever may gate a portal READ and
 *    `guest-portal-isolation.test.ts` fails the build if one starts to;
 *  - guest P2P, because ADR 0003 D18 refuses it at group construction with no
 *    flag, deliberately, until #112;
 *  - the Stripe CLIENT PATH, because ADR 0006 G2 puts both actor kinds on one
 *    component and a guest-only path lever would be a second answer to
 *    `STRIPE_ENABLED`.
 *
 * Guest PICKUP was a fourth until #93 landed, and the correction is the reason
 * this register is worth keeping accurate: `null` here does not mean "nobody
 * built a flag", it means "there is nothing to flip". `GUEST_STORE_PICKUP_ENABLED`
 * now exists, so an operator reading this during an incident and finding
 * STRUCTURAL would have gone looking for a broader lever — taking the guest
 * cart or guest checkout down to withdraw one fulfilment mode.
 */
export const GUEST_FEATURE_GATES = [
  'session_issuance',
  'cart_read_write',
  'checkout_ui',
  'stripe_payment_creation',
  'payment_methods',
  'stripe_client_path',
  'order_portal',
  'recovery_email',
  'oxy_claim',
  'cancellations_and_returns',
  'pickup',
  'p2p',
  'marketing_experiments',
] as const;

/** One of {@link GUEST_FEATURE_GATES}. */
export type GuestFeatureGate = (typeof GUEST_FEATURE_GATES)[number];

/**
 * The dimensions a gate may be scoped by (#111: "environment, platform, app
 * version, country, currency, merchant cohort, store, seller type and risk
 * state where justified").
 *
 * FIVE are representable and four are deliberately not, which is the useful
 * half of this tuple. `app_version` is a client's own claim and a kill switch
 * keyed on a claim is walked around by editing one string — the reasoning
 * `GuestCheckoutPlatform` already uses for deriving platform from the
 * credential's CARRIAGE instead. `risk_state` is worse: scoping a feature by a
 * risk score is exactly the "silent shadow failure" and the automatic
 * service-denial rule #111 abuse control 9 and acceptance 6 forbid, and it
 * would need a separately reviewed policy before it could exist at all.
 */
export const GUEST_GATE_SCOPES = [
  'environment',
  'platform',
  'country',
  'currency',
  'merchant',
  'seller_type',
  'fulfilment',
  'payment_method',
] as const;

/** One of {@link GUEST_GATE_SCOPES}. */
export type GuestGateScope = (typeof GUEST_GATE_SCOPES)[number];

/** One capability and the lever that answers it. */
export interface GuestFeatureGateRecord {
  readonly gate: GuestFeatureGate;
  readonly title: string;
  /**
   * The environment variable that answers it, or `null` where the answer is
   * structural. Checked against the real configuration by a test, so a renamed
   * variable fails the build here rather than in production at 3am.
   */
  readonly lever: string | null;
  /** The scopes this gate can actually be narrowed by today. */
  readonly scopes: readonly GuestGateScope[];
  /** What happens when it is off — stated from the buyer's side. */
  readonly whenOff: string;
  /**
   * Whether turning it off can affect an ALREADY PLACED order. Must be `false`
   * for every entry; a test asserts it, which is #111 acceptance 7 and rollback
   * rules 1, 2 and 9 in one line.
   */
  readonly affectsPlacedOrders: false;
  /**
   * Rollback ORDER (#111 rollback rule 7). Lower goes off first. Ties are
   * levers that may be pulled together.
   */
  readonly rollbackOrder: number;
}

/* -------------------------------------------------------------------------- */
/*  7. Rollout stages and launch gates                                          */
/* -------------------------------------------------------------------------- */

/** The staged launch (#111 "Rollout plan"). */
export const GUEST_ROLLOUT_STAGES = [
  'stage_0_internal',
  'stage_1_staff_canary',
  'stage_2_pilot_merchants',
  'stage_3_broader_store_checkout',
  'stage_4_p2p_decision',
] as const;

/** One of {@link GUEST_ROLLOUT_STAGES}. */
export type GuestRolloutStage = (typeof GUEST_ROLLOUT_STAGES)[number];

/**
 * The disciplines that must sign off before a public pilot (#111 "Launch
 * gates" and acceptance 10).
 */
export const GUEST_SIGNOFF_DISCIPLINES = [
  'security',
  'privacy',
  'operations',
  'support',
  'engineering',
] as const;

/** One of {@link GUEST_SIGNOFF_DISCIPLINES}. */
export type GuestSignoffDiscipline = (typeof GUEST_SIGNOFF_DISCIPLINES)[number];

/** The fourteen launch gates, in the issue's order. */
export const GUEST_LAUNCH_GATES = [
  'actor_identity_privacy_adr_approved',
  'stripe_guest_amendment_approved',
  'security_review_complete',
  'privacy_and_retention_review_complete',
  'stripe_architecture_production_ready',
  'webhooks_reconciliation_runbooks_operational',
  'transactional_sender_authenticated',
  'merchant_readiness_includes_guest',
  'support_runbooks_staffed',
  'backup_and_restore_validated',
  'dashboard_metrics_and_alerts_live',
  'feature_flags_and_kill_switches_tested',
  'no_unresolved_critical_findings',
  'payment_to_portal_tested_under_failure',
] as const;

/** One of {@link GUEST_LAUNCH_GATES}. */
export type GuestLaunchGate = (typeof GUEST_LAUNCH_GATES)[number];

/**
 * What kind of thing satisfies a gate.
 *
 * `automated_check` is the one that matters: those gates are satisfied by a
 * function this codebase runs, so they cannot be signed off while false. The
 * others need a person, and the register says so rather than pretending a
 * signature is evidence.
 */
export const GUEST_GATE_EVIDENCE_KINDS = [
  'automated_check',
  'document_approval',
  'operational_verification',
  'external_dependency',
] as const;

/** One of {@link GUEST_GATE_EVIDENCE_KINDS}. */
export type GuestGateEvidenceKind = (typeof GUEST_GATE_EVIDENCE_KINDS)[number];

/** One launch gate, completely stated. */
export interface GuestLaunchGateDefinition {
  readonly gate: GuestLaunchGate;
  readonly title: string;
  /** The discipline that owns the sign-off. */
  readonly discipline: GuestSignoffDiscipline;
  /** How it is satisfied. */
  readonly evidenceKind: GuestGateEvidenceKind;
  /** The FIRST stage that requires it. */
  readonly requiredFromStage: GuestRolloutStage;
  /** What "satisfied" means, precisely enough to argue about. */
  readonly criterion: string;
  /**
   * The issue or external dependency that must land first, where one exists.
   * A gate whose blocker is named is a gate somebody can act on.
   */
  readonly blockedBy?: string;
}

/**
 * Why an advance was refused. Bounded, because it reaches an operator surface
 * and a metric.
 */
export const GUEST_STAGE_ADVANCE_REFUSALS = [
  'gate_unsatisfied',
  'stage_out_of_order',
  'already_at_stage',
  'rollback_untested',
  'metrics_unmeasured',
] as const;

/** One of {@link GUEST_STAGE_ADVANCE_REFUSALS}. */
export type GuestStageAdvanceRefusal = (typeof GUEST_STAGE_ADVANCE_REFUSALS)[number];

/**
 * The answer to "may this deployment advance to stage N".
 *
 * A discriminated union with a STRING discriminant, not a boolean: the backend
 * compiles with `strict: false`, and without `strictNullChecks` TypeScript does
 * not narrow a union on the truthiness of a boolean-literal discriminant (the
 * #68 finding, hit again by #110). A caller here must act on the difference —
 * an advance that may proceed and one that may not lead to opposite actions.
 */
export type GuestStageAdvanceVerdict =
  | {
      readonly outcome: 'permitted';
      readonly stage: GuestRolloutStage;
      readonly satisfiedGates: readonly GuestLaunchGate[];
    }
  | {
      readonly outcome: 'refused';
      readonly stage: GuestRolloutStage;
      readonly refusal: GuestStageAdvanceRefusal;
      /** Exactly which gates are not satisfied. Empty for a non-gate refusal. */
      readonly unsatisfiedGates: readonly GuestLaunchGate[];
    };

/* -------------------------------------------------------------------------- */
/*  8. Payment method categories (bounded analytics ids)                        */
/* -------------------------------------------------------------------------- */

/**
 * The BOUNDED payment-method ids #111 analytics measure 5 requires, and #107's
 * seam contract demands.
 *
 * Deliberately NOT the provider's own string. Stripe's `payment_method.type`
 * vocabulary changes with their API, and an unbounded value in an analytics
 * column is how a card brand, a bank name or a wallet identity eventually
 * arrives in one. `other` is the honest fallback, and a method Mercaria has not
 * classified is counted as `other` rather than dropped — a dropped one would
 * make the denominators disagree with `guest_payment_methods_shown`.
 *
 * Nothing here can reconstruct a payment credential (#111 analytics rule 12):
 * there is no brand, no last four, no issuer and no country, because a category
 * answers "which kind of button did they press" and nothing finer.
 */
export const GUEST_PAYMENT_METHOD_CATEGORIES = [
  'card',
  'wallet_apple_pay',
  'wallet_google_pay',
  'bank_redirect',
  'bank_transfer',
  'buy_now_pay_later',
  'other',
] as const;

/** One of {@link GUEST_PAYMENT_METHOD_CATEGORIES}. */
export type GuestPaymentMethodCategory = (typeof GUEST_PAYMENT_METHOD_CATEGORIES)[number];

/* -------------------------------------------------------------------------- */
/*  9. The inventory itself                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every guest data class, classified (#111 "Data inventory and classification").
 *
 * `guest-data-inventory-census.test.ts` walks the real drizzle schema for every
 * table any guest-commerce module writes and asserts each appears in exactly
 * one `tables` list here. That is the `merge-plan-census.test.ts` device applied
 * to privacy, and it is the reason this is a tuple rather than a document: a
 * new guest table fails the build until somebody decides what it is, who may
 * read it and when it goes — which is precisely the decision that otherwise
 * gets made by not being made.
 */
export const GUEST_DATA_INVENTORY: readonly GuestDataClassRecord[] = [
  {
    dataClass: 'guest_session_metadata',
    title: 'Guest session metadata',
    owner: '#103',
    purpose:
      'The device credential that lets somebody keep a cart and reach a checkout without an ' +
      'account. Mercaria mints it; it is not an Oxy identity and cannot become one.',
    basis: 'contract_performance',
    sensitivity: 'correlating',
    encryptedAtRest: true,
    accessRoles: ['data_subject', 'guest_operator'],
    retentionClass: 'unused_guest_session',
    disposition: 'deleted',
    exportable: true,
    downstreamProcessors: [],
    tables: ['guest_sessions'],
  },
  {
    dataClass: 'cart_and_discount_intent',
    title: 'Cart contents and discount intent',
    owner: '#104',
    purpose: 'What somebody intends to buy, and the merge record if they later signed in.',
    basis: 'contract_performance',
    sensitivity: 'operational',
    encryptedAtRest: false,
    accessRoles: ['data_subject', 'guest_operator'],
    retentionClass: 'abandoned_cart',
    disposition: 'deleted',
    exportable: true,
    downstreamProcessors: [],
    tables: ['carts', 'cart_items', 'cart_merges'],
  },
  {
    dataClass: 'pending_guest_checkout',
    title: 'A guest checkout that has not been paid',
    owner: '#105',
    purpose:
      'The contact and destination a buyer supplied so an order can be placed and delivered. ' +
      'One row per checkout GROUP, never a profile.',
    basis: 'contract_performance',
    sensitivity: 'identifying',
    encryptedAtRest: true,
    accessRoles: ['data_subject', 'guest_operator'],
    retentionClass: 'unpaid_pending_checkout',
    disposition: 'deleted',
    exportable: true,
    downstreamProcessors: [],
    tables: ['guest_checkouts'],
  },
  {
    dataClass: 'paid_guest_checkout',
    title: 'A guest checkout with a paid order behind it',
    owner: '#105',
    purpose:
      'The same row after payment. It stops being temporary the moment an order references it: ' +
      'the seller has to ship to it and the order has to remain auditable.',
    basis: 'legal_obligation',
    sensitivity: 'identifying',
    encryptedAtRest: true,
    accessRoles: ['data_subject', 'merchant', 'guest_operator'],
    retentionClass: 'plaintext_equivalent_contact',
    disposition: 'minimized',
    exportable: true,
    downstreamProcessors: [],
    tables: [],
  },
  {
    dataClass: 'order_buyer_and_contact_snapshot',
    title: 'The order, its buyer origin and its status trail',
    owner: '#106',
    purpose:
      'The commercial record of a purchase. Carries a buyer ORIGIN and, after a claim, a ' +
      'claimant — never a copy of the contact, which is what makes D15 erasure reachable.',
    basis: 'legal_obligation',
    sensitivity: 'correlating',
    encryptedAtRest: false,
    accessRoles: ['data_subject', 'merchant', 'guest_operator', 'payment_operator'],
    retentionClass: 'transaction_record',
    disposition: 'retained_under_obligation',
    exportable: true,
    downstreamProcessors: [],
    tables: ['orders', 'order_items', 'order_status_history'],
  },
  {
    dataClass: 'destination_snapshot',
    title: 'The shipping or pickup destination',
    owner: '#105',
    purpose: 'Where the goods go. Snapshotted onto the order so a later address edit cannot move a parcel.',
    basis: 'contract_performance',
    sensitivity: 'identifying',
    encryptedAtRest: false,
    accessRoles: ['data_subject', 'merchant'],
    retentionClass: 'plaintext_equivalent_contact',
    disposition: 'minimized',
    exportable: true,
    downstreamProcessors: [],
    tables: [],
  },
  {
    dataClass: 'access_grants_and_portal_sessions',
    title: 'Portal credentials and exchange tokens',
    owner: '#108',
    purpose:
      'How somebody who bought without an account comes back to that purchase. One credential ' +
      'authorizes exactly one checkout group and nothing else.',
    basis: 'contract_performance',
    sensitivity: 'correlating',
    encryptedAtRest: true,
    accessRoles: ['data_subject', 'guest_operator'],
    retentionClass: 'access_grant_and_portal_session',
    disposition: 'deleted',
    exportable: false,
    downstreamProcessors: [],
    tables: ['guest_order_access_grants'],
  },
  {
    dataClass: 'email_verification_and_recovery',
    title: 'Recovery attempts and address suppressions',
    owner: '#108',
    purpose:
      'A throttle over how often an inbox may be asked about, and a record of an address that ' +
      'asked to stop receiving mail.',
    basis: 'legitimate_interest',
    sensitivity: 'correlating',
    encryptedAtRest: true,
    accessRoles: ['none'],
    retentionClass: 'security_audit_event',
    disposition: 'deleted',
    exportable: false,
    downstreamProcessors: [],
    tables: ['guest_recovery_attempts', 'guest_contact_suppressions', 'guest_contact_routing'],
  },
  {
    dataClass: 'claim_operations',
    title: 'Claims and their revocations',
    owner: '#109',
    purpose:
      'Who owns access to a purchase, and the audit of an operator correcting that. A ' +
      'commercial-ownership record, which is why nothing sweeps it.',
    basis: 'legal_obligation',
    sensitivity: 'correlating',
    encryptedAtRest: false,
    accessRoles: ['data_subject', 'guest_operator'],
    retentionClass: 'transaction_record',
    disposition: 'retained_under_obligation',
    exportable: true,
    downstreamProcessors: [],
    tables: ['guest_order_claims', 'guest_order_claim_revocations', 'guest_order_claim_outbox'],
  },
  {
    dataClass: 'post_purchase_requests',
    title: 'Cancellations, returns and support threads',
    owner: '#110',
    purpose: 'What a buyer asked for after the purchase, and the evidence attached to it.',
    basis: 'contract_performance',
    sensitivity: 'operational',
    encryptedAtRest: false,
    accessRoles: ['data_subject', 'merchant', 'guest_operator'],
    retentionClass: 'support_and_return_evidence',
    disposition: 'retained_under_obligation',
    exportable: true,
    downstreamProcessors: [],
    tables: [
      'cancellation_requests',
      'cancellation_request_lines',
      'return_requests',
      'return_request_lines',
      'return_request_evidence',
      'support_threads',
      'support_messages',
      'buyer_request_events',
    ],
  },
  {
    dataClass: 'transactional_notification_events',
    title: 'Queued and sent transactional messages',
    owner: '#108',
    purpose:
      'The delivery queue for order confirmations and access links. The row holds no recipient, ' +
      'no subject and no body — the send path decrypts at the moment of sending.',
    basis: 'contract_performance',
    sensitivity: 'operational',
    encryptedAtRest: false,
    accessRoles: ['guest_operator'],
    retentionClass: 'notification_delivery_log',
    disposition: 'deleted',
    exportable: false,
    downstreamProcessors: [],
    tables: ['guest_portal_messages'],
  },
  {
    dataClass: 'payment_refund_dispute_ledger_payout',
    title: 'Payments, refunds, disputes, ledger and payouts',
    owner: '#47/#49',
    purpose:
      'What money moved. Mercaria’s commission exists nowhere else, so these are the records ' +
      'a cart TTL must never reach.',
    basis: 'legal_obligation',
    sensitivity: 'operational',
    encryptedAtRest: false,
    accessRoles: ['payment_operator'],
    retentionClass: 'transaction_record',
    disposition: 'retained_under_obligation',
    exportable: false,
    downstreamProcessors: ['Stripe'],
    tables: [],
  },
  {
    dataClass: 'security_and_audit_events',
    title: 'Security counters, abuse evidence and operator audit',
    owner: '#111',
    purpose:
      'Whether something is happening more than usual, and what staff did on a buyer’s behalf. ' +
      'Counts, never a row per attempt.',
    basis: 'legitimate_interest',
    sensitivity: 'correlating',
    encryptedAtRest: true,
    accessRoles: ['guest_operator'],
    retentionClass: 'security_audit_event',
    disposition: 'deleted',
    exportable: false,
    downstreamProcessors: [],
    tables: [
      'guest_abuse_counters',
      'guest_abuse_interventions',
      'guest_security_signal_counters',
      'guest_portal_operator_actions',
      'guest_data_requests',
    ],
  },
  {
    dataClass: 'product_analytics_and_experimentation',
    title: 'Discovery and funnel analytics',
    owner: '#77',
    purpose:
      'Whether Mercaria helps people find and act on useful products. It cannot measure who ' +
      'they are: the actor dimension is a pseudonym under a salt deleted at 45 days.',
    basis: 'legitimate_interest',
    sensitivity: 'correlating',
    encryptedAtRest: false,
    accessRoles: ['analytics_operator'],
    retentionClass: 'aggregated_analytics',
    disposition: 'deleted',
    exportable: false,
    downstreamProcessors: [],
    tables: [
      'analytics_events',
      'analytics_search_queries',
      'analytics_experiment_exposures',
      'analytics_pseudonym_salts',
    ],
  },
  {
    dataClass: 'merchant_facing_aggregates',
    title: 'Merchant-facing aggregate metrics',
    owner: '#77',
    purpose:
      'What a store sees about its own products. Suppressed below a cohort of ten, with no ' +
      'buyer-origin breakdown at all.',
    basis: 'legitimate_interest',
    sensitivity: 'operational',
    encryptedAtRest: false,
    accessRoles: ['merchant', 'analytics_operator'],
    retentionClass: 'aggregated_analytics',
    disposition: 'deleted',
    exportable: false,
    downstreamProcessors: [],
    tables: ['analytics_rollups', 'analytics_query_aggregates'],
  },
  {
    dataClass: 'provider_customer_wallet_reference',
    title: 'Stripe Customer, Link and wallet references',
    owner: 'ADR 0006',
    purpose:
      'NONE ARE STORED. ADR 0006 G4/G5 configure no Customer and no CustomerSession, so the ' +
      'save-card surfaces are ABSENT rather than hidden and there is no reference to retain. ' +
      'The class exists to record that answer, not to leave the question unasked.',
    basis: 'contract_performance',
    sensitivity: 'operational',
    encryptedAtRest: false,
    accessRoles: ['none'],
    retentionClass: 'provider_side_reference',
    disposition: 'not_stored',
    exportable: false,
    downstreamProcessors: ['Stripe'],
    tables: [],
  },
];

/* -------------------------------------------------------------------------- */
/*  10. The retention schedule                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every retention class, with its clock, its figure and why.
 *
 * The figures are not new policy — they are what #103 through #110 already
 * stamp, gathered so they can be read as a schedule and checked against
 * `db/expiryTargets.ts` by a test. Where a class has no entry in that registry
 * the mechanism says so explicitly, because a class silently absent from every
 * sweep and one deliberately exempt look identical from outside.
 */
export const GUEST_RETENTION_SCHEDULE: readonly GuestRetentionClassDefinition[] = [
  {
    retentionClass: 'unused_guest_session',
    title: 'Unused or abandoned guest session',
    clock: 'guest_sessions.expires_at, or revoked_at — whichever the row reached first',
    retentionSeconds: 7 * 24 * 60 * 60,
    mechanism: 'expiry_sweep',
    pausableByLegalHold: false,
    rationale:
      'Authorization ended at expires_at, which the resolver enforces independently, so the ' +
      'grace is forensic headroom rather than a soft delete. It is not pausable because a ' +
      'session is a device credential and holding one open changes nothing about an order.',
  },
  {
    retentionClass: 'abandoned_cart',
    title: 'Abandoned cart',
    clock: 'the owning guest_sessions row, by ON DELETE CASCADE',
    retentionSeconds: null,
    mechanism: 'expiry_sweep',
    pausableByLegalHold: false,
    rationale:
      'A guest cart has no clock of its own and must not acquire one. carts.guest_session_id ' +
      'CASCADEs, so the cart leaves with the credential that owned it — retention correct by ' +
      'construction rather than by a second sweep that could disagree with the first.',
  },
  {
    retentionClass: 'unpaid_pending_checkout',
    title: 'Pending checkout that never reached payment',
    clock: 'guest_checkouts.created_at, once no order references the group',
    retentionSeconds: 30 * 24 * 60 * 60,
    mechanism: 'minimization_job',
    pausableByLegalHold: true,
    rationale:
      'Thirty days covers a bank redirect that completes late and a buyer who returns to a ' +
      'saved tab. It is a MINIMIZATION rather than a delete because a sibling order may already ' +
      'reference the row; the job erases the contact and leaves the referenced row standing.',
  },
  {
    retentionClass: 'failed_or_cancelled_payment_attempt',
    title: 'Failed or cancelled payment attempt',
    clock: 'payment_provider_events.expires_at (the raw envelope), 90 days from receipt',
    retentionSeconds: 90 * 24 * 60 * 60,
    mechanism: 'expiry_sweep',
    pausableByLegalHold: true,
    rationale:
      'Ninety days is past every provider redelivery schedule and past the dispute windows the ' +
      'events describe. What the envelope was interpreted INTO is permanent; this removes the ' +
      'envelope. A dispute pauses it, because the envelope is the evidence.',
  },
  {
    retentionClass: 'transaction_record',
    title: 'Paid orders and required transaction records',
    clock: 'none',
    retentionSeconds: null,
    mechanism: 'none',
    pausableByLegalHold: false,
    rationale:
      'Statutory and contractual retention, not a cart TTL (#111 retention rule 3). Deliberately ' +
      'exempt from every sweep, and stated here so the exemption is a decision on the record ' +
      'rather than an omission. A legal hold cannot PAUSE a deletion that never happens.',
  },
  {
    retentionClass: 'plaintext_equivalent_contact',
    title: 'Plaintext-equivalent contact and address data',
    clock: 'the order group reaching a terminal state, plus the dispute window',
    retentionSeconds: 400 * 24 * 60 * 60,
    mechanism: 'minimization_job',
    pausableByLegalHold: true,
    rationale:
      'Minimized independently of the order (#111 retention rule 4), which is the whole reason ' +
      '#106 kept the snapshot OFF the immutable order. Four hundred days clears the longest ' +
      'card scheme chargeback window with margin; after it the order stays auditable and the ' +
      'address does not survive.',
  },
  {
    retentionClass: 'lookup_hash',
    title: 'Normalized email lookup hashes',
    clock: 'the same minimization pass that erases the ciphertext beside it',
    retentionSeconds: 400 * 24 * 60 * 60,
    mechanism: 'minimization_job',
    pausableByLegalHold: true,
    rationale:
      'A keyed digest is NOT anonymous (#111 retention rule 5): it is an exact-match oracle, so ' +
      'anyone holding an address can test it. It therefore leaves with the value it digests and ' +
      'never outlives it — which is also why it sits in PROTECTED_COLUMNS.',
  },
  {
    retentionClass: 'access_grant_and_portal_session',
    title: 'Access grants and portal sessions',
    clock: 'guest_order_access_grants.purge_at, stamped by the grant’s own purpose',
    retentionSeconds: null,
    mechanism: 'expiry_sweep',
    pausableByLegalHold: false,
    rationale:
      'Exchange tokens 24 h past expiry, portal credentials 90 days (ADR 0003 D11). Authorization ' +
      'ended at expires_at, so the delete removes an audit record and never a live credential.',
  },
  {
    retentionClass: 'notification_delivery_log',
    title: 'Transactional notification delivery events',
    clock: 'guest_portal_messages.expires_at, 14 days from enqueue',
    retentionSeconds: 14 * 24 * 60 * 60,
    mechanism: 'expiry_sweep',
    pausableByLegalHold: false,
    rationale:
      'A message stuck for a fortnight is not going to send on day fifteen. What surfaces a ' +
      'stalled dispatcher is the ORDER, which stays placed, paid and readable in the portal.',
  },
  {
    retentionClass: 'support_and_return_evidence',
    title: 'Support and return evidence',
    clock: 'none while the order is retained',
    retentionSeconds: null,
    mechanism: 'none',
    pausableByLegalHold: false,
    rationale:
      'A return is a commercial record with money attached and its evidence is why a refund was ' +
      'made. It is bounded by the number of orders rather than by traffic, so nothing here grows ' +
      'without a purchase behind it.',
  },
  {
    retentionClass: 'security_audit_event',
    title: 'Security counters and abuse evidence',
    clock: 'the counter’s own window_started_at',
    retentionSeconds: 90 * 24 * 60 * 60,
    mechanism: 'expiry_sweep',
    pausableByLegalHold: true,
    rationale:
      'Long enough for an incident review to look back a quarter, short enough that a counter ' +
      'whose only remaining property is that somebody once acted does not persist. A live ' +
      'investigation pauses it, because that is exactly when the counters matter.',
  },
  {
    retentionClass: 'aggregated_analytics',
    title: 'Analytics events, rollups and aggregates',
    clock: 'each table’s own expires_at, stamped from the event CLASS',
    retentionSeconds: null,
    mechanism: 'expiry_sweep',
    pausableByLegalHold: false,
    rationale:
      'Thirty to 730 days by class (#77). The rollup runs before the raw rows expire, so ' +
      'deleting them costs a dashboard nothing. Not pausable: no analytics row is evidence about ' +
      'a person, which is the property that makes a hold unnecessary rather than inconvenient.',
  },
  {
    retentionClass: 'provider_side_reference',
    title: 'Provider customer, Link or wallet references',
    clock: 'not applicable',
    retentionSeconds: null,
    mechanism: 'none',
    pausableByLegalHold: false,
    rationale:
      'None is stored. ADR 0006 G4/G5 configure no Stripe Customer, so there is no reference ' +
      'that could outlive its purpose (#111 retention rule 11) — and deleting a Mercaria guest ' +
      'session never attempts to destroy the provider records reconciliation needs (rule 12).',
  },
];

/* -------------------------------------------------------------------------- */
/*  11. The abuse policies                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The abuse policies, as data.
 *
 * Every threshold here is DELIBERATELY generous. A control that fires on
 * ordinary behaviour is a control somebody disables, and the failure it
 * produces — a real buyer told to wait — is worse than the abuse it prevents at
 * these volumes. The network axis is a /24 or /64, so a shared office or a
 * carrier NAT is one subject; the thresholds are set against that rather than
 * against one person.
 */
export const GUEST_ABUSE_POLICIES: readonly GuestAbusePolicy[] = [
  {
    pattern: 'session_farming',
    scope: 'session_issuance',
    axis: 'network_range',
    windowSeconds: 60 * 60,
    threshold: 200,
    measure: 'cooldown',
    frictionSeconds: 15 * 60,
    rationale:
      'Two hundred new credentials an hour from one /24 is a script, not an office. The ' +
      'cooldown is short because the false positive is a shared network and the cost of being ' +
      'wrong is somebody unable to start a cart.',
  },
  {
    pattern: 'abandoned_checkout_flood',
    scope: 'checkout_creation',
    axis: 'actor',
    windowSeconds: 60 * 60,
    threshold: 40,
    measure: 'cooldown',
    frictionSeconds: 30 * 60,
    rationale:
      'Keyed on the ACTOR rather than the network, because checkout creation reserves stock and ' +
      'the harm is per credential. Forty in an hour is far above a buyer retrying a declined card.',
  },
  {
    pattern: 'recovery_spraying',
    scope: 'recovery_request',
    axis: 'network_range',
    windowSeconds: 60 * 60,
    threshold: 60,
    measure: 'cooldown',
    frictionSeconds: 60 * 60,
    rationale:
      'The one control that must not reveal anything: #108 answers every recovery request with ' +
      'the same 202 whether or not an inbox matched, so this counter is keyed on the NETWORK and ' +
      'never on whether a lookup succeeded. Counting matches would rebuild the enumeration ' +
      'oracle the 202 exists to close.',
  },
  {
    pattern: 'repeated_claim_conflict',
    scope: 'claim_attempt',
    axis: 'actor',
    windowSeconds: 24 * 60 * 60,
    threshold: 5,
    measure: 'manual_review',
    frictionSeconds: 24 * 60 * 60,
    rationale:
      'A contest is somebody trying to take a purchase that is already owned. Five in a day is ' +
      'not a mistake, and the measure is REVIEW rather than a cooldown because the right answer ' +
      'may be that the incumbent claim is the wrong one.',
  },
  {
    pattern: 'return_or_support_spam',
    scope: 'support_message',
    axis: 'guest_checkout',
    windowSeconds: 24 * 60 * 60,
    threshold: 50,
    measure: 'cooldown',
    frictionSeconds: 60 * 60,
    rationale:
      'Keyed on the CHECKOUT, so an angry buyer with a genuine problem exhausts one order’s ' +
      'budget and not their ability to contact anybody about a different one.',
  },
  {
    pattern: 'payment_attempt_churn',
    scope: 'payment_attempt',
    axis: 'guest_checkout',
    windowSeconds: 60 * 60,
    threshold: 25,
    measure: 'cooldown',
    frictionSeconds: 15 * 60,
    rationale:
      'Card testing looks like many attempts against one intent. Keyed on the checkout because ' +
      'that is what a tester varies least, and set above what any real buyer does — a person ' +
      'with three cards tries three times, not twenty-five.',
  },
];

/* -------------------------------------------------------------------------- */
/*  12. The security signal register                                            */
/* -------------------------------------------------------------------------- */

/** Every security signal, with its meaning, its safe handles and its runbook. */
export const GUEST_SECURITY_SIGNAL_REGISTER: readonly GuestSecuritySignalDefinition[] = [
  {
    signal: 'guest_token_verification_failure',
    title: 'Guest token verification failures',
    severity: 'warning',
    meaning:
      'A credential was presented and did not resolve. Ordinary at a low rate (expired sessions ' +
      'on returning devices); a spike is guessing or a rotation gone wrong.',
    correlationKinds: ['none'],
    runbook: 'guest-commerce-signals#guest_token_verification_failure',
  },
  {
    signal: 'csrf_failure',
    title: 'CSRF origin verification failures',
    severity: 'warning',
    meaning:
      'A cookie-authenticated state-changing request arrived from an origin the allow-list does ' +
      'not contain. A sustained rate means either an attack or a deploy that forgot an origin.',
    correlationKinds: ['none'],
    runbook: 'guest-commerce-signals#csrf_failure',
  },
  {
    signal: 'session_issuance_rate',
    title: 'Guest session issuance rate',
    severity: 'info',
    meaning: 'How many credentials are being minted. The farming detector reads the same counter.',
    correlationKinds: ['none'],
    runbook: 'guest-commerce-signals#session_issuance_rate',
  },
  {
    signal: 'recovery_request_spike',
    title: 'Recovery request spike',
    severity: 'warning',
    meaning:
      'Somebody is asking about many inboxes. Never carries whether a lookup matched — that is ' +
      'the enumeration oracle the uniform 202 exists to close.',
    correlationKinds: ['none'],
    runbook: 'guest-commerce-signals#recovery_request_spike',
  },
  {
    signal: 'magic_link_exchange_failure',
    title: 'Magic-link exchange failures',
    severity: 'warning',
    meaning:
      'An exchange token was presented and refused. Expected at a low rate (a link opened twice); ' +
      'a spike means links are leaking or being guessed.',
    correlationKinds: ['grant_id'],
    runbook: 'guest-commerce-signals#magic_link_exchange_failure',
  },
  {
    signal: 'scanner_consumption_anomaly',
    title: 'Link-scanner consumption anomaly',
    severity: 'warning',
    meaning:
      'Single-use links consumed by something that is not the recipient — a mail security ' +
      'appliance prefetching. Shows as exchanges immediately followed by a human failure.',
    correlationKinds: ['grant_id'],
    runbook: 'guest-commerce-signals#scanner_consumption_anomaly',
  },
  {
    signal: 'cross_order_authorization_failure',
    title: 'Cross-order authorization failures',
    severity: 'critical',
    meaning:
      'A credential valid for one checkout group asked about another. Should be ZERO: a grant ' +
      'authorizes exactly one group and nothing composes a request across two.',
    correlationKinds: ['checkout_group_id', 'grant_id'],
    runbook: 'guest-commerce-signals#cross_order_authorization_failure',
  },
  {
    signal: 'duplicate_payment_or_idempotency_conflict',
    title: 'Duplicate payment or idempotency conflict',
    severity: 'critical',
    meaning:
      'A payment key was reused with different content. Means a client is composing a key ' +
      'non-deterministically or two racers disagree about a checkout group.',
    correlationKinds: ['checkout_group_id', 'payment_id'],
    runbook: 'guest-commerce-signals#duplicate_payment_or_idempotency_conflict',
  },
  {
    signal: 'claim_conflict',
    title: 'Claim conflicts',
    severity: 'warning',
    meaning:
      'Two accounts tried to claim one checkout group. One is legitimate (a household); many ' +
      'from one actor is the abuse pattern above.',
    correlationKinds: ['checkout_group_id', 'claim_id'],
    runbook: 'guest-commerce-signals#claim_conflict',
  },
  {
    signal: 'cleanup_lag',
    title: 'Retention cleanup lag',
    severity: 'critical',
    meaning:
      'Rows past their deadline that still exist. The one failure in this domain invisible from ' +
      'everywhere else: the system works perfectly while a retention guarantee has quietly ' +
      'stopped being true.',
    correlationKinds: ['none'],
    runbook: 'guest-commerce-signals#cleanup_lag',
  },
  {
    signal: 'encryption_failure',
    title: 'Encryption or decryption failures',
    severity: 'critical',
    meaning:
      'A contact could not be sealed or opened. Means a key rotation went wrong, and every ' +
      'affected order becomes unshippable rather than merely unreadable.',
    correlationKinds: ['checkout_group_id'],
    runbook: 'guest-commerce-signals#encryption_failure',
  },
  {
    signal: 'notification_delivery_failure',
    title: 'Transactional notification delivery failures',
    severity: 'warning',
    meaning:
      'A message dead-lettered. Today every attempt fails `transport_unconfigured` because ' +
      'Mercaria has no outbound mail; this counter is what makes that visible as a number ' +
      'rather than as an absence.',
    correlationKinds: ['checkout_group_id'],
    runbook: 'guest-commerce-signals#notification_delivery_failure',
  },
  {
    signal: 'operator_sensitive_access',
    title: 'Operator access to sensitive guest records',
    severity: 'info',
    meaning:
      'Staff read or acted on a guest record. Counted rather than alerted on: the point is that ' +
      'the number exists and is reviewable, not that any single access is suspicious.',
    correlationKinds: ['checkout_group_id'],
    runbook: 'guest-commerce-signals#operator_sensitive_access',
  },
  {
    signal: 'provider_metadata_missing_ids',
    title: 'Provider metadata missing the stable Mercaria ids',
    severity: 'critical',
    meaning:
      'A PaymentIntent reached the rail without the ids reconciliation needs. Every payment ' +
      'after it is unattributable until somebody notices, which is what this counter is for.',
    correlationKinds: ['payment_id'],
    runbook: 'guest-commerce-signals#provider_metadata_missing_ids',
  },
  {
    signal: 'provider_identity_used_as_access',
    title: 'Attempts to use provider identity as order access',
    severity: 'critical',
    meaning:
      'Something presented a Stripe Customer, a Link identity or a wallet as proof of who a ' +
      'buyer is. Should be structurally impossible — no function takes one — so any count is a ' +
      'code path that should not exist.',
    correlationKinds: ['checkout_group_id'],
    runbook: 'guest-commerce-signals#provider_identity_used_as_access',
  },
  {
    signal: 'payment_verified_portal_initialization_lag',
    title: 'Portal initialization lag after verified payment',
    severity: 'warning',
    meaning:
      'A payment succeeded and the portal grant that lets the buyer find it has not been ' +
      'initialized. The buyer has paid and cannot see their order, which is the worst state ' +
      'guest commerce has.',
    correlationKinds: ['checkout_group_id', 'payment_id'],
    runbook: 'guest-commerce-signals#payment_verified_portal_initialization_lag',
  },
];

/* -------------------------------------------------------------------------- */
/*  13. The feature-gate register                                               */
/* -------------------------------------------------------------------------- */

/** Every capability #111 asks to be gateable, and the lever that answers it. */
export const GUEST_FEATURE_GATE_REGISTER: readonly GuestFeatureGateRecord[] = [
  {
    gate: 'session_issuance',
    title: 'Guest session issuance',
    lever: 'GUEST_SESSION_ISSUANCE_ENABLED',
    scopes: ['environment'],
    whenOff:
      'No NEW credential is minted. Existing sessions keep resolving, rotating and revoking, ' +
      'so a shopper mid-purchase is not signed out of their own cart.',
    affectsPlacedOrders: false,
    rollbackOrder: 1,
  },
  {
    gate: 'cart_read_write',
    title: 'Guest cart reads and writes',
    lever: 'GUEST_CART_ENABLED',
    scopes: ['environment'],
    whenOff: 'Reads answer empty and writes are refused with GUEST_CART_DISABLED. The MERGE stays available.',
    affectsPlacedOrders: false,
    rollbackOrder: 3,
  },
  {
    gate: 'checkout_ui',
    title: 'Guest checkout creation',
    lever: 'GUEST_INLINE_DESTINATION_ENABLED',
    scopes: ['environment', 'country'],
    whenOff: 'The cart survives and checkout is refused as temporarily unavailable.',
    affectsPlacedOrders: false,
    rollbackOrder: 2,
  },
  {
    gate: 'stripe_payment_creation',
    title: 'Opening a payment for a guest checkout',
    lever: 'GUEST_CHECKOUT_BLOCKED_MARKETS',
    scopes: ['platform', 'country', 'merchant', 'fulfilment'],
    whenOff:
      'The four ADR 0006 block lists refuse the checkout BEFORE a PaymentIntent is opened, under ' +
      'one reason code that names no lever. There is deliberately no separate "may a guest open ' +
      'a payment" switch: a checkout that may be created and not paid is a reservation nobody ' +
      'can complete.',
    affectsPlacedOrders: false,
    rollbackOrder: 2,
  },
  {
    gate: 'payment_methods',
    title: 'Specific payment methods',
    lever: 'STRIPE_PAYMENT_SURFACE_METHODS',
    scopes: ['payment_method'],
    whenOff: 'The method is not offered to either actor kind — one component serves both.',
    affectsPlacedOrders: false,
    rollbackOrder: 4,
  },
  {
    gate: 'stripe_client_path',
    title: 'The Stripe client path',
    lever: null,
    scopes: [],
    whenOff:
      'STRUCTURAL: ADR 0006 G2 puts both actor kinds on one CardPaymentStep, so a guest-only path ' +
      'lever would be a second answer to STRIPE_ENABLED and would make the two paths diverge ' +
      'exactly where they must not.',
    affectsPlacedOrders: false,
    rollbackOrder: 99,
  },
  {
    gate: 'order_portal',
    title: 'The guest order portal',
    lever: null,
    scopes: [],
    whenOff:
      'STRUCTURAL: #108 decided NO lever gates a portal read, and guest-portal-isolation.test.ts ' +
      'fails the build if one starts to. A rollback that cost a paid buyer access to their own ' +
      'order is not one anybody would pull.',
    affectsPlacedOrders: false,
    rollbackOrder: 99,
  },
  {
    gate: 'recovery_email',
    title: 'Transactional message delivery',
    lever: 'GUEST_PORTAL_MESSAGE_DELIVERY_ENABLED',
    scopes: ['environment'],
    whenOff: 'The dispatcher LOOP stops. Rows are still enqueued and send once it is back.',
    affectsPlacedOrders: false,
    rollbackOrder: 5,
  },
  {
    gate: 'oxy_claim',
    title: 'Claiming a guest checkout into an Oxy account',
    lever: 'GUEST_CLAIM_ENABLED',
    scopes: ['environment'],
    whenOff: 'The WRITE is refused. Stored claims, and every access they granted, are untouched.',
    affectsPlacedOrders: false,
    rollbackOrder: 6,
  },
  {
    gate: 'cancellations_and_returns',
    title: 'Buyer cancellations, returns and support',
    lever: 'BUYER_REQUESTS_ENABLED',
    scopes: ['environment'],
    whenOff: 'The buyer WRITE mount answers 503 under its own code. Filed requests keep being decided.',
    affectsPlacedOrders: false,
    rollbackOrder: 7,
  },
  {
    gate: 'pickup',
    title: 'Guest pickup',
    lever: 'GUEST_STORE_PICKUP_ENABLED',
    scopes: ['environment'],
    whenOff:
      'Guest collection is refused with guest_pickup_disabled; AUTHENTICATED collection, the guest ' +
      'cart and the guest checkout are untouched. Note the ONE-WAY dependency an incident must ' +
      'not be surprised by: STORE_PICKUP_ENABLED off takes guest pickup with it, and this lever ' +
      'cannot turn collection on by itself. Neither gates a durable record — a placed collection ' +
      'order, its code and its desk trail survive both being off (#93 operations rule 10).',
    affectsPlacedOrders: false,
    // Narrowing WHICH fulfilment modes are offered, without stopping a checkout
    // — the same shape as `payment_methods`, hence the same position. A tie is
    // levers that may be pulled together.
    rollbackOrder: 4,
  },
  {
    gate: 'p2p',
    title: 'Guest purchases from individual sellers',
    lever: null,
    scopes: [],
    whenOff:
      'STRUCTURAL: ADR 0003 D18 refuses guest P2P at group construction with no flag, ' +
      'deliberately, until #112 decides it on measured evidence. A lever would make it a ' +
      'setting somebody could flip before that decision was taken.',
    affectsPlacedOrders: false,
    rollbackOrder: 99,
  },
  {
    gate: 'marketing_experiments',
    title: 'Marketing experiments',
    lever: 'ANALYTICS_COLLECTION_MODE',
    scopes: ['environment'],
    whenOff:
      'No experiment is assigned or recorded. Already SEPARATE from every transactional lever: ' +
      'nothing in a guest commerce path reads the analytics configuration, and nothing in the ' +
      'analytics domain reads config.guest.',
    affectsPlacedOrders: false,
    rollbackOrder: 8,
  },
];

/* -------------------------------------------------------------------------- */
/*  14. The launch gates                                                        */
/* -------------------------------------------------------------------------- */

/** The fourteen launch gates, with the discipline that owns each. */
export const GUEST_LAUNCH_GATE_REGISTER: readonly GuestLaunchGateDefinition[] = [
  {
    gate: 'actor_identity_privacy_adr_approved',
    title: 'ADR 0003 approved',
    discipline: 'privacy',
    evidenceKind: 'document_approval',
    requiredFromStage: 'stage_1_staff_canary',
    criterion: 'ADR 0003 is merged and its decisions D1–D18 are the ones the code implements.',
  },
  {
    gate: 'stripe_guest_amendment_approved',
    title: 'ADR 0006 approved',
    discipline: 'privacy',
    evidenceKind: 'document_approval',
    requiredFromStage: 'stage_1_staff_canary',
    criterion: 'ADR 0006 is merged and G1–G18 are the ones the guest card rail implements.',
  },
  {
    gate: 'security_review_complete',
    title: 'Security review of session, CSRF, magic links, provider identity and order authorization',
    discipline: 'security',
    evidenceKind: 'document_approval',
    requiredFromStage: 'stage_1_staff_canary',
    criterion: 'A recorded review covering all five surfaces, with no unresolved critical or high finding.',
  },
  {
    gate: 'privacy_and_retention_review_complete',
    title: 'Privacy and retention review',
    discipline: 'privacy',
    evidenceKind: 'document_approval',
    requiredFromStage: 'stage_1_staff_canary',
    criterion:
      'The eleven-point review in docs/analytics.md plus this domain’s inventory and schedule, ' +
      'recorded. It is also what unblocks ANALYTICS_COLLECTION_MODE moving off `off`.',
  },
  {
    gate: 'stripe_architecture_production_ready',
    title: 'Core Stripe architecture and the guest path production-ready',
    discipline: 'engineering',
    evidenceKind: 'automated_check',
    requiredFromStage: 'stage_1_staff_canary',
    criterion: 'STRIPE_ENABLED is true with a key and BOTH webhook secrets configured.',
  },
  {
    gate: 'webhooks_reconciliation_runbooks_operational',
    title: 'Webhooks, reconciliation and runbooks operational',
    discipline: 'operations',
    evidenceKind: 'operational_verification',
    requiredFromStage: 'stage_1_staff_canary',
    criterion:
      'Both webhook endpoints receive verified deliveries, the four reconciliation sweeps run, ' +
      'and PAYMENT_OPERATOR_OXY_USER_IDS is non-empty so a person can drive a repair.',
  },
  {
    gate: 'transactional_sender_authenticated',
    title: 'Transactional sender authenticated and monitored',
    discipline: 'operations',
    evidenceKind: 'external_dependency',
    requiredFromStage: 'stage_1_staff_canary',
    criterion:
      'A registered outbound mail transport with an authenticated sending domain. Mercaria has ' +
      'NONE: #108’s registry is empty and every attempt fails transport_unconfigured, visibly.',
    blockedBy: 'no outbound email transport exists in this repository (#108)',
  },
  {
    gate: 'merchant_readiness_includes_guest',
    title: 'Merchant readiness explicitly includes guest checkout',
    discipline: 'operations',
    // `external_dependency` until #85 landed, because no activation state
    // existed for a gate to read. It exists now, so what remains is an
    // OPERATIONAL act — telling pilot merchants, in writing, before the orders
    // arrive — which is a person's verification rather than a build somebody
    // owes. Leaving it `external_dependency` with no `blockedBy` would be a gate
    // claiming a dependency it can no longer name.
    evidenceKind: 'operational_verification',
    requiredFromStage: 'stage_2_pilot_merchants',
    criterion:
      'A merchant-facing statement that guest orders will arrive, and an activation state a gate ' +
      'can read. #85 SUPPLIED the second half: `GuestSellerActivation` has its `activated` ' +
      'member, the guest conjunction is derived per seller, and the merchant reads it at ' +
      '/admin/stores/:storeId/activation. What remains is the OPERATIONAL half this gate is ' +
      'about — telling pilot merchants, in writing, before the orders arrive.',
  },
  {
    gate: 'support_runbooks_staffed',
    title: 'Support runbooks written and escalation staffed',
    discipline: 'support',
    evidenceKind: 'operational_verification',
    requiredFromStage: 'stage_1_staff_canary',
    criterion: 'Every security signal’s runbook exists and names a next action and an owner.',
  },
  {
    gate: 'backup_and_restore_validated',
    title: 'Backup and restore validated for the guest tables',
    discipline: 'operations',
    evidenceKind: 'operational_verification',
    requiredFromStage: 'stage_1_staff_canary',
    criterion:
      'A restore rehearsal that brings back the guest tables and confirms a portal credential ' +
      'issued before the snapshot still resolves after it.',
  },
  {
    gate: 'dashboard_metrics_and_alerts_live',
    title: 'Dashboard metrics and alerts live',
    discipline: 'operations',
    evidenceKind: 'automated_check',
    requiredFromStage: 'stage_2_pilot_merchants',
    criterion:
      'Every guest metric computes a number rather than a seam, and every critical security ' +
      'signal has a scrape and an alert wired in oxy-infra.',
  },
  {
    gate: 'feature_flags_and_kill_switches_tested',
    title: 'Feature flags and kill switches tested',
    discipline: 'engineering',
    evidenceKind: 'automated_check',
    requiredFromStage: 'stage_1_staff_canary',
    criterion:
      'The rollback suite passes: with every guest lever off, a placed guest order is still ' +
      'readable, refundable, reconcilable and swept.',
  },
  {
    gate: 'no_unresolved_critical_findings',
    title: 'No unresolved critical or high findings',
    discipline: 'security',
    evidenceKind: 'document_approval',
    requiredFromStage: 'stage_2_pilot_merchants',
    criterion: 'The guest threat model and the ADR 0006 review have no open critical or high item.',
  },
  {
    gate: 'payment_to_portal_tested_under_failure',
    title: 'Payment success to portal initialization tested under failure',
    discipline: 'engineering',
    evidenceKind: 'automated_check',
    requiredFromStage: 'stage_1_staff_canary',
    criterion:
      'End-to-end tests cover session expiry between paying and returning, an app restart, and a ' +
      'mail transport that refuses — with the buyer still reaching their order in every case.',
  },
];
