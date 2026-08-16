/**
 * Referral integrity: prohibited conduct, risk signals, self-referral evidence,
 * scoped enforcement, appeals, disclosures and retention (#148, under ADR 0005
 * D7, D17, D18 and R6–R8).
 *
 * #142 built the records, #143 the edge, #144 the rules, #145 the money and
 * #146 the partner. What none of them owns is the question this file answers:
 * **on what evidence may Mercaria take something away, and what exactly may it
 * take.**
 *
 * ## The one law, stated four ways
 *
 * ADR 0005 D17: *"Signals freeze; only first-party identity evidence voids."*
 * A statistical anomaly is a reason to look, never a reason to keep somebody's
 * money. That law is held here by four independent mechanisms, none of which is
 * a branch somebody can forget to write:
 *
 * 1. {@link REFERRAL_ENFORCEMENT_FINANCIAL_EFFECTS} is an EXHAUSTIVE `Record`
 *    over every action, so an action added without an effect fails `tsc`;
 *    {@link REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS} is DERIVED from it rather
 *    than written down a second time.
 * 2. {@link ReferralEnforcementBasis} is a closed set, and
 *    {@link REFERRAL_BASES_PERMITTING_FORFEITURE} is derived by SUBTRACTION of
 *    the one basis — `risk_signal` — that may not, so a basis added later is
 *    permitted only if somebody says so out loud.
 * 3. The `referral_enforcement_actions` CHECK renders both derived sets, so a
 *    forfeiting action on a signal basis has no row shape at all — not a
 *    service bug, not an operator mistake, not `psql`.
 * 4. `referral-integrity-isolation.test.ts` scans the whole domain directory.
 *
 * ## Fraud detection reads about BEHAVIOUR, never about a person
 *
 * {@link REFERRAL_RISK_SIGNAL_KINDS} and
 * {@link REFERRAL_FORBIDDEN_RISK_SIGNALS} are DISJOINT unions — the
 * `RETAIL_FORBIDDEN_COMPONENT_KINDS` device, applied to evidence. Everything on
 * the second list is an IDENTIFIER (an email, a card, an IP, a device) and
 * everything on the first is a BEHAVIOUR Mercaria observed in its own commerce
 * records. `ReferralRiskSignalFacts` then has a field for every permitted
 * signal and none for any forbidden one, which is the
 * `SourcingCandidateFacts` device: a detector that cannot see a device
 * fingerprint cannot be tuned into one.
 *
 * The prohibition is not squeamishness. ADR 0005 A2 says those identifiers are
 * NOT Mercaria referral identity, and #77's whole analytics domain is an
 * allow-list of typed columns for the same reason: an open bag is the one
 * mechanism by which a cross-product identity graph gets built one defensible
 * column at a time.
 *
 * ## `unknown` is not a soft yes
 *
 * {@link ReferralSelfReferralVerdict} is three-valued and two of the three
 * refuse to attribute. `review` is not "probably fine" — it is the state the
 * issue's *"do not automatically declare self-referral from a shared household
 * IP"* rule produces, and it routes to a person rather than to a refusal or to
 * silence.
 */

import {
  REFERRAL_FORBIDDEN_IDENTITY_SIGNALS,
  type ReferralForbiddenIdentitySignal,
} from './referral-attribution';
import { REFERRAL_APPEAL_STATES, type ReferralAppealState } from './referral';

// ─── Prohibited conduct (#148 "Prohibited conduct policy") ───────────────────

/**
 * The CLOSED set of conduct a program version may prohibit.
 *
 * Sixteen kinds, exactly the issue's list, as VALUES rather than as prose in a
 * terms document: a partner surface renders the ones their program names, an
 * enforcement action cites one, and a policy version that wanted to prohibit
 * something outside the set has no way to say so. That last property is the
 * point — a free-text prohibition is unenforceable and unchallengeable, and an
 * appeal against "you violated our spirit" is not one anybody can win.
 *
 * Adding a kind is a tuple edit plus a migration widening the CHECK, which is
 * the honest cost of a rule people are held to.
 */
export type ReferralProhibitedConduct =
  /** Referring yourself, or a party you are related to — ADR 0005 D7/D8. */
  | 'self_or_related_party_referral'
  /** Recruiting sub-partners for a share. ADR 0005 D8: no chains, no cascade. */
  | 'multi_level_recruitment'
  /** Cookie stuffing, hidden iframes, forced clicks, auto-redirects. */
  | 'cookie_stuffing_or_forced_clicks'
  /** Unsolicited bulk messaging in any medium. */
  | 'spam_or_unsolicited_messaging'
  /** Misleading earnings, savings or product claims. */
  | 'misleading_earnings_or_product_claims'
  /** Posing as Oxy, Mercaria, a merchant or a brand. */
  | 'impersonation'
  /** Bidding on trademarked terms without written authorization. */
  | 'unauthorized_trademark_bidding'
  /** Cashback, coupon or incentivized placement without explicit approval. */
  | 'unapproved_incentivized_promotion'
  /** Fake reviews, or sponsored content presented as independent. */
  | 'fake_reviews_or_undisclosed_sponsorship'
  /** Scripted account creation or scripted checkout. */
  | 'automated_account_or_checkout_creation'
  /** Purchases, cancellations, returns or disputes staged to earn. */
  | 'fraudulent_purchase_or_dispute'
  /** Manufacturing a merchant activation or subscription event. */
  | 'merchant_event_manipulation'
  /** Failing to disclose the paid relationship where it is required. */
  | 'disclosure_failure'
  /** Promoting into a market or to an audience the program excludes. */
  | 'restricted_geography_or_audience'
  /** Selling, renting or sharing a partner account. */
  | 'partner_account_sharing_or_sale'
  /** Attempting to obtain referred-customer identity — ADR 0005 A5. */
  | 'referred_customer_data_access';

/** {@link ReferralProhibitedConduct} as a tuple. */
export const REFERRAL_PROHIBITED_CONDUCT_KINDS: readonly ReferralProhibitedConduct[] = [
  'self_or_related_party_referral',
  'multi_level_recruitment',
  'cookie_stuffing_or_forced_clicks',
  'spam_or_unsolicited_messaging',
  'misleading_earnings_or_product_claims',
  'impersonation',
  'unauthorized_trademark_bidding',
  'unapproved_incentivized_promotion',
  'fake_reviews_or_undisclosed_sponsorship',
  'automated_account_or_checkout_creation',
  'fraudulent_purchase_or_dispute',
  'merchant_event_manipulation',
  'disclosure_failure',
  'restricted_geography_or_audience',
  'partner_account_sharing_or_sale',
  'referred_customer_data_access',
];

/**
 * The publication state of a conduct-policy version.
 *
 * The `fee_schedules` / `referral_reward_rules` device: `draft` is editable,
 * everything else is frozen by trigger, and exactly one version per key may be
 * `active` at a time (a partial unique). A policy change is a NEW version,
 * because a partner accepted the one that was live when they accepted, and
 * rewriting it retroactively would make the accepted terms version a pointer to
 * something that no longer exists.
 */
export type ReferralConductPolicyStatus = 'draft' | 'active' | 'superseded';

/** {@link ReferralConductPolicyStatus} as a tuple. */
export const REFERRAL_CONDUCT_POLICY_STATUSES: readonly ReferralConductPolicyStatus[] = [
  'draft',
  'active',
  'superseded',
];

// ─── Risk signals (#148 "Risk signals") ──────────────────────────────────────

/**
 * The CLOSED set of things a risk signal may be ABOUT.
 *
 * Every member is a BEHAVIOUR Mercaria observed in its own commerce records, or
 * a fact a person asserted on the record. Not one of them is an identifier, and
 * that is what {@link REFERRAL_FORBIDDEN_RISK_SIGNALS} makes checkable.
 */
export type ReferralRiskSignalKind =
  /** A partner declared a relationship to the referred party (#146's answer). */
  | 'declared_related_party'
  /**
   * The referred Oxy account's age and verified activity, under a reviewed
   * policy — the issue's signal 2.
   *
   * A COARSE band computed by the caller, never a birth date and never a
   * profile read: what is stored is that the account was younger than the
   * policy's floor when it converted, which is a fact about timing.
   */
  | 'referred_account_maturity'
  /** Conversions repeating on a shape or a cadence a program did not expect. */
  | 'repeated_conversion_pattern'
  /** Refunds, disputes or cancellations concentrated in a referred cohort. */
  | 'refund_dispute_concentration'
  /** The partner holds membership in the merchant they referred, or its seller. */
  | 'merchant_membership_overlap'
  /** Two partners resolve to one VERIFIED payout beneficiary (#46's account). */
  | 'shared_payout_beneficiary'
  /**
   * The payment provider's own outcome on ONE transaction — a dispute, a
   * refund, a decline.
   *
   * The issue's boundary 3, held by what this can reference: an OUTCOME, never
   * a provider identifier. ADR 0005 A2 lets fraud signals reference
   * payment-domain outcomes and never payment-domain identifiers, and
   * `evidenceRef` on the signal addresses a Mercaria row, so a Stripe Customer
   * has nowhere to be written down.
   */
  | 'provider_risk_outcome'
  /** Codes or links appearing at a rate or in a spread the program did not expect. */
  | 'instrument_distribution_anomaly'
  /** Click-to-conversion timing, after bot filtering (#143's classifier). */
  | 'click_to_conversion_pattern'
  /** The conversion's market and the program's declared markets disagree. */
  | 'market_mismatch'
  /** Repeated attempts against a cap or a budget that is already exhausted. */
  | 'repeated_cap_attempt'
  /** A source event whose own records disagree with each other. */
  | 'source_event_inconsistency'
  /** A prior enforcement action against this partner was confirmed. */
  | 'prior_confirmed_enforcement'
  /** An operator recorded evidence by hand, attributably. */
  | 'manual_evidence';

/** {@link ReferralRiskSignalKind} as a tuple. */
export const REFERRAL_RISK_SIGNAL_KINDS: readonly ReferralRiskSignalKind[] = [
  'declared_related_party',
  'referred_account_maturity',
  'repeated_conversion_pattern',
  'refund_dispute_concentration',
  'merchant_membership_overlap',
  'shared_payout_beneficiary',
  'provider_risk_outcome',
  'instrument_distribution_anomaly',
  'click_to_conversion_pattern',
  'market_mismatch',
  'repeated_cap_attempt',
  'source_event_inconsistency',
  'prior_confirmed_enforcement',
  'manual_evidence',
];

/**
 * The signals #148 adds to #143's prohibition — the ones a FRAUD control
 * reaches for that an ATTRIBUTION input never would.
 *
 * #143 already published {@link REFERRAL_FORBIDDEN_IDENTITY_SIGNALS}, fourteen
 * identifiers no attribution may read. #148 does not restate them and does not
 * fork them: {@link REFERRAL_FORBIDDEN_RISK_SIGNALS} is their UNION with these
 * four, so closing one door cannot leave the other open and the two lists
 * cannot drift. Two lists describing one prohibition disagree eventually, and
 * the direction they disagree in is always the permissive one.
 *
 * These four are the ones the issue names in its own voice — *"do not
 * automatically declare self-referral from a shared household IP, shared card,
 * common surname or matching email domain alone"* — expressed as MATCHES
 * rather than as identifiers, because a match between two people is the shape a
 * fraud rule reaches for and it is not what #143's list is about.
 */
export type ReferralIntegrityAdditionalForbiddenSignal =
  | 'email_domain_match'
  | 'surname_match'
  | 'household_ip_match'
  | 'cross_product_identity_graph';

/** {@link ReferralIntegrityAdditionalForbiddenSignal} as a tuple. */
export const REFERRAL_INTEGRITY_ADDITIONAL_FORBIDDEN_SIGNALS: readonly ReferralIntegrityAdditionalForbiddenSignal[] =
  ['email_domain_match', 'surname_match', 'household_ip_match', 'cross_product_identity_graph'];

/** Every signal a referral risk evaluation may never read. */
export type ReferralForbiddenRiskSignal =
  | ReferralForbiddenIdentitySignal
  | ReferralIntegrityAdditionalForbiddenSignal;

/**
 * #143's fourteen plus #148's four, as ONE tuple.
 *
 * DISJOINT from {@link REFERRAL_RISK_SIGNAL_KINDS}, and a strict SUPERSET of
 * {@link REFERRAL_FORBIDDEN_IDENTITY_SIGNALS} — both asserted by
 * `referral-integrity-isolation.test.ts`, which is what makes a nineteenth
 * plausible-sounding identifier a build failure rather than a defensible
 * addition to a list nobody re-reads.
 *
 * Stated positively and kept beside the permitted list, the
 * `REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS` device: what this list defends is an
 * OMISSION — eighteen columns that do not exist — and an omission is invisible
 * unless something names it.
 */
export const REFERRAL_FORBIDDEN_RISK_SIGNALS: readonly ReferralForbiddenRiskSignal[] = [
  ...REFERRAL_FORBIDDEN_IDENTITY_SIGNALS,
  ...REFERRAL_INTEGRITY_ADDITIONAL_FORBIDDEN_SIGNALS,
];

/**
 * Why each forbidden signal can never be recorded — the sentence a refusal
 * carries, so a reader learns the model rather than reading "unrecognized
 * kind". The `REFERRAL_FORBIDDEN_LEDGER_ACCOUNT_LABELS` device.
 *
 * Exhaustive over the union, so a member added on EITHER side — #143's or
 * #148's — fails `tsc` until somebody says why it is forbidden.
 */
export const REFERRAL_FORBIDDEN_RISK_SIGNAL_LABELS: Record<
  ReferralForbiddenRiskSignal,
  string
> = {
  email_address:
    'a contact identifier — ADR 0005 A2 places email outside referral identity, and a ' +
    'signal keyed on one is a durable user graph with a fraud label on it',
  email_hash:
    'an exact-match ORACLE over an inbox; irreversibility is not de-identification, and ' +
    'it links across guest checkouts exactly as the plaintext would',
  email_domain_match:
    'a shared employer or a shared free provider, which the issue names as insufficient ' +
    'for a self-referral finding on its own',
  phone_number: 'a contact identifier, on the same footing as an email address',
  postal_address:
    'a household, a student residence or an office — a shared address is not a shared person',
  surname_match:
    'a family name, which the issue names as insufficient on its own and which encodes ' +
    'ethnicity far more reliably than it encodes a relationship',
  card_fingerprint:
    'a payment-domain identifier; ADR 0005 A2 lets a signal reference a payment OUTCOME ' +
    'and never a payment identifier',
  payment_method_id: 'the same, one abstraction up',
  stripe_customer_id:
    'Stripe’s identity for a person, which crosses every Mercaria checkout they ever made',
  stripe_link_identity:
    'Stripe Link’s cross-merchant identity — a general user graph by construction',
  ip_address: 'a network locator, shared by everyone behind one router and by nobody reliably',
  household_ip_match:
    'the issue’s named false positive: a family, a flatshare and a café are one address',
  user_agent_fingerprint: 'a device declaration, and the first component of every fingerprint',
  device_fingerprint: 'the thing ADR 0005 A2 exists to forbid, by name',
  advertising_identifier: 'a cross-app identity somebody else assigned to a person',
  tls_fingerprint: 'a device declaration one layer down, invisible to the person making it',
  canvas_fingerprint: 'a device declaration the person cannot see, clear or consent to',
  cross_product_identity_graph:
    'the outcome all seventeen above compose into, named so that assembling one from ' +
    'permitted parts is still recognisably this',
};

/** How much a signal is worth to a reviewer. Never a score, never a threshold. */
export type ReferralRiskSignalSeverity = 'informational' | 'elevated' | 'high';

/** {@link ReferralRiskSignalSeverity} as a tuple. */
export const REFERRAL_RISK_SIGNAL_SEVERITIES: readonly ReferralRiskSignalSeverity[] = [
  'informational',
  'elevated',
  'high',
];

/** What a risk signal is recorded ABOUT. Every member is a referral row id. */
export type ReferralRiskSubjectType = 'partner' | 'attribution' | 'conversion' | 'reward';

/** {@link ReferralRiskSubjectType} as a tuple. */
export const REFERRAL_RISK_SUBJECT_TYPES: readonly ReferralRiskSubjectType[] = [
  'partner',
  'attribution',
  'conversion',
  'reward',
];

/**
 * Everything a risk evaluation may read, and the whole of it.
 *
 * The `SourcingCandidateFacts` and `PayoutGateFacts` device: there is a field
 * for every permitted signal and NO field for any member of
 * {@link REFERRAL_FORBIDDEN_RISK_SIGNALS} — so "the evaluator cannot read a
 * device fingerprint" is a property of this type rather than a rule somebody
 * reviews. Every member is a COUNT, a RATE, a DURATION or a BOOLEAN somebody
 * derived from Mercaria's own records; not one of them is an identifier, and
 * none of them can be turned into one by combining the others.
 *
 * `undefined` means NOT MEASURED, and it is never read as zero — the #58
 * denominator rule. A signal is emitted only for a fact that was actually
 * observed.
 */
export interface ReferralRiskSignalFacts {
  /** The partner said so, on their application (#146). */
  declaredRelatedParty?: boolean;
  /** Days between the referred Oxy account's creation and its conversion. */
  referredAccountAgeDays?: number;
  /** Conversions attributed to this partner in the measured window. */
  conversionsInWindow?: number;
  /** Touches recorded against this partner's instruments in the measured window. */
  touchesInWindow?: number;
  /** Refunded conversions ÷ conversions, over the measured window, in basis points. */
  refundRateBps?: number;
  /** Disputed conversions ÷ conversions, over the measured window, in basis points. */
  disputeRateBps?: number;
  /** The partner holds an owner/admin/staff membership in the referred store. */
  merchantMembershipOverlap?: boolean;
  /** Another approved partner resolves to the same `provider_accounts` row. */
  sharedPayoutBeneficiaryPartnerCount?: number;
  /** Payment-domain OUTCOMES on referred orders in the window. Never an id. */
  providerAdverseOutcomeCount?: number;
  /** Median seconds between the winning touch and its conversion. */
  medianClickToConversionSeconds?: number;
  /** The conversion's market is outside the program's declared markets. */
  marketOutsideProgramScope?: boolean;
  /** Accruals refused for `cap_reached` or `budget_exhausted` in the window. */
  capRefusalCount?: number;
  /** A source event's own records disagree — #62/#65's inconsistency. */
  sourceEventInconsistent?: boolean;
  /** A prior enforcement action against this partner reached `confirmed`. */
  priorConfirmedEnforcementCount?: number;
}

// ─── Self-referral (#148 "Self-referral evaluation", ADR 0005 D7) ────────────

/**
 * The CLOSED set of evidence a self-referral finding may rest on.
 *
 * ADR 0005 D7 admits exactly two facts as DETERMINISTIC — the same Oxy actor,
 * and store membership — and says everything else *"freezes and routes to
 * manual review"*. The issue lists four more as "strong evidence where
 * available". Both are honoured, and the reconciliation is
 * {@link REFERRAL_SELF_REFERRAL_EVIDENCE_STRENGTH}: the ADR's two REFUSE, the
 * issue's four REVIEW, and no member of this union may do neither.
 */
export type ReferralSelfReferralEvidence =
  /** The converting Oxy account IS the partner's owner. ADR 0005 D7, deterministic. */
  | 'same_oxy_actor'
  /**
   * The partner owns or administers the referred merchant, or holds membership
   * in the store that is the seller. ADR 0005 D7 and D8's hard exclusion.
   */
  | 'partner_administers_referred_merchant'
  /** A verified payout beneficiary overlaps a merchant owner or buyer. */
  | 'verified_beneficiary_overlap'
  /** The partner declared the relationship themselves, on the record. */
  | 'explicit_related_party_declaration'
  /** A staff or test enrollment (#146's mode), producing test traffic. */
  | 'staff_or_test_activity'
  /** Evidence an operator recorded and a reviewer approved, attributably. */
  | 'approved_operator_finding';

/** {@link ReferralSelfReferralEvidence} as a tuple. */
export const REFERRAL_SELF_REFERRAL_EVIDENCE_KINDS: readonly ReferralSelfReferralEvidence[] =
  [
    'same_oxy_actor',
    'partner_administers_referred_merchant',
    'verified_beneficiary_overlap',
    'explicit_related_party_declaration',
    'staff_or_test_activity',
    'approved_operator_finding',
  ];

/**
 * Evidence that may NEVER, on its own, produce a self-referral finding —
 * the issue's sentence, as values.
 *
 * DISJOINT from {@link REFERRAL_SELF_REFERRAL_EVIDENCE_KINDS}. Each is also a
 * member of {@link REFERRAL_FORBIDDEN_RISK_SIGNALS} under its signal spelling,
 * which is deliberate: the prohibition holds whether somebody reaches for it as
 * evidence or as a signal, and the two lists are checked against each other so
 * that closing one door cannot leave the other open.
 */
export type ReferralForbiddenSelfReferralEvidence =
  | 'shared_household_ip'
  | 'shared_payment_card'
  | 'common_surname'
  | 'matching_email_domain'
  | 'shared_device_fingerprint'
  | 'shared_postal_address';

/** {@link ReferralForbiddenSelfReferralEvidence} as a tuple. */
export const REFERRAL_FORBIDDEN_SELF_REFERRAL_EVIDENCE: readonly ReferralForbiddenSelfReferralEvidence[] =
  [
    'shared_household_ip',
    'shared_payment_card',
    'common_surname',
    'matching_email_domain',
    'shared_device_fingerprint',
    'shared_postal_address',
  ];

/** What one piece of evidence is worth. */
export type ReferralSelfReferralEvidenceStrength = 'deterministic' | 'reviewable';

/**
 * What each admissible evidence kind is WORTH, as data.
 *
 * Exhaustive over the union, so a kind added without a strength fails `tsc` —
 * which is the point: the dangerous default is "new evidence refuses", and a
 * `Record` with no entry would otherwise read as `undefined` and take whichever
 * branch the code happens to write first.
 *
 * Only ADR 0005 D7's two are `deterministic`. `verified_beneficiary_overlap` is
 * strong and is still `reviewable`, because two partners legitimately share a
 * beneficiary (an agency, a household business), and D7 is explicit that
 * refusal on identity is *"deterministic and final"* while suspicion on signals
 * is *"reviewable"* — a rule that quietly refuses on an overlap would be
 * final on evidence the ADR did not make final.
 */
export const REFERRAL_SELF_REFERRAL_EVIDENCE_STRENGTH: Record<
  ReferralSelfReferralEvidence,
  ReferralSelfReferralEvidenceStrength
> = {
  same_oxy_actor: 'deterministic',
  partner_administers_referred_merchant: 'deterministic',
  verified_beneficiary_overlap: 'reviewable',
  explicit_related_party_declaration: 'reviewable',
  staff_or_test_activity: 'reviewable',
  approved_operator_finding: 'reviewable',
};

/** Every evidence kind that REFUSES an attribution outright, derived. */
export const REFERRAL_DETERMINISTIC_SELF_REFERRAL_EVIDENCE: readonly ReferralSelfReferralEvidence[] =
  REFERRAL_SELF_REFERRAL_EVIDENCE_KINDS.filter(
    (kind) => REFERRAL_SELF_REFERRAL_EVIDENCE_STRENGTH[kind] === 'deterministic',
  );

/**
 * The verdict. THREE-valued, and `review` is not a soft yes.
 *
 * A STRING discriminant rather than a boolean pair, because the backend
 * compiles with `strict: false` and without `strictNullChecks` TypeScript does
 * not narrow a union on a boolean-literal discriminant — the #68 finding, which
 * this domain's callers must act on because all three arms lead somewhere
 * different.
 */
export type ReferralSelfReferralVerdict = 'permitted' | 'review' | 'refused';

/** {@link ReferralSelfReferralVerdict} as a tuple. */
export const REFERRAL_SELF_REFERRAL_VERDICTS: readonly ReferralSelfReferralVerdict[] = [
  'permitted',
  'review',
  'refused',
];

/**
 * The answer, with its reasons.
 *
 * `refused` carries the DETERMINISTIC evidence that produced it and nothing
 * else, so an explanation given to a partner is exactly the rule that was
 * applied. `review` carries what a person should look at. `permitted` carries
 * nothing, because there is nothing to explain.
 */
export type ReferralSelfReferralAssessment =
  | { verdict: 'permitted' }
  | { verdict: 'review'; evidence: readonly ReferralSelfReferralEvidence[] }
  | { verdict: 'refused'; evidence: readonly ReferralSelfReferralEvidence[] };

/**
 * Everything the self-referral evaluation may read, and the whole of it.
 *
 * First-party Mercaria/Oxy facts only. There is no email field, no card field,
 * no address field and no IP field, so ADR 0005 D7's *"deliberately nothing
 * else"* is a property of this type. Every member is `boolean | undefined`, and
 * `undefined` means NOT ESTABLISHED — never read as `false`, because "we could
 * not check" and "we checked and it is not so" lead a reviewer to opposite
 * conclusions.
 */
export interface ReferralSelfReferralFacts {
  /** The converting Oxy account IS the partner owner (or a store member of it). */
  subjectIsPartnerOwner?: boolean;
  /** The partner holds owner/admin/staff membership in the referred store. */
  partnerHoldsReferredStoreMembership?: boolean;
  /** Two partners resolve to one verified `provider_accounts` beneficiary. */
  beneficiaryOverlapsSubject?: boolean;
  /** The partner declared a related party covering this subject. */
  relatedPartyDeclared?: boolean;
  /** The partner's enrollment mode is staff or test (#146). */
  enrollmentIsStaffOrTest?: boolean;
  /** An operator recorded a finding a reviewer approved. */
  approvedOperatorFinding?: boolean;
}

// ─── Enforcement (#148 "Enforcement states", ADR 0005 D18) ───────────────────

/**
 * The twelve enforcement actions — the issue's list, as values.
 *
 * `cleared` is here for a reason worth stating: a review that examined a
 * partner and found nothing must be DISTINGUISHABLE from a review that never
 * happened. Without a recorded clearance the two look identical, and the second
 * time somebody asks "did we look at this?" the honest answer is "no idea".
 */
export type ReferralEnforcementAction =
  /** Watch, take nothing. The action a signal alone should usually produce. */
  | 'monitoring'
  /** Freeze the affected rewards — ADR 0005 R3/R8. A PAUSE, never a void. */
  | 'commission_held'
  /** The attribution was not valid. Reverses through #144/#145. */
  | 'attribution_invalidated'
  /** The conversion did not qualify. Reverses through #144/#145. */
  | 'conversion_rejected'
  /** A recorded warning. Prospective, and evidence for a later escalation. */
  | 'partner_warning'
  /** No NEW codes or links. Existing instruments keep working. */
  | 'new_link_suspension'
  /** No NEW attribution. Existing rewards keep vesting and settling. */
  | 'new_attribution_suspension'
  /** No payout inclusion. Earnings stay payable and enter a later batch. */
  | 'payout_hold'
  /** Removal from ONE program. Other programs are untouched. */
  | 'program_removal'
  /** Enrollment terminated — ADR 0005 D18. */
  | 'partner_termination'
  /** Permanently barred from re-enrolling, where justified. */
  | 'permanent_restriction'
  /** Examined; nothing imposed. Recorded so the examination is a fact. */
  | 'cleared';

/** {@link ReferralEnforcementAction} as a tuple. */
export const REFERRAL_ENFORCEMENT_ACTIONS: readonly ReferralEnforcementAction[] = [
  'monitoring',
  'commission_held',
  'attribution_invalidated',
  'conversion_rejected',
  'partner_warning',
  'new_link_suspension',
  'new_attribution_suspension',
  'payout_hold',
  'program_removal',
  'partner_termination',
  'permanent_restriction',
  'cleared',
];

/**
 * What an action does to money.
 *
 * `none` touches none. `withholds` PAUSES — the balance stays, the clock may
 * stop, nothing is destroyed, and clearing it releases everything. `forfeits`
 * destroys earned value through #144's reversal and #145's void.
 *
 * Three values rather than a boolean, because a hold, a freeze and a void are
 * three different things (#145 already separates them) and collapsing the first
 * two into "not a void" is how a freeze silently acquires a void's
 * irreversibility.
 */
export type ReferralEnforcementFinancialEffect = 'none' | 'withholds' | 'forfeits';

/**
 * Each action's financial effect, EXHAUSTIVELY.
 *
 * An action added without an entry fails `tsc`, which is the whole mechanism:
 * {@link REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS} is derived from this table
 * rather than written down beside it, so there is exactly one place where an
 * action becomes able to destroy money and it is a place the compiler guards.
 */
export const REFERRAL_ENFORCEMENT_FINANCIAL_EFFECTS: Record<
  ReferralEnforcementAction,
  ReferralEnforcementFinancialEffect
> = {
  monitoring: 'none',
  commission_held: 'withholds',
  attribution_invalidated: 'forfeits',
  conversion_rejected: 'forfeits',
  partner_warning: 'none',
  new_link_suspension: 'none',
  new_attribution_suspension: 'none',
  payout_hold: 'withholds',
  program_removal: 'none',
  // ADR 0005 D18: termination stops NEW accrual and withholds vested-unpaid
  // rewards. The VOID that may follow a confirmed-fraud finding is a separate
  // act on the rewards themselves — `attribution_invalidated` or
  // `conversion_rejected` — which is why this is `withholds` and not
  // `forfeits`. Terminating is not the same as taking, and an enforcement
  // record that conflated them would let one operator action do both.
  partner_termination: 'withholds',
  permanent_restriction: 'none',
  cleared: 'none',
};

/**
 * Every action that may destroy earned money. DERIVED, never written twice.
 *
 * The `CONFIDENT_LINK_METHODS` device (#80): derived by filtering rather than
 * listed, so an action added later is forfeiting only if somebody said so in
 * the table above.
 */
export const REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS: readonly ReferralEnforcementAction[] =
  REFERRAL_ENFORCEMENT_ACTIONS.filter(
    (action) => REFERRAL_ENFORCEMENT_FINANCIAL_EFFECTS[action] === 'forfeits',
  );

/**
 * On what an enforcement action rests.
 *
 * The four are genuinely different kinds of thing and lead to different
 * remedies: a statistical anomaly is appealed by explaining it, a first-party
 * identity fact is appealed by disputing the fact, a reversed funding is not
 * appealable at all (the money ceased to exist), and an operator finding is
 * appealed to a second operator.
 */
export type ReferralEnforcementBasis =
  /** A velocity, a rate, a concentration. ADR 0005 D17: signals FREEZE. */
  | 'risk_signal'
  /** ADR 0005 D7's deterministic first-party identity facts. */
  | 'identity_evidence'
  /** R1/R4/R5: the funding itself was reversed, so the reward has no base. */
  | 'funding_reversed'
  /** A person examined the case and recorded a finding, attributably. */
  | 'operator_finding';

/** {@link ReferralEnforcementBasis} as a tuple. */
export const REFERRAL_ENFORCEMENT_BASES: readonly ReferralEnforcementBasis[] = [
  'risk_signal',
  'identity_evidence',
  'funding_reversed',
  'operator_finding',
];

/**
 * The ONE basis that may never carry a forfeiting action.
 *
 * ADR 0005 D17, and the issue's boundary 4 (*"Low-confidence signals cannot
 * automatically forfeit money"*) are the same sentence. Named as its own
 * constant so the derivation below is a subtraction from the closed set rather
 * than a second list.
 */
export const REFERRAL_BASIS_FORBIDDEN_FROM_FORFEITURE: ReferralEnforcementBasis = 'risk_signal';

/**
 * Every basis on which money may be taken. DERIVED BY SUBTRACTION.
 *
 * The #80 rule: a basis added later is permitted to forfeit only because
 * somebody added it, never because it was omitted from a prohibition list.
 */
export const REFERRAL_BASES_PERMITTING_FORFEITURE: readonly ReferralEnforcementBasis[] =
  REFERRAL_ENFORCEMENT_BASES.filter(
    (basis) => basis !== REFERRAL_BASIS_FORBIDDEN_FROM_FORFEITURE,
  );

/**
 * What an enforcement action is ABOUT.
 *
 * `program_partner` is the one to read: an action scoped to it removes a
 * partner from ONE program and leaves every other program they are in
 * untouched, which is the difference between `program_removal` and
 * `partner_termination` made structural rather than remembered.
 */
export type ReferralEnforcementScope =
  | 'partner'
  | 'program_partner'
  | 'instrument'
  | 'attribution'
  | 'conversion'
  | 'reward';

/** {@link ReferralEnforcementScope} as a tuple. */
export const REFERRAL_ENFORCEMENT_SCOPES: readonly ReferralEnforcementScope[] = [
  'partner',
  'program_partner',
  'instrument',
  'attribution',
  'conversion',
  'reward',
];

/**
 * What an action DOES, as an effect on the four gates that already exist.
 *
 * Derived from live actions by `deriveEnforcementEffects`, never stored — the
 * `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict
 * rule, taken for the reason that rule itself gives: the inputs are a SET of
 * rows with expiries and lifts, and a stored boolean would be right until the
 * first one expired.
 *
 * The four are INDEPENDENT, and that independence is #148 acceptance 2. Today a
 * partner's fraud posture is one coarse column (`referral_partners.state`)
 * whose `suspended` value stops new links AND new attribution AND payout at
 * once; an operator who wants to stop attribution during an investigation has
 * to stop paying honest earnings too. These four separate them.
 */
export interface ReferralEnforcementEffects {
  /** No new codes or links may be issued. */
  newLinksSuspended: boolean;
  /** No new attribution may be created. Existing rewards continue. */
  newAttributionSuspended: boolean;
  /** No payout batch may include this partner's rewards. */
  payoutHeld: boolean;
  /** Enrollment is over. */
  terminated: boolean;
  /** Re-enrollment is barred. */
  permanentlyRestricted: boolean;
  /** The program ids this partner has been removed from, if any. */
  removedFromProgramIds: readonly string[];
}

/**
 * Which effect keys each action raises, EXHAUSTIVELY.
 *
 * `removedFromProgramIds` is not here: it is a function of the action's SCOPE
 * (a `program_removal` names its program in `programId`), and putting it in a
 * boolean table would need a value the table has no room for.
 */
export const REFERRAL_ENFORCEMENT_ACTION_EFFECTS: Record<
  ReferralEnforcementAction,
  readonly (keyof Omit<ReferralEnforcementEffects, 'removedFromProgramIds'>)[]
> = {
  monitoring: [],
  // A held commission is a REWARD-level freeze, applied by #145's transition
  // machinery. It raises no partner-wide gate, which is exactly the point: an
  // operator freezing one disputed commission must not stop the other eleven
  // from settling (#148 financial rule 11).
  commission_held: [],
  attribution_invalidated: [],
  conversion_rejected: [],
  partner_warning: [],
  new_link_suspension: ['newLinksSuspended'],
  new_attribution_suspension: ['newAttributionSuspended'],
  payout_hold: ['payoutHeld'],
  program_removal: [],
  partner_termination: ['newLinksSuspended', 'newAttributionSuspended', 'payoutHeld', 'terminated'],
  permanent_restriction: ['permanentlyRestricted'],
  cleared: [],
};

/**
 * How an appeal against an enforcement action stands.
 *
 * #142's `REFERRAL_APPEAL_STATES` REUSED rather than restated. A partner
 * appealing a suspension and a partner appealing a payout hold are one kind of
 * thing, and a second four-member vocabulary spelled `upheld | overturned`
 * would be the same states under different words — which is exactly how an
 * operator surface ends up rendering two appeal columns that disagree.
 *
 * The mapping, stated once so nobody has to infer it: the states are about the
 * APPEAL, not the action. `accepted` means the appeal succeeded and the action
 * is lifted; `rejected` means it did not and the action stands.
 */
export type ReferralEnforcementAppealState = ReferralAppealState;

/** {@link ReferralEnforcementAppealState} as a tuple — #142's, unchanged. */
export const REFERRAL_ENFORCEMENT_APPEAL_STATES: readonly ReferralEnforcementAppealState[] =
  REFERRAL_APPEAL_STATES;

/**
 * The two decisions a reviewer may record. DERIVED by subtracting the two
 * states a decision cannot produce — `none` (nobody appealed) and `open`
 * (somebody did and nobody has answered).
 */
export const REFERRAL_ENFORCEMENT_APPEAL_DECISIONS: readonly ReferralEnforcementAppealState[] =
  REFERRAL_APPEAL_STATES.filter((state) => state !== 'none' && state !== 'open');

/** A decision a reviewer may record on an appeal. */
export type ReferralEnforcementAppealDecision = 'accepted' | 'rejected';

/**
 * An enforcement action as an OPERATOR reads it. Every field named.
 *
 * The `provider_accounts` (#46) projection device. `evidenceSignalIds` are row
 * ids into `referral_risk_signals`, which carry no identifiers of their own —
 * so following the whole trail from an action to its evidence never reaches a
 * person.
 */
export interface ReferralEnforcementActionView {
  id: string;
  action: ReferralEnforcementAction;
  scope: ReferralEnforcementScope;
  subjectId: string;
  partnerId: string;
  programId?: string;
  basis: ReferralEnforcementBasis;
  conduct?: ReferralProhibitedConduct;
  reason: string;
  evidenceSignalIds: readonly string[];
  financialEffect: ReferralEnforcementFinancialEffect;
  /** ISO-8601. */
  startsAt: string;
  /** ISO-8601, when the action expires on its own. */
  expiresAt?: string;
  /** ISO-8601, when an operator or an appeal lifted it. */
  liftedAt?: string;
  liftReason?: string;
  appealState: ReferralEnforcementAppealState;
  imposedByOxyUserId: string;
  /** ISO-8601. */
  createdAt: string;
}

/**
 * What a PARTNER may see about an action against them.
 *
 * A different TYPE rather than a filtered one — #106's `MerchantOrder` device —
 * so a serializer reaching for an operator's identity or another partner's
 * evidence fails `tsc`. There is no `imposedByOxyUserId`, no
 * `evidenceSignalIds` and no `subjectId`: a partner is told WHAT was done, on
 * WHICH conduct rule, WHEN, and how to appeal. Naming the operator invites the
 * retaliation an allow-listed review surface exists to prevent, and naming the
 * evidence rows would disclose the other partner a duplicate-beneficiary signal
 * matched.
 */
export interface ReferralEnforcementPartnerView {
  id: string;
  action: ReferralEnforcementAction;
  /** The prohibited-conduct rule cited, when one was. */
  conduct?: ReferralProhibitedConduct;
  reason: string;
  financialEffect: ReferralEnforcementFinancialEffect;
  /** ISO-8601. */
  startsAt: string;
  /** ISO-8601. */
  expiresAt?: string;
  /** ISO-8601. */
  liftedAt?: string;
  appealState: ReferralEnforcementAppealState;
  /** Whether this partner may still open an appeal against it. */
  appealable: boolean;
}

/**
 * Fields a partner-facing enforcement projection may NEVER carry, as VALUES.
 *
 * Scanned statically AND walked at RUNTIME over a real emitted view — #92's
 * two-gate rule, because a static scan proves the code does not name them today
 * and a runtime walk proves the object does not carry them.
 */
export const REFERRAL_ENFORCEMENT_PARTNER_FORBIDDEN_FIELDS: readonly string[] = [
  'imposedByOxyUserId',
  'liftedByOxyUserId',
  'evidenceSignalIds',
  'subjectId',
  'basis',
  'decidedByOxyUserId',
  'matchedPartnerId',
  'referredOxyUserId',
  'buyerEmail',
  'orderId',
];

// ─── Disclosure (#148 "Disclosure and promotion compliance") ─────────────────

/**
 * Where a disclosure has to appear.
 *
 * Bounded so a program can state its requirement per surface: a link in a bio
 * and a spoken sentence in a video are the same obligation with different copy,
 * and one blob of text serving both is one that fits neither.
 */
export type ReferralDisclosureSurface =
  | 'link'
  | 'social_post'
  | 'video'
  | 'livestream'
  | 'email'
  | 'profile_bio'
  | 'checkout';

/** {@link ReferralDisclosureSurface} as a tuple. */
export const REFERRAL_DISCLOSURE_SURFACES: readonly ReferralDisclosureSurface[] = [
  'link',
  'social_post',
  'video',
  'livestream',
  'email',
  'profile_bio',
  'checkout',
];

/**
 * Claims a disclosure text may never make, as VALUES.
 *
 * #148 disclosure rules 6, 7 and 8: a partner is not an employee, not an
 * official store, not a brand representative and not verified. Those
 * relationships are #55's to establish, and a marketing program that could
 * grant one by publishing a sentence would be a second answer to a question
 * the relationship layer already answers.
 *
 * Scanned against the copy at publication time, and against the domain's own
 * source by the isolation gate.
 */
export const REFERRAL_DISCLOSURE_FORBIDDEN_CLAIMS: readonly string[] = [
  'official store',
  'official partner',
  'official brand',
  'brand representative',
  'authorized reseller',
  'mercaria employee',
  'oxy employee',
  'works for mercaria',
  'verified partner',
  'verified by mercaria',
];

/** Publication state of a disclosure requirement version. */
export type ReferralDisclosureStatus = 'draft' | 'active' | 'superseded';

/** {@link ReferralDisclosureStatus} as a tuple. */
export const REFERRAL_DISCLOSURE_STATUSES: readonly ReferralDisclosureStatus[] = [
  'draft',
  'active',
  'superseded',
];

/** The disclosure copy a partner is given for one surface, market and language. */
export interface ReferralDisclosureView {
  surface: ReferralDisclosureSurface;
  /** ISO-3166 alpha-2, or `*` for the market-independent default. */
  market: string;
  /** BCP-47 primary subtag, or `*` for the language-independent default. */
  language: string;
  version: number;
  /** The exact sentence a partner is asked to render. */
  copy: string;
  /** Whether omitting it is a `disclosure_failure` under the conduct policy. */
  required: boolean;
}

// ─── Retention (#148 "Privacy and data lifecycle") ───────────────────────────

/**
 * The twelve classes of referral data, exactly the issue's inventory.
 *
 * Naming them as a closed set is what makes "every class has a retention
 * policy" checkable: a class with no entry in
 * {@link REFERRAL_RETENTION_POLICY} fails `tsc`, and a stored table with no
 * class fails the register test.
 */
export type ReferralRetentionClass =
  | 'raw_touch'
  | 'durable_attribution'
  | 'conversion_record'
  | 'risk_signal'
  | 'review_evidence'
  | 'appeal'
  | 'commission_and_ledger'
  | 'payout_record'
  | 'identity_and_tax_readiness'
  | 'provider_event'
  | 'partner_support_message'
  | 'aggregate_analytics';

/** {@link ReferralRetentionClass} as a tuple. */
export const REFERRAL_RETENTION_CLASSES: readonly ReferralRetentionClass[] = [
  'raw_touch',
  'durable_attribution',
  'conversion_record',
  'risk_signal',
  'review_evidence',
  'appeal',
  'commission_and_ledger',
  'payout_record',
  'identity_and_tax_readiness',
  'provider_event',
  'partner_support_message',
  'aggregate_analytics',
];

/**
 * How long a class is kept, and why.
 *
 * `sweptAfterDays` is a NUMBER when a sweep deletes the rows and `null` when
 * the class is retained for as long as the financial or statutory record it
 * belongs to — which is an honest answer rather than a missing one, and is why
 * the field is nullable instead of carrying a very large number that would look
 * like a policy somebody chose.
 *
 * The invariant #148 acceptance 5 asks for — *"raw touch data expires earlier
 * than financial records"* — is asserted over this table by
 * `referral-retention.test.ts` rather than left as a sentence in a document.
 */
export interface ReferralRetentionRule {
  /** Days from the row's own deadline, or `null` for financial retention. */
  sweptAfterDays: number | null;
  /** Why it is kept for that long. Rendered in the privacy documentation. */
  basis: string;
}

/**
 * Every class's rule, EXHAUSTIVELY.
 *
 * The numbers agree with `db/expiryTargets.ts`, which is where the sweep
 * actually reads them; this table is the POLICY and that file is the
 * MECHANISM, and `referral-retention.test.ts` asserts they agree — two
 * representations of one fact are exactly what a register exists to keep
 * honest.
 */
export const REFERRAL_RETENTION_POLICY: Record<
  ReferralRetentionClass,
  ReferralRetentionRule
> = {
  raw_touch: {
    sweptAfterDays: 30,
    basis:
      'Raw click and code-entry evidence, swept 30 days past its own attribution-window ' +
      'expiry. It exists to explain a live attribution and outlives it only long enough ' +
      'to answer a dispute about one.',
  },
  durable_attribution: {
    sweptAfterDays: null,
    basis:
      'Pinned to an order at conversion and retained with the commercial record it ' +
      'explains: which partner is owed for which order is a financial fact.',
  },
  conversion_record: {
    sweptAfterDays: null,
    basis: 'The qualifying event a reward was computed from. Retained with the reward.',
  },
  risk_signal: {
    sweptAfterDays: 400,
    basis:
      'An observation about behaviour, kept long enough to establish a pattern across a ' +
      'full year plus a review cycle, then deleted. It is not a financial record and ' +
      'nothing downstream reads it after a case closes.',
  },
  review_evidence: {
    sweptAfterDays: 730,
    basis:
      'What a reviewer looked at. Kept two years so a contested decision can be ' +
      'reconstructed, then deleted — the enforcement ACTION survives it, so the ' +
      'decision stays explicable after the working papers are gone.',
  },
  appeal: {
    sweptAfterDays: 730,
    basis: 'The appellant’s own submission and the decision on it, on the same clock as the review.',
  },
  commission_and_ledger: {
    sweptAfterDays: null,
    basis:
      'Financial records. `ledger_entries` refuses UPDATE and DELETE by trigger and this ' +
      'domain issues no delete against any of them.',
  },
  payout_record: {
    sweptAfterDays: null,
    basis: 'Money that left Mercaria, retained as a financial and tax record.',
  },
  identity_and_tax_readiness: {
    sweptAfterDays: null,
    basis:
      'A coarse readiness SUMMARY and a tax declaration. Mercaria stores no identity ' +
      'documents at all — Stripe owns collection (ADR 0001 D2) — so what is retained is ' +
      'the verdict and the questionnaire answer, both of which the tax record needs.',
  },
  provider_event: {
    sweptAfterDays: 90,
    basis:
      'Payment-provider deliveries, on the payment domain’s own retention. Referral code ' +
      'reads OUTCOMES from them and stores none.',
  },
  partner_support_message: {
    sweptAfterDays: 730,
    basis: 'Correspondence about an enforcement case, on the review clock.',
  },
  aggregate_analytics: {
    sweptAfterDays: null,
    basis:
      'Counts with no actor column. Retained because there is no person in them to ' +
      'retain — #77’s rollups, which name no partner and no buyer.',
  },
};

/** Every class a sweep deletes, derived. */
export const REFERRAL_SWEPT_RETENTION_CLASSES: readonly ReferralRetentionClass[] =
  REFERRAL_RETENTION_CLASSES.filter(
    (cls) => REFERRAL_RETENTION_POLICY[cls].sweptAfterDays !== null,
  );

/** Every class retained with the financial record, derived. */
export const REFERRAL_FINANCIAL_RETENTION_CLASSES: readonly ReferralRetentionClass[] =
  REFERRAL_RETENTION_CLASSES.filter(
    (cls) => REFERRAL_RETENTION_POLICY[cls].sweptAfterDays === null,
  );
