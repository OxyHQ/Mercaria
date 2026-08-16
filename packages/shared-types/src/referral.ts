/**
 * Referral-domain vocabulary — programs, partners, instruments, touches,
 * attributions and conversions (#142, under ADR 0005).
 *
 * Every closed value set the referral domain uses is declared HERE, once, as a
 * `readonly` tuple plus the union derived from it — the `PAYMENT_PROVIDER_IDS`
 * pattern. The Postgres CHECK constraints, the drizzle column types and the
 * service-level guards all read these same tuples, so a value that exists in
 * one place exists in all of them.
 *
 * ## What this file deliberately does NOT declare
 *
 * `REFERRAL_FUNDING_SOURCE_IDS` (ADR 0005, "The funding boundary") belongs to
 * the issue that ships reward rows (#144/#145): a source id is added only
 * together with the code that can realize its base and the migration widening
 * the CHECK, never in advance. Nothing in #142 books a reward, so nothing in
 * #142 may name a funding source.
 *
 * Affiliate redirects (#67) are a SEPARATE system: none of these types
 * describes an affiliate click, and no affiliate record may be projected into
 * them. A touch is one of exactly three first-party kinds (ADR 0005 D4) — an
 * external network's click is not one of them, structurally.
 */

/**
 * The two launch program families (ADR 0005 D1).
 *
 * A closed set, and deliberately a SHORT one: affiliate-traffic and
 * subscription-revenue families are NOT listed because nothing can realize
 * their bases yet (#67/#89) — the same "no id before the code that can produce
 * a row for it" rule `PAYMENT_PROVIDER_IDS` documents.
 */
export type ReferralProgramFamily = 'buyer_referral' | 'merchant_referral';

/** {@link ReferralProgramFamily} as the tuple the column types and CHECKs read. */
export const REFERRAL_PROGRAM_FAMILIES: readonly ReferralProgramFamily[] = [
  'buyer_referral',
  'merchant_referral',
];

/**
 * A program VERSION's lifecycle.
 *
 * `ended` is what happens to the previously-active version when a new one is
 * published (or when its own effective end passes); `retired` is the terminal
 * business decision that blocks NEW attribution for the whole program while
 * historical settlement continues (issue #142 rule 7, ADR 0005 D18).
 */
export type ReferralProgramStatus =
  | 'draft'
  | 'scheduled'
  | 'active'
  | 'paused'
  | 'ended'
  | 'retired';

/** {@link ReferralProgramStatus} as a tuple. */
export const REFERRAL_PROGRAM_STATUSES: readonly ReferralProgramStatus[] = [
  'draft',
  'scheduled',
  'active',
  'paused',
  'ended',
  'retired',
];

/**
 * Who a partner record belongs to (ADR 0005 D2): an authenticated Oxy account
 * or a Mercaria store — ONE polymorphic pair, exactly the
 * `provider_accounts.owner_type` shape and for the same reason. Guests can
 * never be partners: a partner must be payable, and payable requires a durable
 * authenticated identity.
 */
export type ReferralPartnerOwnerType = 'user' | 'store';

/** {@link ReferralPartnerOwnerType} as a tuple. */
export const REFERRAL_PARTNER_OWNER_TYPES: readonly ReferralPartnerOwnerType[] = [
  'user',
  'store',
];

/**
 * A partner's enrollment state. `suspended` stops NEW attribution while valid
 * historical commissions continue according to policy (issue #142); the
 * attribution service is where that split is enforced.
 */
export type ReferralPartnerState =
  | 'applied'
  | 'invited'
  | 'approved'
  | 'suspended'
  | 'terminated';

/** {@link ReferralPartnerState} as a tuple. */
export const REFERRAL_PARTNER_STATES: readonly ReferralPartnerState[] = [
  'applied',
  'invited',
  'approved',
  'suspended',
  'terminated',
];

/**
 * A readiness SUMMARY imported from #146's onboarding/tax/payout machinery —
 * a reference projection, never an implementation. #146 owns how each verdict
 * is derived; this domain only records the coarse answer so partner surfaces
 * and payout gates can read one stored value (the `onboarding_state`
 * discipline: one verdict, nothing re-derives it here).
 */
export type ReferralReadinessSummary = 'unknown' | 'pending' | 'ready' | 'blocked';

/** {@link ReferralReadinessSummary} as a tuple. */
export const REFERRAL_READINESS_SUMMARIES: readonly ReferralReadinessSummary[] = [
  'unknown',
  'pending',
  'ready',
  'blocked',
];

/** A partner's fraud/review standing (ADR 0005 D17: signals freeze, identity voids). */
export type ReferralRiskState = 'none' | 'under_review' | 'cleared' | 'confirmed_fraud';

/** {@link ReferralRiskState} as a tuple. */
export const REFERRAL_RISK_STATES: readonly ReferralRiskState[] = [
  'none',
  'under_review',
  'cleared',
  'confirmed_fraud',
];

/** The state of a suspension/termination appeal. */
export type ReferralAppealState = 'none' | 'open' | 'accepted' | 'rejected';

/** {@link ReferralAppealState} as a tuple. */
export const REFERRAL_APPEAL_STATES: readonly ReferralAppealState[] = [
  'none',
  'open',
  'accepted',
  'rejected',
];

/** How a partner declares they will promote — bounded so it can never be free text. */
export type ReferralPromotionMethod =
  | 'website'
  | 'blog'
  | 'social_media'
  | 'email'
  | 'video'
  | 'podcast'
  | 'events'
  | 'other';

/** {@link ReferralPromotionMethod} as a tuple. */
export const REFERRAL_PROMOTION_METHODS: readonly ReferralPromotionMethod[] = [
  'website',
  'blog',
  'social_media',
  'email',
  'video',
  'podcast',
  'events',
  'other',
];

/**
 * An instrument's (code or link) lifecycle.
 *
 * `retired` keeps the row and its namespace reservation permanently (ADR 0005
 * D3): an attribution recorded against a code must stay explicable, and a
 * recycled code would let a new owner inherit another partner's history.
 */
export type ReferralInstrumentStatus = 'active' | 'paused' | 'expired' | 'revoked' | 'retired';

/** {@link ReferralInstrumentStatus} as a tuple. */
export const REFERRAL_INSTRUMENT_STATUSES: readonly ReferralInstrumentStatus[] = [
  'active',
  'paused',
  'expired',
  'revoked',
  'retired',
];

/**
 * The internal destinations a referral link may resolve to — a closed
 * ALLOW-LIST, which is what makes an open redirect unrepresentable rather than
 * merely rejected (issue #142: "No arbitrary destination URL"). The mapping
 * from a type + ref to a Mercaria route lives in ONE place
 * (`services/referrals/destinations.ts`); nothing stores a URL.
 */
export type ReferralDestinationType = 'home' | 'listing' | 'collection' | 'store';

/** {@link ReferralDestinationType} as a tuple. */
export const REFERRAL_DESTINATION_TYPES: readonly ReferralDestinationType[] = [
  'home',
  'listing',
  'collection',
  'store',
];

/**
 * The channels a program's instruments work in. Deliberately excludes
 * `external`: an order imported from a connected platform produces no
 * commission postings and can never qualify (ADR 0005 D11), so a channel value
 * for it would be a value nothing may honestly write.
 */
export type ReferralChannel = 'storefront' | 'pos';

/** {@link ReferralChannel} as a tuple. */
export const REFERRAL_CHANNELS: readonly ReferralChannel[] = ['storefront', 'pos'];

/**
 * The commercial modes a program may scope itself to. `retail` is
 * representable because ADR 0005's funding boundary explicitly admits a
 * `fixed_budget` bounty on a retail conversion — representable is not the same
 * as funded, and the funding decision belongs to #144/#145.
 */
export type ReferralCommercialMode = 'marketplace' | 'p2p' | 'retail';

/** {@link ReferralCommercialMode} as a tuple. */
export const REFERRAL_COMMERCIAL_MODES: readonly ReferralCommercialMode[] = [
  'marketplace',
  'p2p',
  'retail',
];

/**
 * The COMPLETE set of touch kinds (ADR 0005 D4): a click-id/link resolution, a
 * code entered in-app, a code entered at checkout. Nothing else — no
 * view-through, no impression attribution, and no affiliate click (#67 stays a
 * separate system).
 */
export type ReferralTouchKind = 'link_click' | 'code_entry_in_app' | 'code_entry_at_checkout';

/** {@link ReferralTouchKind} as a tuple. */
export const REFERRAL_TOUCH_KINDS: readonly ReferralTouchKind[] = [
  'link_click',
  'code_entry_in_app',
  'code_entry_at_checkout',
];

/** The client surface a touch was recorded on. */
export type ReferralClientSurface = 'web' | 'ios' | 'android' | 'pos' | 'other';

/** {@link ReferralClientSurface} as a tuple. */
export const REFERRAL_CLIENT_SURFACES: readonly ReferralClientSurface[] = [
  'web',
  'ios',
  'android',
  'pos',
  'other',
];

/**
 * Traffic classification for a touch. A non-`organic` touch is stored (so the
 * record explains what arrived) and is never attribution-eligible.
 */
export type ReferralTrafficClass = 'organic' | 'bot' | 'preview' | 'internal';

/** {@link ReferralTrafficClass} as a tuple. */
export const REFERRAL_TRAFFIC_CLASSES: readonly ReferralTrafficClass[] = [
  'organic',
  'bot',
  'preview',
  'internal',
];

/** The consent/tracking mode under which a touch was recorded. */
export type ReferralConsentMode = 'granted' | 'denied' | 'unknown';

/** {@link ReferralConsentMode} as a tuple. */
export const REFERRAL_CONSENT_MODES: readonly ReferralConsentMode[] = [
  'granted',
  'denied',
  'unknown',
];

/**
 * Who performed a touch (ADR 0005 A1/A2): a pseudonymous guest session or an
 * authenticated Oxy actor — the ONLY two identities attribution may see.
 * Email, card fingerprint, phone, IP and device fingerprint are structurally
 * absent from this union, which is what "not identity" means here.
 */
export type ReferralActorKind = 'guest_session' | 'oxy_user';

/** {@link ReferralActorKind} as a tuple. */
export const REFERRAL_ACTOR_KINDS: readonly ReferralActorKind[] = ['guest_session', 'oxy_user'];

/**
 * What kind of thing was referred (issue #142 §ReferralAttribution 4): an Oxy
 * user, a guest checkout scope, or a merchant candidate. The exact approved
 * reference for each kind is an OPAQUE id in the subject's own key space.
 */
export type ReferralSubjectKind = 'oxy_user' | 'guest_checkout' | 'merchant';

/** {@link ReferralSubjectKind} as a tuple. */
export const REFERRAL_SUBJECT_KINDS: readonly ReferralSubjectKind[] = [
  'oxy_user',
  'guest_checkout',
  'merchant',
];

/**
 * An attribution's state. Rows are immutable except for these transitions and
 * the pointer to the row that superseded/corrected them — amounts, evidence
 * and pinned versions never change (ADR 0005 D19).
 */
export type ReferralAttributionState =
  | 'active'
  | 'superseded'
  | 'conflicted'
  | 'invalidated'
  | 'corrected';

/** {@link ReferralAttributionState} as a tuple. */
export const REFERRAL_ATTRIBUTION_STATES: readonly ReferralAttributionState[] = [
  'active',
  'superseded',
  'conflicted',
  'invalidated',
  'corrected',
];

/**
 * The attribution policies a program version may pin. Exactly one exists (ADR
 * 0005 D4: last valid touch wins); the tuple is here so the column, the CHECK
 * and the resolver all read the same value, and so a second policy arrives as
 * a visible widening rather than a magic string.
 */
export type ReferralAttributionPolicy = 'last_touch';

/** {@link ReferralAttributionPolicy} as a tuple. */
export const REFERRAL_ATTRIBUTION_POLICIES: readonly ReferralAttributionPolicy[] = ['last_touch'];

/** Why an attribution left the `active` state — bounded, never free text. */
export type ReferralConflictReason =
  | 'competing_touch'
  | 'duplicate_subject'
  | 'self_referral'
  | 'partner_suspended'
  | 'program_retired'
  | 'operator_correction'
  | 'operator_invalidation'
  | 'other';

/** {@link ReferralConflictReason} as a tuple. */
export const REFERRAL_CONFLICT_REASONS: readonly ReferralConflictReason[] = [
  'competing_touch',
  'duplicate_subject',
  'self_referral',
  'partner_suspended',
  'program_retired',
  'operator_correction',
  'operator_invalidation',
  'other',
];

/**
 * The qualifying events a program version may name (ADR 0005 D11): the
 * referred buyer's first qualifying paid order, or merchant activation. Also
 * the conversion TYPE vocabulary — the two are one set by construction.
 */
export type ReferralConversionType = 'first_qualifying_paid_order' | 'merchant_activation';

/** {@link ReferralConversionType} as a tuple. */
export const REFERRAL_CONVERSION_TYPES: readonly ReferralConversionType[] = [
  'first_qualifying_paid_order',
  'merchant_activation',
];

/**
 * The durable source aggregates a conversion may be derived from (issue #142
 * §ReferralConversion 4). `subscription` and `affiliate_commission` are named
 * so the vocabulary does not need a breaking widen when #89/#67 ship — but no
 * launch code path produces them, and the conversion service refuses to invent
 * one.
 */
export type ReferralConversionSource =
  | 'order'
  | 'merchant_activation'
  | 'subscription'
  | 'affiliate_commission';

/** {@link ReferralConversionSource} as a tuple. */
export const REFERRAL_CONVERSION_SOURCES: readonly ReferralConversionSource[] = [
  'order',
  'merchant_activation',
  'subscription',
  'affiliate_commission',
];

/** A conversion's verification state. Never client-created: only durable source events move it. */
export type ReferralConversionState =
  | 'eligible'
  | 'pending'
  | 'rejected'
  | 'reversed'
  | 'corrected';

/** {@link ReferralConversionState} as a tuple. */
export const REFERRAL_CONVERSION_STATES: readonly ReferralConversionState[] = [
  'eligible',
  'pending',
  'rejected',
  'reversed',
  'corrected',
];

/**
 * Why a conversion was refused, rejected or reversed — bounded reason codes
 * (issue #142 §ReferralConversion 8). `zero_base`, `budget_exhausted` and
 * `cap_reached` are ADR 0005 D16's named refusals: an effect that did not
 * happen must be distinguishable from one that silently vanished.
 */
export type ReferralConversionReasonCode =
  | 'zero_base'
  | 'budget_exhausted'
  | 'cap_reached'
  | 'self_referral'
  | 'seller_own_order'
  | 'partner_suspended'
  | 'program_retired'
  | 'attribution_expired'
  | 'refund_reversed'
  | 'fraud_invalidated'
  | 'other';

/** {@link ReferralConversionReasonCode} as a tuple. */
export const REFERRAL_CONVERSION_REASON_CODES: readonly ReferralConversionReasonCode[] = [
  'zero_base',
  'budget_exhausted',
  'cap_reached',
  'self_referral',
  'seller_own_order',
  'partner_suspended',
  'program_retired',
  'attribution_expired',
  'refund_reversed',
  'fraud_invalidated',
  'other',
];

/** What kind of record a referral audit event is about. */
export type ReferralEventSubjectType =
  | 'program'
  | 'partner'
  | 'code'
  | 'link'
  | 'attribution'
  | 'conversion'
  | 'reward_rule'
  | 'reward'
  | 'payout_batch';

/** {@link ReferralEventSubjectType} as a tuple. */
export const REFERRAL_EVENT_SUBJECT_TYPES: readonly ReferralEventSubjectType[] = [
  'program',
  'partner',
  'code',
  'link',
  'attribution',
  'conversion',
  // #144's two subjects. Added to the SAME trail rather than given one of their
  // own: "what happened to this referral" is one question, and an operator
  // answering it should not have to know which table the answer lives beside.
  'reward_rule',
  'reward',
  // #145's one subject. A payout batch is a record an operator traces and an
  // actor approves, retries and cancels, so it belongs on the trail every other
  // referral decision is already on.
  'payout_batch',
];

/**
 * The CLOSED audit-action vocabulary. Every state transition in this domain
 * appends exactly one of these with an actor and a reason — the
 * `payment_repairs` discipline. Adding a verb is a visible widening (tuple +
 * migration), which is the honest cost of an audit trail nothing can write
 * prose into.
 */
export type ReferralEventAction =
  | 'program_drafted'
  | 'program_published'
  | 'program_paused'
  | 'program_resumed'
  | 'program_ended'
  | 'program_retired'
  // #143: the two operator levers (redirect / attribution) on one program.
  | 'program_controls_set'
  | 'partner_applied'
  | 'partner_invited'
  | 'partner_approved'
  | 'partner_suspended'
  | 'partner_reinstated'
  | 'partner_terminated'
  | 'appeal_opened'
  | 'appeal_resolved'
  | 'code_issued'
  | 'code_retired'
  | 'link_issued'
  | 'link_revoked'
  | 'attribution_created'
  | 'attribution_superseded'
  | 'attribution_refused'
  | 'attribution_invalidated'
  | 'attribution_corrected'
  | 'subject_merge_redirected'
  | 'conversion_recorded'
  | 'conversion_verified'
  | 'conversion_rejected'
  | 'conversion_reversed'
  | 'conversion_corrected'
  | 'reward_rule_drafted'
  | 'reward_rule_activated'
  | 'reward_rule_superseded'
  | 'reward_rule_retired'
  | 'reward_accrued'
  | 'reward_accrual_refused'
  | 'reward_reversed'
  | 'reward_voided'
  // #145: the earnings ledger. `reward_vested` and `reward_payout_settled` are
  // the two lifecycle steps #144 declared a column for and never wrote; the
  // freeze pair is ADR 0005 R3/R8's pause; and the payout verbs are the batch's
  // own, each attributable to the operator who performed it.
  | 'reward_vested'
  | 'reward_frozen'
  | 'reward_unfrozen'
  | 'reward_payout_settled'
  | 'reward_clawback_recorded'
  | 'payout_batch_opened'
  | 'payout_batch_approved'
  | 'payout_batch_settled'
  | 'payout_batch_failed'
  | 'payout_batch_cancelled'
  | 'partner_recovery_recorded'
  | 'earnings_discrepancy_recorded'
  | 'earnings_discrepancy_resolved'
  // #146. A declaration and a readiness sync are both facts about a PARTNER, so
  // they join the trail every other partner decision is on rather than starting
  // one. `partner_readiness_synced` is written only when a summary actually
  // MOVED — a sweep that re-observed the same three verdicts writes nothing, or
  // the trail an operator reads becomes a heartbeat with the decisions buried
  // in it.
  | 'partner_tax_profile_declared'
  | 'partner_readiness_synced';

/** {@link ReferralEventAction} as a tuple. */
export const REFERRAL_EVENT_ACTIONS: readonly ReferralEventAction[] = [
  'program_drafted',
  'program_published',
  'program_paused',
  'program_resumed',
  'program_ended',
  'program_retired',
  'program_controls_set',
  'partner_applied',
  'partner_invited',
  'partner_approved',
  'partner_suspended',
  'partner_reinstated',
  'partner_terminated',
  'appeal_opened',
  'appeal_resolved',
  'code_issued',
  'code_retired',
  'link_issued',
  'link_revoked',
  'attribution_created',
  'attribution_superseded',
  'attribution_refused',
  'attribution_invalidated',
  'attribution_corrected',
  'subject_merge_redirected',
  'conversion_recorded',
  'conversion_verified',
  'conversion_rejected',
  'conversion_reversed',
  'conversion_corrected',
  // #144. `reward_accrual_refused` is the one that carries ADR 0005 D16: an
  // accrual that produced nothing leaves a row saying which of the thirteen
  // named reasons applied, because a partner-support question deserves an
  // answer and an effect that did not happen must be distinguishable from one
  // that silently vanished.
  'reward_rule_drafted',
  'reward_rule_activated',
  'reward_rule_superseded',
  'reward_rule_retired',
  'reward_accrued',
  'reward_accrual_refused',
  'reward_reversed',
  'reward_voided',
  // #145 — see the note above.
  'reward_vested',
  'reward_frozen',
  'reward_unfrozen',
  'reward_payout_settled',
  'reward_clawback_recorded',
  'payout_batch_opened',
  'payout_batch_approved',
  'payout_batch_settled',
  'payout_batch_failed',
  'payout_batch_cancelled',
  'partner_recovery_recorded',
  'earnings_discrepancy_recorded',
  'earnings_discrepancy_resolved',
  // #146 — see the note on the union above.
  'partner_tax_profile_declared',
  'partner_readiness_synced',
];

/** Who performed an audited referral action. */
export type ReferralEventActorKind = 'partner' | 'operator' | 'system';

/** {@link ReferralEventActorKind} as a tuple. */
export const REFERRAL_EVENT_ACTOR_KINDS: readonly ReferralEventActorKind[] = [
  'partner',
  'operator',
  'system',
];

// ─── Partner-safe read DTOs (ADR 0005 A5: explicit allow-lists) ──────────────

/**
 * A program as a PARTNER may see it. Every field named, nothing passed
 * through: no internal policy references, no operator identities, no cohort
 * machinery.
 */
export interface ReferralProgramPartnerView {
  programId: string;
  version: number;
  name: string;
  publicTermsSummary: string;
  family: ReferralProgramFamily;
  status: ReferralProgramStatus;
  /** ISO-8601, when set. */
  effectiveStartAt?: string;
  /** ISO-8601, when set. */
  effectiveEndAt?: string;
  attributionWindowDays: number;
  termsVersion: string;
  disclosureVersion: string;
}

/** A code as its OWNING partner may see it. */
export interface ReferralCodePartnerView {
  id: string;
  code: string;
  status: ReferralInstrumentStatus;
  programId: string;
  destinationType?: ReferralDestinationType;
  destinationRef?: string;
  campaignRef?: string;
  market?: string;
  locale?: string;
  disclosureRequired: boolean;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601, when set. */
  expiresAt?: string;
}

/** A link as its OWNING partner may see it. The token is the partner's to share. */
export interface ReferralLinkPartnerView {
  id: string;
  codeId: string;
  token: string;
  status: ReferralInstrumentStatus;
  destinationType?: ReferralDestinationType;
  destinationRef?: string;
  campaignRef?: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601, when set. */
  expiresAt?: string;
}

/**
 * An attribution as its partner may see it (ADR 0005 A5): day-granularity
 * date, state, program and subject KIND. Deliberately no subject reference, no
 * order data, no contact data, in any form, at any aggregation level.
 */
export interface ReferralAttributionPartnerView {
  /** Day granularity, `YYYY-MM-DD`. */
  date: string;
  state: ReferralAttributionState;
  programId: string;
  subjectKind: ReferralSubjectKind;
}
