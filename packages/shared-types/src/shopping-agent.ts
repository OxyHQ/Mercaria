/**
 * Saved shopping-agent jobs — issue #97.
 *
 * A shopper saves a structured OBJECTIVE, Mercaria re-evaluates it when the
 * catalogue moves, and — when a deterministic evaluation says so — tells them
 * once. Nothing else. This file is where "nothing else" is made unrepresentable
 * rather than merely unimplemented.
 *
 * ## The four shapes this file refuses
 *
 * 1. **An agent that buys something.** {@link SHOPPING_AGENT_JOB_KINDS} (6) and
 *    {@link SHOPPING_AGENT_FORBIDDEN_ACTIONS} (16) are DISJOINT unions — the
 *    `RetailForbiddenComponentKind` device — and no type in this file has a
 *    field that could hold an order, a checkout group, a payment method, a card,
 *    a merchant message or a merchant's terms. There is no member of any
 *    vocabulary here that means "act", and no branch of any union that carries
 *    one. `shopping-agent-isolation.test.ts` keeps the wall standing for modules
 *    nobody has written yet.
 * 2. **A finding a model produced.** A language model may SUMMARISE a finding
 *    that is already stored and may do nothing else (#97 evaluation 5).
 *    {@link ShoppingAgentSummaryDraft} carries sentences and record REFERENCES
 *    and has no field for a price, a product, an offer or a verdict; every
 *    sentence must cite refs the finding itself minted, and every number in it
 *    must already appear in the finding. #96's explanation validator is the
 *    precedent and the reasoning is quoted rather than rediscovered.
 * 3. **A positive finding built on missing data.**
 *    {@link ShoppingAgentFindingOutcome} is THREE-valued and only `qualified`
 *    may carry an objective value or produce a notification — a CHECK on the row
 *    and a trigger on the notification table, not a rule somebody follows. #97
 *    evaluation 6 and acceptance 5.
 * 4. **The same good news twice.** {@link shoppingAgentEvaluationKey} names four
 *    facts and NO CLOCK: the agent, its revision, the deterministic INPUT
 *    DIGEST (#96's `BasketInputSnapshot.digest`, a hash over every candidate,
 *    price and rate the solver read) and the agent policy version. #79 records
 *    this as its hardest-won rule — a key without the observed input version
 *    fires once and never again; a key with a timestamp fires on every sweep —
 *    and #96's snapshot digest is the same fact one layer up.
 *
 * ## What an agent deliberately cannot say
 *
 * {@link SHOPPING_AGENT_FORBIDDEN_SCOPES} names the scopes that may never become
 * agent fields, disjoint from every vocabulary here. The two that matter: an
 * agent cannot be scoped to a seller's plan or commission, because that would
 * let a paid placement decide whose price a shopper hears about; and an agent
 * cannot carry a contact address, because Mercaria's transactional channel is
 * Oxy's own notifications and it stores no address for an Oxy account.
 */

import type { ConditionGroup } from './condition';
import type { CurrencyCode, Money } from './money';
import type { ConstraintSet } from './constraint';

/* ────────────────────────────────────────────────────────────────────────── */
/* What an agent may be, and what it may never become                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The six launch jobs (#97 §"Supported launch jobs").
 *
 * Every one of them is a NOTIFICATION about a deterministic observation, and
 * that is not a coincidence about this list — it is the whole of what the
 * vocabulary can express. There is no seventh member shaped like an action and
 * no parameter on any of these that could become one.
 */
export type ShoppingAgentJobKind =
  /** 1. A current eligible offer satisfies a product or price constraint. */
  | 'offer_price_threshold'
  /** 2. A matching used or refurbished item appears. */
  | 'used_or_refurbished_appearance'
  /** 3. The product becomes available from a verified official channel. */
  | 'official_channel_availability'
  /** 4. A complete basket falls below a target known total. */
  | 'basket_target_total'
  /** 5. A materially better plan exists under the saved objective. */
  | 'materially_better_plan'
  /** 6. A previously impossible hard-constraint search gains a valid result. */
  | 'constraint_satisfiable';

export const SHOPPING_AGENT_JOB_KINDS: readonly ShoppingAgentJobKind[] = [
  'offer_price_threshold',
  'used_or_refurbished_appearance',
  'official_channel_availability',
  'basket_target_total',
  'materially_better_plan',
  'constraint_satisfiable',
];

/**
 * What a saved agent may NEVER do (#97 §"Supported launch jobs", final line,
 * and acceptance 9).
 *
 * DISJOINT from {@link SHOPPING_AGENT_JOB_KINDS} by a test, and that
 * disjointness is the point: a future member that reads as an action has to be
 * added to a list whose whole purpose is to say it may not exist, in a diff
 * somebody reviews. The list is longer than the issue's five words because the
 * five words each have several spellings, and a prohibition nobody can match
 * against is a prohibition nobody enforces.
 *
 * These are VALUES rather than comments so the isolation gate can scan for them
 * and so a refusal can name the exact one it found instead of saying
 * "unrecognized key" — the `RetailForbiddenComponentKind` refusal, one domain
 * over.
 */
export type ShoppingAgentForbiddenAction =
  | 'purchase_item'
  | 'place_order'
  | 'complete_checkout'
  | 'add_to_cart_automatically'
  | 'authorize_payment'
  | 'create_payment_method'
  | 'store_card_credential'
  | 'reserve_inventory'
  | 'message_merchant'
  | 'contact_seller'
  | 'negotiate_price'
  | 'place_bid'
  | 'accept_merchant_terms'
  | 'accept_supplier_agreement'
  | 'change_seller_price'
  | 'apply_discount_code';

export const SHOPPING_AGENT_FORBIDDEN_ACTIONS: readonly ShoppingAgentForbiddenAction[] = [
  'purchase_item',
  'place_order',
  'complete_checkout',
  'add_to_cart_automatically',
  'authorize_payment',
  'create_payment_method',
  'store_card_credential',
  'reserve_inventory',
  'message_merchant',
  'contact_seller',
  'negotiate_price',
  'place_bid',
  'accept_merchant_terms',
  'accept_supplier_agreement',
  'change_seller_price',
  'apply_discount_code',
];

/**
 * Scopes an agent may never be narrowed by (#97 privacy 4, and #79's list one
 * domain over).
 *
 * The commercial half keeps a paid placement out of what a shopper is told
 * about; the identity half keeps a contact handle out of a catalogue table.
 * Both are scanned for by the isolation gate and neither has a column anywhere
 * in the domain.
 */
export type ShoppingAgentForbiddenScope =
  | 'sponsored_only'
  | 'highest_commission'
  | 'merchant_plan_tier'
  | 'promoted_placement'
  | 'fee_schedule_key'
  | 'referral_partner'
  | 'affiliate_network_payout'
  | 'buyer_email'
  | 'buyer_phone'
  | 'payment_method'
  | 'card_fingerprint'
  | 'precise_location';

export const SHOPPING_AGENT_FORBIDDEN_SCOPES: readonly ShoppingAgentForbiddenScope[] = [
  'sponsored_only',
  'highest_commission',
  'merchant_plan_tier',
  'promoted_placement',
  'fee_schedule_key',
  'referral_partner',
  'affiliate_network_payout',
  'buyer_email',
  'buyer_phone',
  'payment_method',
  'card_fingerprint',
  'precise_location',
];

/* ────────────────────────────────────────────────────────────────────────── */
/* Lifecycle                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The agent's lifecycle (#97 model 9).
 *
 * `blocked` is what a catalogue SPLIT writes and is deliberately not `paused`:
 * a shopper pauses their own agent and can resume it, while a blocked agent is
 * waiting for a question only they can answer. Collapsing the two would make
 * "resume" an answer to an ambiguity nobody resolved.
 *
 * `completed` is the terminal success of a `once` agent — it fired, and there
 * is nothing more it was asked to watch for.
 */
export type ShoppingAgentState = 'enabled' | 'paused' | 'blocked' | 'completed' | 'deleted';

export const SHOPPING_AGENT_STATES: readonly ShoppingAgentState[] = [
  'enabled',
  'paused',
  'blocked',
  'completed',
  'deleted',
];

/** The only state an evaluation may run against. */
export const SHOPPING_AGENT_EVALUABLE_STATES: readonly ShoppingAgentState[] = ['enabled'];

/** What made an evaluation happen (#97 model 7). */
export type ShoppingAgentTriggerSource = 'offer_change' | 'scheduled' | 'manual';

export const SHOPPING_AGENT_TRIGGER_SOURCES: readonly ShoppingAgentTriggerSource[] = [
  'offer_change',
  'scheduled',
  'manual',
];

/**
 * Which cost an objective is measured against (#97 model 6).
 *
 * Named for #96's own `itemSubtotal` / `deliveredTotal` rather than invented,
 * because those are the two figures the solver actually produces — a third
 * spelling here would be a second answer to what a total is.
 */
export type ShoppingAgentPriceBasis = 'item_price' | 'delivered_total';

export const SHOPPING_AGENT_PRICE_BASES: readonly ShoppingAgentPriceBasis[] = [
  'item_price',
  'delivered_total',
];

/**
 * Which channels an agent's plans may draw on (#97 model 5).
 *
 * The same four members as #96's `BasketChannelPolicy`, because the value is
 * passed straight through to the solver. Two vocabularies for one parameter is
 * a translation layer, and a translation layer is where a shopper's
 * "only from here" quietly becomes "anywhere".
 */
export type ShoppingAgentChannelPolicy =
  | 'native_only'
  | 'external_only'
  | 'official_only'
  | 'mixed';

export const SHOPPING_AGENT_CHANNEL_POLICIES: readonly ShoppingAgentChannelPolicy[] = [
  'native_only',
  'external_only',
  'official_only',
  'mixed',
];

/** Whether a catalogue split left the agent pointing at two products. */
export type ShoppingAgentAmbiguityState = 'resolved' | 'ambiguous_after_split';

export const SHOPPING_AGENT_AMBIGUITY_STATES: readonly ShoppingAgentAmbiguityState[] = [
  'resolved',
  'ambiguous_after_split',
];

/** How a shopper answers a split (#97 evaluation 8). */
export type ShoppingAgentSplitResolution = 'keep_source' | 'move_to_target';

export const SHOPPING_AGENT_SPLIT_RESOLUTIONS: readonly ShoppingAgentSplitResolution[] = [
  'keep_source',
  'move_to_target',
];

/* ────────────────────────────────────────────────────────────────────────── */
/* Findings                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * What one evaluation concluded — THREE values, and the middle one is the one
 * people collapse.
 *
 * `qualified` is a positive observation and is the only one that may carry an
 * objective value or produce a notification. `not_qualified` means the
 * deterministic evaluation RAN over complete inputs and the condition does not
 * hold. `incomplete` means Mercaria could not tell — and reporting that as
 * `not_qualified` would tell a shopper their thing is not on sale when the
 * truth is that a delivery cost was never published.
 *
 * #82 reached the same three states for a price signal and the reasoning
 * transfers exactly.
 */
export type ShoppingAgentFindingOutcome = 'qualified' | 'not_qualified' | 'incomplete';

export const SHOPPING_AGENT_FINDING_OUTCOMES: readonly ShoppingAgentFindingOutcome[] = [
  'qualified',
  'not_qualified',
  'incomplete',
];

/**
 * Why an evaluation could not reach a verdict (#97 evaluation 6).
 *
 * Every member names a fact the evaluation READ or failed to read, never a
 * guess about why. A closed set, because these are what a shopper is shown and
 * what an operator counts.
 */
export type ShoppingAgentIncompleteReason =
  | 'offer_comparison_unavailable'
  | 'no_eligible_offer'
  | 'price_not_convertible'
  | 'delivery_cost_unknown'
  | 'basket_partially_covered'
  | 'constraint_set_invalid'
  | 'constraint_facts_unavailable'
  | 'agent_ambiguous_after_split'
  | 'no_comparable_prior_finding'
  | 'catalogue_discovery_unavailable';

export const SHOPPING_AGENT_INCOMPLETE_REASONS: readonly ShoppingAgentIncompleteReason[] = [
  'offer_comparison_unavailable',
  'no_eligible_offer',
  'price_not_convertible',
  'delivery_cost_unknown',
  'basket_partially_covered',
  'constraint_set_invalid',
  'constraint_facts_unavailable',
  'agent_ambiguous_after_split',
  'no_comparable_prior_finding',
  'catalogue_discovery_unavailable',
];

/**
 * How complete the evidence behind a finding is (#97 finding 8).
 *
 * SEPARATE from the outcome, because a `not_qualified` finding over complete
 * evidence and a `not_qualified` finding that was never reached are different
 * facts — and only the first one tells a shopper anything.
 */
export type ShoppingAgentEvidenceCompleteness = 'complete' | 'partial';

export const SHOPPING_AGENT_EVIDENCE_COMPLETENESS: readonly ShoppingAgentEvidenceCompleteness[] = [
  'complete',
  'partial',
];

/** How fresh the offers behind a finding were. #96's own three values. */
export type ShoppingAgentFreshness = 'current' | 'ageing' | 'unknown';

export const SHOPPING_AGENT_FRESHNESS: readonly ShoppingAgentFreshness[] = [
  'current',
  'ageing',
  'unknown',
];

/** Whether the solver PROVED the plan behind a finding optimal. #96's own. */
export type ShoppingAgentOptimality = 'proven_optimal' | 'approximate';

export const SHOPPING_AGENT_OPTIMALITIES: readonly ShoppingAgentOptimality[] = [
  'proven_optimal',
  'approximate',
];

/**
 * Why a stored finding no longer describes the world (#97 finding 12).
 *
 * A finding is never rewritten and never deleted to hide a mistake: a later
 * observation SUPERSEDES it, and a catalogue correction INVALIDATES it. #78's
 * superseding-record device, applied to an observation about a shopper's own
 * objective.
 */
export type ShoppingAgentFindingLifecycle = 'current' | 'superseded' | 'invalidated';

export const SHOPPING_AGENT_FINDING_LIFECYCLES: readonly ShoppingAgentFindingLifecycle[] = [
  'current',
  'superseded',
  'invalidated',
];

/* ────────────────────────────────────────────────────────────────────────── */
/* Notification                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

export type ShoppingAgentNotificationChannel = 'oxy_notification' | 'email';

export const SHOPPING_AGENT_NOTIFICATION_CHANNELS: readonly ShoppingAgentNotificationChannel[] = [
  'oxy_notification',
  'email',
];

export type ShoppingAgentNotificationState =
  | 'queued'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'suppressed'
  | 'dead_letter';

export const SHOPPING_AGENT_NOTIFICATION_STATES: readonly ShoppingAgentNotificationState[] = [
  'queued',
  'delivering',
  'delivered',
  'failed',
  'suppressed',
  'dead_letter',
];

/**
 * Why a notification was WITHHELD (#97 notification 1, 2; operations 6).
 *
 * Every one of these leaves a ROW rather than a silent skip, because "how many
 * did we withhold" is exactly the duplicate-suppression figure #97 cost rule 6
 * asks to be monitored, and a table of messages that were sent can never answer
 * it. #79's decision, quoted.
 */
export type ShoppingAgentSuppressionReason =
  | 'cooldown_active'
  | 'not_materially_better'
  | 'agent_not_enabled'
  | 'agent_deleted'
  | 'finding_superseded'
  | 'destination_no_longer_eligible'
  | 'channel_unavailable';

export const SHOPPING_AGENT_SUPPRESSION_REASONS: readonly ShoppingAgentSuppressionReason[] = [
  'cooldown_active',
  'not_materially_better',
  'agent_not_enabled',
  'agent_deleted',
  'finding_superseded',
  'destination_no_longer_eligible',
  'channel_unavailable',
];

export type ShoppingAgentDeliveryFailure =
  | 'transport_unconfigured'
  | 'transport_rejected'
  | 'transport_unavailable'
  | 'finding_unreadable'
  | 'unexpected_error';

export const SHOPPING_AGENT_DELIVERY_FAILURES: readonly ShoppingAgentDeliveryFailure[] = [
  'transport_unconfigured',
  'transport_rejected',
  'transport_unavailable',
  'finding_unreadable',
  'unexpected_error',
];

/**
 * Fields a notification payload may never carry (#97 notification 6, privacy 3).
 *
 * Walked at RUNTIME against a real emitted payload, not only scanned — #92's
 * two-gate rule. `destinationUrl` is the one to read: #97 notification 6 asks
 * that a notification link to a CURRENT Mercaria result page and never to an
 * unvalidated external URL, and the way that goes wrong is a helpful someone
 * copying the offer's `destination_url` into the payload.
 */
export const SHOPPING_AGENT_FORBIDDEN_NOTIFICATION_FIELDS: readonly string[] = [
  'destinationUrl',
  'affiliateUrl',
  'trackingTemplate',
  'affiliateNetwork',
  'buyerEmail',
  'email',
  'emailHash',
  'phone',
  'guestSessionId',
  'pushToken',
  'oxyUserId',
  'note',
  'description',
];

/* ────────────────────────────────────────────────────────────────────────── */
/* Audit                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/** Every act #97 privacy 7 requires a record of. */
export type ShoppingAgentAuditAction =
  | 'created'
  | 'authorization_recorded'
  | 'constraints_edited'
  | 'scope_edited'
  | 'policy_edited'
  | 'paused'
  | 'resumed'
  | 'completed'
  | 'deleted'
  | 'manual_run_requested'
  | 'blocked_by_split'
  | 'split_resolved'
  | 'rehomed_by_merge'
  | 'migrated_by_policy_upgrade';

export const SHOPPING_AGENT_AUDIT_ACTIONS: readonly ShoppingAgentAuditAction[] = [
  'created',
  'authorization_recorded',
  'constraints_edited',
  'scope_edited',
  'policy_edited',
  'paused',
  'resumed',
  'completed',
  'deleted',
  'manual_run_requested',
  'blocked_by_split',
  'split_resolved',
  'rehomed_by_merge',
  'migrated_by_policy_upgrade',
];

/** Who performed an audited act. There is no third actor kind and none may be added. */
export type ShoppingAgentAuditActor = 'owner' | 'system';

export const SHOPPING_AGENT_AUDIT_ACTORS: readonly ShoppingAgentAuditActor[] = ['owner', 'system'];

/* ────────────────────────────────────────────────────────────────────────── */
/* Versions and bounds                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The version of what "qualifies" MEANS.
 *
 * Part of the evaluation key, so a change to the rules is a genuinely new
 * question and a shopper is entitled to one answer to it. A code constant and
 * not a table, for `CATALOG_BACKFILL_MAPPING_VERSION`'s reason: the rules are a
 * procedure, and a table would let somebody publish a version whose rules
 * nobody shipped.
 */
export const SHOPPING_AGENT_POLICY_VERSION = '2026-08-16.1';

/**
 * The terms a shopper accepts when they save an agent (#97 model 12,
 * privacy 1).
 *
 * This is MERCARIA's own agent terms and is not, and can never become, a
 * MERCHANT's terms — `accept_merchant_terms` and `accept_supplier_agreement`
 * are both forbidden actions above. The distinction matters because the two
 * would otherwise share a column name.
 */
export const SHOPPING_AGENT_TERMS_VERSION = 'agent-terms-2026-08-v1';

/** The schema a generated summary is validated against (#97 finding 10). */
export const SHOPPING_AGENT_SUMMARY_SCHEMA_VERSION = 'as-1';

/**
 * How many lines one agent may watch (#97 cost 9).
 *
 * Lower than #96's `MAX_BASKET_LINES` of 40, deliberately: a basket is solved
 * once when somebody is looking at it, and an agent is solved every time the
 * catalogue moves under any of its lines.
 */
export const MAX_SHOPPING_AGENT_LINES = 20;

/** How many offers each line's ranked read asks for. */
export const SHOPPING_AGENT_OFFERS_PER_LINE = 25;

export const MAX_SHOPPING_AGENT_NAME_CHARS = 120;
export const MAX_SHOPPING_AGENT_DESCRIPTION_CHARS = 500;

/**
 * How much better a plan must be before it is worth saying so, in basis points.
 *
 * #79 uses the same figure for `cooldown_better_low` and the reason is the
 * same: below it, a notification is noise a shopper learns to ignore, and the
 * agent that cried wolf is the one that is not read when it matters.
 */
export const SHOPPING_AGENT_MATERIAL_IMPROVEMENT_BPS = 100;

/** Bounds on a generated summary. #96's, because it is the same kind of text. */
export const MAX_SHOPPING_AGENT_SUMMARY_SENTENCES = 4;
export const MAX_SHOPPING_AGENT_SUMMARY_SENTENCE_CHARS = 280;

/* ────────────────────────────────────────────────────────────────────────── */
/* The agent itself                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * One thing the agent watches.
 *
 * Shaped to #96's `BasketRequestLine` and #81's `WatchlistItem` on purpose —
 * same product/variant/quantity/condition/merchant fields — so an agent becomes
 * a basket request with no translation layer that could reinterpret a
 * preference. A single-product agent has exactly one line with quantity one,
 * which is why there is no second shape for it.
 */
export interface ShoppingAgentLine {
  readonly id: string;
  readonly canonicalProductId: string;
  readonly canonicalVariantId?: string;
  readonly quantity: number;
  readonly conditionGroups: readonly ConditionGroup[];
  readonly merchantId?: string;
  readonly position: number;
}

/**
 * The versions an evaluation was performed under (#97 model 11).
 *
 * Every one is recorded on the AGENT (what it was saved under) and again on
 * each FINDING (what it was evaluated under), because those diverge the moment
 * a policy is published — and #97 acceptance 3 asks that a finding be
 * reproducible from the policy versions, which is a fact about the finding.
 */
export interface ShoppingAgentPolicyVersions {
  readonly agentPolicyVersion: string;
  readonly constraintEvaluationVersion: string;
  readonly normalizationRuleVersion: string;
  readonly comparisonPolicyVersion: string;
  /** Empty when no comparison ran — an agent evaluated with the offers lever off. */
  readonly rankingPolicyVersion: string;
  /** Present when the constraints came from a #95 interpretation. */
  readonly parserVersion?: string;
}

/**
 * The shopper's explicit authorization (#97 model 12, privacy 1).
 *
 * `constraintDigest` is the load-bearing member: it is a hash over the exact
 * constraint set the client RENDERED for confirmation, echoed back on the
 * write. A create or a material edit whose digest does not match what the
 * server computed is refused — so "explicit confirmation of the interpreted
 * constraints" is a comparison rather than a checkbox, and a client that
 * showed one thing and submitted another cannot succeed.
 */
export interface ShoppingAgentAuthorization {
  readonly authorizedAt: string;
  readonly termsVersion: string;
  readonly constraintDigest: string;
}

/** The saved objective. */
export interface ShoppingAgent {
  readonly id: string;
  readonly kind: ShoppingAgentJobKind;
  readonly name: string;
  readonly description?: string;
  readonly state: ShoppingAgentState;
  readonly revision: number;

  readonly displayCurrency: CurrencyCode;
  readonly priceBasis: ShoppingAgentPriceBasis;
  readonly channelPolicy: ShoppingAgentChannelPolicy;
  readonly market?: string;
  readonly conditionGroups: readonly ConditionGroup[];
  readonly excludedMerchantIds: readonly string[];
  /** Present for the two kinds that compare against a number. */
  readonly target?: Money;

  readonly lines: readonly ShoppingAgentLine[];
  /** The validated constraint set, re-validated on every evaluation. */
  readonly constraints: ConstraintSet;

  readonly triggerSources: readonly ShoppingAgentTriggerSource[];
  readonly notificationChannels: readonly ShoppingAgentNotificationChannel[];
  readonly cooldownSeconds: number;
  readonly quietHours?: ShoppingAgentQuietHours;

  readonly ambiguityState: ShoppingAgentAmbiguityState;
  readonly splitJobId?: string;
  readonly splitTargetCanonicalProductId?: string;
  readonly rehomedFromCanonicalProductId?: string;

  readonly authorization: ShoppingAgentAuthorization;
  readonly versions: ShoppingAgentPolicyVersions;

  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastEvaluatedAt?: string;
  readonly lastNotifiedAt?: string;
  readonly nextScheduledAt?: string;
}

/** Three facts or none — a window with no zone is a window in the server's night. */
export interface ShoppingAgentQuietHours {
  readonly startMinute: number;
  readonly endMinute: number;
  readonly timeZone: string;
}

export const SHOPPING_AGENT_MINUTES_PER_DAY = 1_440;

/* ────────────────────────────────────────────────────────────────────────── */
/* The finding                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * One appended observation about one agent (#97 §"AgentFinding model").
 *
 * Findings are APPEND-ONLY observations. A correction supersedes rather than
 * mutating history silently, which is the issue's own sentence and is enforced
 * by a trigger rather than by a repository somebody could route around.
 */
export interface ShoppingAgentFinding {
  readonly id: string;
  readonly agentId: string;
  /** The four facts and no clock. See {@link shoppingAgentEvaluationKey}. */
  readonly evaluationKey: string;
  readonly triggerSource: ShoppingAgentTriggerSource;
  readonly triggeredAt: string;
  readonly evaluatedAt: string;

  readonly outcome: ShoppingAgentFindingOutcome;
  readonly incompleteReasons: readonly ShoppingAgentIncompleteReason[];
  readonly completeness: ShoppingAgentEvidenceCompleteness;
  readonly freshness: ShoppingAgentFreshness;
  readonly optimality?: ShoppingAgentOptimality;
  readonly lifecycle: ShoppingAgentFindingLifecycle;

  /** #96's input digest — the version of everything the solver read. */
  readonly inputDigest: string;
  readonly versions: ShoppingAgentPolicyVersions;

  readonly satisfiedConstraintIds: readonly string[];
  readonly failedConstraintIds: readonly string[];
  readonly unknownConstraintIds: readonly string[];

  /** Present only on a `qualified` finding. A CHECK, not a convention. */
  readonly objectiveValue?: Money;
  /**
   * The move against the prior comparable finding, in the same currency.
   *
   * Negative is cheaper. Absent when there is no prior comparable finding,
   * which is a different statement from "it did not move".
   */
  readonly objectiveDelta?: Money;

  /** #96's grounding refs. Every citation a summary makes resolves here. */
  readonly records: readonly ShoppingAgentRecordRef[];
  readonly selection: readonly ShoppingAgentSelectedLine[];

  readonly summary?: ShoppingAgentSummary;
  readonly notifications: readonly ShoppingAgentNotificationView[];
}

/** A grounding reference. #96's `ComparisonRecordRef`, carried through verbatim. */
export interface ShoppingAgentRecordRef {
  readonly ref: string;
  readonly kind: string;
  readonly recordId: string;
  readonly canonicalPath?: string;
  readonly label?: string;
}

/** What the plan behind a finding selected, per line. */
export interface ShoppingAgentSelectedLine {
  readonly lineId: string;
  readonly canonicalProductId: string;
  readonly offerRef: string;
  readonly quantity: number;
  readonly unitItemPrice?: Money;
  readonly conditionGroup?: ConditionGroup;
  /** #97 notification 4 — native purchase and external navigation differ. */
  readonly nativeCheckoutEligible: boolean;
  readonly officialChannel: boolean;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The generated summary — what a model may and may not produce               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * One sentence a provider drafted, and the refs it cites.
 *
 * There is no field for a price, a product, an offer, a merchant or a verdict —
 * a provider cannot ASSERT anything, it can only phrase what the finding
 * already says and point at the records the finding already minted. #95's
 * `INTENT_CANDIDATE_ELEMENTS` device: the absence of a field is the guarantee.
 */
export interface ShoppingAgentSummarySentence {
  readonly text: string;
  readonly recordRefs: readonly string[];
}

export interface ShoppingAgentSummaryDraft {
  readonly sentences: readonly ShoppingAgentSummarySentence[];
}

/** Why a draft was refused. Every rejection is recorded; none is fatal. */
export type ShoppingAgentSummaryRejection =
  | 'provider_unavailable'
  | 'provider_error'
  | 'empty_draft'
  | 'too_many_sentences'
  | 'sentence_too_long'
  | 'unknown_record_ref'
  | 'uncited_sentence'
  | 'unsupported_number'
  | 'forbidden_action_language';

export const SHOPPING_AGENT_SUMMARY_REJECTIONS: readonly ShoppingAgentSummaryRejection[] = [
  'provider_unavailable',
  'provider_error',
  'empty_draft',
  'too_many_sentences',
  'sentence_too_long',
  'unknown_record_ref',
  'uncited_sentence',
  'unsupported_number',
  'forbidden_action_language',
];

/**
 * The summary a finding carries, or the honest statement that it has none.
 *
 * A STRING discriminant (`source`), because the backend compiles with
 * `strict: false` and a boolean-literal discriminant does not narrow there —
 * the finding #68 recorded and #110 hit again.
 */
export type ShoppingAgentSummary =
  | {
      readonly source: 'deterministic_template';
      readonly sentences: readonly ShoppingAgentSummarySentence[];
      /** Present when a provider answered and its draft was refused. */
      readonly rejections: readonly ShoppingAgentSummaryRejection[];
    }
  | {
      readonly source: 'provider';
      readonly sentences: readonly ShoppingAgentSummarySentence[];
      readonly providerId: string;
      readonly promptVersion: string;
      readonly schemaVersion: string;
    };

/* ────────────────────────────────────────────────────────────────────────── */
/* Notification payload                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * What a notification actually carries.
 *
 * Every member is a Mercaria id or a bounded code. There is no URL of any kind
 * (#97 notification 6), no product NAME (a stale name in a push payload is the
 * field that goes wrong silently — #79's finding) and nothing a shopper wrote.
 * The list of what may never appear is
 * {@link SHOPPING_AGENT_FORBIDDEN_NOTIFICATION_FIELDS}, walked at runtime.
 */
export interface ShoppingAgentNotificationPayload {
  readonly agentId: string;
  readonly findingId: string;
  readonly kind: ShoppingAgentJobKind;
  readonly outcome: ShoppingAgentFindingOutcome;
  readonly priceBasis: ShoppingAgentPriceBasis;
  readonly objectiveAmountMinor?: number;
  readonly objectiveCurrency?: CurrencyCode;
  readonly objectiveDeltaMinor?: number;
  readonly canonicalProductIds: readonly string[];
  readonly lineCount: number;
  readonly nativeCheckoutAvailable: boolean;
  readonly officialChannel: boolean;
  readonly freshness: ShoppingAgentFreshness;
  readonly completeness: ShoppingAgentEvidenceCompleteness;
  readonly agentPolicyVersion: string;
}

/** What a client is shown about one delivery. */
export interface ShoppingAgentNotificationView {
  readonly id: string;
  readonly channel: ShoppingAgentNotificationChannel;
  readonly state: ShoppingAgentNotificationState;
  readonly suppressionReason?: ShoppingAgentSuppressionReason;
  readonly failureReason?: ShoppingAgentDeliveryFailure;
  readonly deliveredAt?: string;
  readonly openedAt?: string;
  readonly createdAt: string;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure functions every consumer shares                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The evaluation key — FOUR facts and NO CLOCK.
 *
 * - `agentId` — two shoppers watching one thing are two findings.
 * - `agentRevision` — an edit is a new question, and an answer to the old one
 *   must not silence it.
 * - `inputDigest` — #96's `BasketInputSnapshot.digest`, a hash over the request,
 *   the policy versions, every candidate offer with its price and every rate the
 *   solver read. This is #79's `observed_price_version` one layer up: without it
 *   a repeated evaluation of an unchanged catalogue has no way to recognise
 *   itself, and with a TIMESTAMP instead every sweep would be a new identity.
 * - `policyVersion` — a change to what "qualifies" means is a new question.
 *
 * A repeated source event therefore converges on ONE evaluation key
 * (#97 evaluation 2), and the database's `ON CONFLICT DO NOTHING … RETURNING`
 * is what detects it — a read-then-write lets two workers both see "no".
 */
export function shoppingAgentEvaluationKey(input: {
  readonly agentId: string;
  readonly agentRevision: number;
  readonly inputDigest: string;
  readonly policyVersion: string;
}): string {
  return [input.agentId, String(input.agentRevision), input.inputDigest, input.policyVersion].join(
    '|',
  );
}

/**
 * Whether a qualifying finding is worth telling the shopper about
 * (#97 notification 1, 2).
 *
 * TWO independent halves, and either alone is what the rule prevents: the
 * cooldown must have elapsed AND — when there is a previous notified value —
 * the new one must be materially better. A cooldown alone re-announces the same
 * price every day; a material-improvement rule alone announces every
 * one-minor-unit move the instant it happens.
 *
 * Returns a string discriminant rather than a boolean so the caller can RECORD
 * which half withheld it, which is what makes duplicate suppression countable.
 */
export function shoppingAgentNotificationDecision(input: {
  readonly cooldownSeconds: number;
  readonly lastNotifiedAt?: Date;
  readonly lastNotifiedAmountMinor?: number;
  readonly candidateAmountMinor?: number;
  readonly now: Date;
}):
  | { readonly decision: 'notify' }
  | { readonly decision: 'withhold'; readonly reason: ShoppingAgentSuppressionReason } {
  if (input.lastNotifiedAt === undefined) return { decision: 'notify' };

  const elapsedMs = input.now.getTime() - input.lastNotifiedAt.getTime();
  if (elapsedMs < input.cooldownSeconds * 1_000) {
    return { decision: 'withhold', reason: 'cooldown_active' };
  }

  const previous = input.lastNotifiedAmountMinor;
  const candidate = input.candidateAmountMinor;
  // No comparable amount on either side — a qualifying observation that carries
  // no number (an official channel appearing, say) has nothing to be "better"
  // than, so the cooldown is the whole of the policy.
  if (previous === undefined || candidate === undefined) return { decision: 'notify' };

  if (candidate > shoppingAgentMaterialImprovementCeiling(previous)) {
    return { decision: 'withhold', reason: 'not_materially_better' };
  }
  return { decision: 'notify' };
}

/**
 * The highest amount that still counts as materially better than `previousMinor`.
 *
 * Floored at one minor unit, so a very cheap thing can still improve: at a
 * previous price of fifty minor units a pure percentage would require an
 * improvement of half a unit, which no integer amount can be.
 */
export function shoppingAgentMaterialImprovementCeiling(previousMinor: number): number {
  const proportional = Math.floor(
    (previousMinor * (10_000 - SHOPPING_AGENT_MATERIAL_IMPROVEMENT_BPS)) / 10_000,
  );
  return Math.min(proportional, previousMinor - 1);
}

/** Whether `at` falls inside the agent's quiet window, in the owner's own zone. */
export function withinShoppingAgentQuietHours(
  quietHours: ShoppingAgentQuietHours,
  at: Date,
): boolean {
  const minute = localMinuteOfDay(quietHours.timeZone, at);
  if (minute === undefined) return false;
  const { startMinute, endMinute } = quietHours;
  if (startMinute === endMinute) return false;
  if (startMinute < endMinute) return minute >= startMinute && minute < endMinute;
  // A window that crosses midnight is two ranges, and reading it as one is how
  // "22:00 to 07:00" becomes "never".
  return minute >= startMinute || minute < endMinute;
}

/** The first instant after `at` that is outside the quiet window. */
export function shoppingAgentQuietHoursReleaseAt(
  quietHours: ShoppingAgentQuietHours,
  at: Date,
): Date {
  const minute = localMinuteOfDay(quietHours.timeZone, at);
  if (minute === undefined) return at;
  const target = quietHours.endMinute;
  const deltaMinutes =
    target > minute ? target - minute : SHOPPING_AGENT_MINUTES_PER_DAY - minute + target;
  return new Date(at.getTime() + deltaMinutes * 60_000);
}

/** Whether the runtime can resolve this IANA zone at all. */
export function isSupportedShoppingAgentTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function localMinuteOfDay(timeZone: string, at: Date): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return undefined;
    return hour * 60 + minute;
  } catch {
    return undefined;
  }
}
