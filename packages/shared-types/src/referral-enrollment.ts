/**
 * Referral partner ENROLLMENT: modes, the application, its review, and terms
 * acceptance (#146 increment 2, ADR 0005 D2/D15).
 *
 * #142 shipped the partner RECORD and its five standing states with no HTTP
 * surface at all. What this adds is everything between a stranger and an
 * approved partner: which door they came through, what they told Mercaria, what
 * a reviewer decided and on which revision, and which terms they accepted.
 *
 * ## Standing and submission are two questions, and they get two homes
 *
 * `referral_partners.state` is the STANDING — what this owner may do right now.
 * `referral_partner_applications.state` is what happened to one SUBMISSION. They
 * are not two representations of one fact: a partner whose first application was
 * rejected and whose second was approved has two application rows and one
 * standing, and asking "why was I rejected in March" is a question only the
 * application can answer. The partner's standing MOVES with the decision, in the
 * same transaction, so nothing can read one without the other.
 *
 * ## A rejection a partner reads is not a rejection an operator wrote
 *
 * #146 review rule 9: "Do not reveal sensitive risk signals in ordinary
 * rejection copy." That is held by TWO FIELDS with two audiences rather than by
 * a redaction somebody remembers — {@link ReferralApplicationRejectionCode} is a
 * closed set with no member that could name a risk signal, a velocity threshold
 * or another partner, and the reviewer's free-text reason has no field on the
 * partner-facing projection to arrive in. The `MerchantOrder` device: a
 * different TYPE, not a filtered one.
 *
 * ## This domain grants NOTHING
 *
 * #146 review rule 7: "Grant no store, merchant, payment or Oxy administrative
 * permissions." {@link REFERRAL_ENROLLMENT_FORBIDDEN_GRANTS} names that as
 * VALUES a gate scans for, and the stronger half is structural: the store half
 * of the partner surface is mounted UNDER `/admin/stores/:storeId`, so the
 * question "may this Oxy account act for this store" is answered by
 * `requireStorePermission('store:manage')` before any referral module runs.
 * There is no second answer to it anywhere in this domain, and the gate fails
 * the build if one appears.
 */

import type { ReferralPartnerOwnerType, ReferralPromotionMethod } from './referral.js';

// ─── Enrollment modes (#146 "Enrollment modes", 8 items) ────────────────────

/**
 * Which door a partner came through.
 *
 * Every one of #146's eight modes, and the mode is a stored fact about the
 * record rather than a branch in a service: what differs between them is
 * decided by {@link REFERRAL_ENROLLMENT_MODE_RULES}, a TABLE the state machine
 * reads. `claim-methods.ts` (#83) took that decision for verification methods
 * and the reasoning transfers without change — a service that asks "is the mode
 * `staff_test`" is a service that will one day ask it in only three of the four
 * places it matters.
 */
export type ReferralEnrollmentMode =
  | 'open_application'
  | 'invite_only'
  | 'oxy_self_enrollment'
  | 'verified_organization'
  | 'creator_community_review'
  | 'merchant_referral'
  | 'staff_test'
  | 'operator_legacy';

/** {@link ReferralEnrollmentMode} as the tuple the column and its CHECK read. */
export const REFERRAL_ENROLLMENT_MODES: readonly ReferralEnrollmentMode[] = [
  'open_application',
  'invite_only',
  'oxy_self_enrollment',
  'verified_organization',
  'creator_community_review',
  'merchant_referral',
  'staff_test',
  'operator_legacy',
];

/** Everything that differs between one enrollment mode and another. */
export interface ReferralEnrollmentModeRule {
  /**
   * Which owner kinds may enroll this way. A `store` cannot come through
   * `oxy_self_enrollment` (there is no Oxy account to self-enrol) and a `user`
   * cannot come through `merchant_referral` (a person operates no shop).
   */
  readonly eligibleOwnerTypes: readonly ReferralPartnerOwnerType[];
  /**
   * Whether an APPLICANT may name this mode on their own application. False
   * means only an operator may create a record in it — which is what makes
   * `staff_test` unreachable from the partner surface rather than merely
   * discouraged there.
   */
  readonly selfServe: boolean;
  /**
   * Whether a submission needs a human decision before the partner is approved.
   * False means the operator who created the record IS the review, so there is
   * nobody left to ask.
   */
  readonly requiresOperatorReview: boolean;
  /**
   * Whether creating a record in this mode requires the operator to state their
   * evidence. #146 enrollment mode 8: "Operator-created legacy or contractual
   * partner with explicit evidence."
   */
  readonly requiresOperatorEvidence: boolean;
  /**
   * Whether rewards earned under this mode may leave Mercaria as real money.
   *
   * #146 enrollment mode 7: "Staff or test enrollment isolated from production
   * earnings." The isolation is applied at the PAYOUT gate rather than at
   * attribution, deliberately: refusing attribution would make a test
   * enrollment unable to exercise the thing it exists to test, while blocking
   * the payout is the point at which real money would otherwise move.
   */
  readonly earnsProductionRewards: boolean;
}

/**
 * The per-mode contract, as a `Record` over the union so a mode added to the
 * tuple and not described here fails `tsc`.
 */
export const REFERRAL_ENROLLMENT_MODE_RULES: Readonly<
  Record<ReferralEnrollmentMode, ReferralEnrollmentModeRule>
> = {
  open_application: {
    eligibleOwnerTypes: ['user', 'store'],
    selfServe: true,
    requiresOperatorReview: true,
    requiresOperatorEvidence: false,
    earnsProductionRewards: true,
  },
  invite_only: {
    eligibleOwnerTypes: ['user', 'store'],
    selfServe: false,
    requiresOperatorReview: false,
    requiresOperatorEvidence: false,
    earnsProductionRewards: true,
  },
  oxy_self_enrollment: {
    eligibleOwnerTypes: ['user'],
    selfServe: true,
    requiresOperatorReview: true,
    requiresOperatorEvidence: false,
    earnsProductionRewards: true,
  },
  verified_organization: {
    eligibleOwnerTypes: ['store'],
    selfServe: false,
    requiresOperatorReview: true,
    requiresOperatorEvidence: true,
    earnsProductionRewards: true,
  },
  creator_community_review: {
    eligibleOwnerTypes: ['user'],
    selfServe: true,
    requiresOperatorReview: true,
    requiresOperatorEvidence: false,
    earnsProductionRewards: true,
  },
  merchant_referral: {
    eligibleOwnerTypes: ['store'],
    selfServe: true,
    requiresOperatorReview: true,
    requiresOperatorEvidence: false,
    earnsProductionRewards: true,
  },
  staff_test: {
    eligibleOwnerTypes: ['user', 'store'],
    selfServe: false,
    requiresOperatorReview: false,
    requiresOperatorEvidence: false,
    earnsProductionRewards: false,
  },
  operator_legacy: {
    eligibleOwnerTypes: ['user', 'store'],
    selfServe: false,
    requiresOperatorReview: false,
    requiresOperatorEvidence: true,
    earnsProductionRewards: true,
  },
};

// ─── The application (#146 "Application", 10 items) ─────────────────────────

/**
 * One SUBMISSION's lifecycle.
 *
 * `withdrawn` is the applicant's own exit and has no counterpart in #146's list
 * because #146 lists REVIEW states; somebody closing their own application is
 * not a decision anybody made about them, and collapsing it into `rejected`
 * would put a refusal on a record nobody refused.
 */
export type ReferralApplicationState =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'changes_requested'
  | 'withdrawn';

/** {@link ReferralApplicationState} as the tuple the column and its CHECK read. */
export const REFERRAL_APPLICATION_STATES: readonly ReferralApplicationState[] = [
  'draft',
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'changes_requested',
  'withdrawn',
];

/**
 * The states in which an applicant may still EDIT their answers.
 *
 * A trigger freezes the content columns outside this set, which is #59's rule
 * that the set an operator approved is the set that executes — applied to an
 * application rather than to a merge plan. Derived by containment from the
 * tuple rather than written out twice.
 */
export const REFERRAL_APPLICATION_EDITABLE_STATES: readonly ReferralApplicationState[] = [
  'draft',
  'changes_requested',
];

/** A reviewer's verdict on one revision. */
export type ReferralApplicationDecision = 'approved' | 'rejected' | 'changes_requested';

/** {@link ReferralApplicationDecision} as the tuple the column and its CHECK read. */
export const REFERRAL_APPLICATION_DECISIONS: readonly ReferralApplicationDecision[] = [
  'approved',
  'rejected',
  'changes_requested',
];

/**
 * What a REJECTED or CHANGES-REQUESTED applicant is told, and the whole of it.
 *
 * Closed, and every member is a fact about the APPLICATION rather than about
 * Mercaria's opinion of the person. There is deliberately no `suspected_fraud`,
 * no `velocity`, no `risk_score` and no `related_to_terminated_partner` member:
 * #146 review rule 9 asks that ordinary rejection copy reveal no sensitive risk
 * signal, and the strongest form of that is a vocabulary in which none is
 * expressible. A reviewer's own reasoning goes in
 * `referral_partner_application_reviews.reviewer_note`, which no partner-facing
 * projection reads.
 */
export type ReferralApplicationRejectionCode =
  | 'incomplete_information'
  | 'ineligible_market'
  | 'ineligible_owner_type'
  | 'prohibited_promotion_method'
  | 'duplicate_partner_identity'
  | 'policy_violation'
  | 'not_accepting_applications'
  | 'other';

/** {@link ReferralApplicationRejectionCode} as the tuple the column and its CHECK read. */
export const REFERRAL_APPLICATION_REJECTION_CODES: readonly ReferralApplicationRejectionCode[] = [
  'incomplete_information',
  'ineligible_market',
  'ineligible_owner_type',
  'prohibited_promotion_method',
  'duplicate_partner_identity',
  'policy_violation',
  'not_accepting_applications',
  'other',
];

/**
 * Signals a partner-facing decision may NEVER carry, named as values so a gate
 * can scan for them.
 *
 * DISJOINT from {@link REFERRAL_APPLICATION_REJECTION_CODES} by a test. These
 * are the seven things a rejection would most plausibly want to say and the
 * seven a rejected applicant must not be able to read back — the last two
 * because they are facts about somebody ELSE.
 */
export const REFERRAL_APPLICATION_FORBIDDEN_DISCLOSURES: readonly string[] = [
  'risk_score',
  'fraud_signal',
  'velocity_threshold',
  'device_match',
  'payment_instrument_match',
  'matched_partner_display_name',
  'matched_partner_owner_id',
];

/**
 * How large an audience an applicant says they reach.
 *
 * BANDS rather than a number, and that is a privacy decision rather than a
 * usability one: an exact follower count plus a promotion URL identifies an
 * account, and Mercaria has no use for the precision — the only question a
 * reviewer asks of it is which order of magnitude.
 */
export type ReferralAudienceBand =
  | 'under_1k'
  | 'from_1k_to_10k'
  | 'from_10k_to_100k'
  | 'over_100k'
  | 'not_stated';

/** {@link ReferralAudienceBand} as the tuple the column and its CHECK read. */
export const REFERRAL_AUDIENCE_BANDS: readonly ReferralAudienceBand[] = [
  'under_1k',
  'from_1k_to_10k',
  'from_10k_to_100k',
  'over_100k',
  'not_stated',
];

/** Where one of #146's ten application items is actually collected. */
export type ReferralApplicationItemSource =
  /** A column on `referral_partner_applications`. */
  | 'application'
  /** A column on `referral_partners` — a fact about the record, not the submission. */
  | 'partner'
  /** `referral_tax_profiles` (ADR 0005 D15 gate 2). */
  | 'tax_questionnaire'
  /** Oxy owns it, and Mercaria mirrors none of it (ADR 0003 D15). */
  | 'oxy_identity'
  /** Deliberately not collected — `reason` says why. */
  | 'not_collected';

/** One of #146's ten application items, and where it landed. */
export interface ReferralApplicationItem {
  /** The item's number in #146's "Application" list, 1-based. */
  readonly item: number;
  readonly label: string;
  readonly source: ReferralApplicationItemSource;
  /**
   * The SQL column carrying it, when `source` names a table. A census test
   * asserts the column exists, so a renamed column fails the build rather than
   * leaving a map that quietly points nowhere.
   */
  readonly column?: string;
  /** Required when `source` is `not_collected`, and read by nothing else. */
  readonly reason?: string;
}

/**
 * Where each of #146's ten application items is collected.
 *
 * A hand-maintained map is only a gate if being in NEITHER half fails, so the
 * census test asserts all ten numbers are present exactly once AND that every
 * named column exists on its table (#85's requirements-registry device). Two of
 * the ten are deliberately elsewhere and one is deliberately nowhere, each with
 * its reason stated here rather than in a commit message.
 */
export const REFERRAL_APPLICATION_ITEMS: readonly ReferralApplicationItem[] = [
  {
    item: 1,
    label: 'Oxy identity or verified organization',
    source: 'oxy_identity',
    reason:
      'The record\'s owner IS the identity: a `user` partner is an Oxy account the ' +
      'request authenticated as, and a `store` partner is a store the caller holds ' +
      '`store:manage` on. Copying either into this domain would be the profile mirror ' +
      'ADR 0003 D15 says does not exist.',
  },
  {
    item: 2,
    label: 'Public display name and promotion channels',
    source: 'partner',
    column: 'display_name',
  },
  {
    item: 3,
    label: 'Website or profile links',
    source: 'application',
    column: 'promotion_urls',
  },
  {
    item: 4,
    label: 'Expected audience and markets',
    source: 'application',
    column: 'audience_band',
  },
  {
    item: 5,
    label: 'Declared promotion methods',
    source: 'application',
    column: 'promotion_methods',
  },
  {
    item: 6,
    label: 'Country and participant type',
    source: 'tax_questionnaire',
    column: 'residency_country',
    reason:
      'ADR 0005 D15 gate 2 already asks exactly this, and #146\'s own application rule ' +
      'says not to collect tax-shaped data in a general profile form. A second country ' +
      'and a second participant-type enum here would be two representations of one ' +
      'fact, and the one that decides a payout would not be the one on the form.',
  },
  {
    item: 7,
    label: 'Agreement to prohibited-method rules',
    source: 'application',
    column: 'prohibited_methods_acknowledged',
  },
  {
    item: 8,
    label: 'Conflicts or related-party declarations where required',
    source: 'application',
    column: 'related_party_disclosure',
  },
  {
    item: 9,
    label: 'Program-specific questions',
    source: 'not_collected',
    reason:
      'No program publishes any. A question table with no published questions is a ' +
      'surface for content nobody shipped, and a `jsonb` answer bag is the mechanism ' +
      'by which an address reaches production (#77). When a program defines its first ' +
      'question it arrives as a code-constant registry beside the terms, the way the ' +
      'tax questionnaire\'s declarations do.',
  },
  {
    item: 10,
    label: 'Consent to review and communication',
    source: 'application',
    column: 'review_consent_at',
  },
];

// ─── Terms acceptance (#146 "Terms acceptance", 10 items) ───────────────────

/**
 * WHICH terms were accepted.
 *
 * Two scopes because there are genuinely two documents: Mercaria's partner
 * agreement, which an owner accepts once and re-accepts when it changes, and a
 * PROGRAM version's own terms, which #142 already stamps on every program row
 * and which #146 terms rule 1 asks be presented exactly. Folding them together
 * would make "has this partner accepted the current terms" unanswerable for
 * whichever one the reader did not mean.
 */
export type ReferralTermsScope = 'partner_agreement' | 'program_terms';

/** {@link ReferralTermsScope} as the tuple the column and its CHECK read. */
export const REFERRAL_TERMS_SCOPES: readonly ReferralTermsScope[] = [
  'partner_agreement',
  'program_terms',
];

/**
 * The published versions of Mercaria's referral partner agreement, oldest
 * first.
 *
 * A tuple in shared-types because the column's CHECK is rendered from it (the
 * `ALL_CURRENCY_CODES` device), so an acceptance citing a version nobody
 * published has no row shape. The agreement's TEXT is a code constant in the
 * backend (`services/referrals/partner-agreement.ts`) — the tax questionnaire's
 * decision one document over, for the same reason: a table would let somebody
 * publish an agreement nobody shipped, and real acceptances would then cite it
 * as what those partners agreed to.
 */
export type ReferralPartnerAgreementVersion = 'partner-2026-08';

/** {@link ReferralPartnerAgreementVersion} as a tuple, oldest first. */
export const REFERRAL_PARTNER_AGREEMENT_VERSIONS: readonly ReferralPartnerAgreementVersion[] = [
  'partner-2026-08',
];

/**
 * The agreement version an acceptance must cite to satisfy the gate today.
 *
 * Bumping this SCHEDULES a re-acceptance rather than performing one: every
 * partner whose latest acceptance cites an older version reads
 * `terms_acceptance_pending` at the next derivation, with no sweep having run.
 * #146 terms rule 5 is then free — earlier acceptances stay exactly as they
 * were made, and #144's reward rows already snapshot the terms they accrued
 * under, so a bump can never reinterpret an earning.
 */
export const REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION: ReferralPartnerAgreementVersion =
  'partner-2026-08';

// ─── What a partner surface may read ────────────────────────────────────────

/**
 * One application, as its own applicant may see it.
 *
 * Every field named, nothing spread (the `ProviderAccountStatus` precedent).
 * The reviewer's identity and free-text note are ABSENT rather than filtered:
 * a projection that spread the row would carry both the day somebody added a
 * column, and #146 review rule 9 is exactly what that would break.
 */
export interface ReferralApplicationPartnerView {
  id: string;
  revision: number;
  state: ReferralApplicationState;
  enrollmentMode: ReferralEnrollmentMode;
  programId?: string;
  promotionMethods: readonly ReferralPromotionMethod[];
  promotionUrls: readonly string[];
  audienceBand: ReferralAudienceBand;
  /** ISO 3166-1 alpha-2, upper case. */
  markets: readonly string[];
  prohibitedMethodsAcknowledged: boolean;
  hasRelatedParty: boolean;
  relatedPartyDisclosure?: string;
  /** ISO-8601, when given. */
  reviewConsentAt?: string;
  /** ISO-8601, when given. */
  communicationConsentAt?: string;
  /** ISO-8601, when submitted. */
  submittedAt?: string;
  /** ISO-8601, when a reviewer decided. */
  decidedAt?: string;
  /** The closed code — never the reviewer's own words. */
  decisionCode?: ReferralApplicationRejectionCode;
  /** The bounded, partner-safe sentence a reviewer chose from that code. */
  decisionMessage?: string;
}

/** One accepted terms document, as its partner may see it. */
export interface ReferralTermsAcceptanceView {
  scope: ReferralTermsScope;
  termsVersion: string;
  programId?: string;
  /** ISO-8601. */
  acceptedAt: string;
  /** BCP-47, as the accepting client declared it. */
  locale: string;
}

/** What a partner still owes before anything can be paid. */
export type ReferralPartnerOutstandingItem =
  | 'application_not_submitted'
  | 'application_under_review'
  | 'application_changes_requested'
  | 'partner_agreement_not_accepted'
  | 'partner_agreement_superseded'
  | 'tax_questionnaire_not_completed'
  | 'identity_verification_not_ready'
  | 'payout_destination_not_ready'
  | 'partner_suspended'
  | 'partner_terminated'
  | 'enrollment_is_test_only';

/** {@link ReferralPartnerOutstandingItem} as a tuple. */
export const REFERRAL_PARTNER_OUTSTANDING_ITEMS: readonly ReferralPartnerOutstandingItem[] = [
  'application_not_submitted',
  'application_under_review',
  'application_changes_requested',
  'partner_agreement_not_accepted',
  'partner_agreement_superseded',
  'tax_questionnaire_not_completed',
  'identity_verification_not_ready',
  'payout_destination_not_ready',
  'partner_suspended',
  'partner_terminated',
  'enrollment_is_test_only',
];

/**
 * Permissions and grants enrollment may NEVER produce, named as values so a
 * gate can scan for them (#146 review rule 7).
 *
 * The scan is over the enrollment domain's own source, and its point is the
 * direction nobody would notice: approving a partner is the natural place for
 * somebody to also "just" add them to the store they named, and every one of
 * these is a capability an approval must not be able to hand out.
 */
export const REFERRAL_ENROLLMENT_FORBIDDEN_GRANTS: readonly string[] = [
  'store_permission',
  'store_membership',
  'merchant_claim',
  'payment_onboarding',
  'oxy_administrative_role',
  'operator_allow_list',
];
