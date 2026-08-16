/**
 * What a partner sees about their own standing, and what they still owe (#146
 * increment 2 + the "Earning versus withdrawal readiness" group).
 *
 * ## Earning and WITHDRAWAL are shown as two different answers
 *
 * #146 asks for both — "clearly show whether earning has started" and "clearly
 * show why withdrawal is blocked" — and they are genuinely different questions
 * with different inputs. Earning is the partner's STANDING plus the program's
 * attribution lever; withdrawal is ADR 0005 D15's three gates. Collapsing them
 * into one progress bar is what makes a partner think their accrued balance is
 * at risk because a form is unfinished, which it is not: nothing is lost and
 * nothing expires while they complete it, and the copy says so.
 *
 * ## The outstanding list is DERIVED and collects EVERY reason
 *
 * Never short-circuited. A partner asking why they cannot be paid deserves the
 * whole answer — a first-reason-wins derivation sends them round the loop once
 * per missing item, which is the same argument `deriveRewardPayability` makes
 * one layer down, and the reason this collects every reason into one list
 * rather than returning the first thing it finds wrong.
 *
 * ## The three readiness verdicts are DERIVED here, not read off the row
 *
 * The first version of this file read the three stored columns, on the
 * `onboarding_state` "one stored verdict" reasoning — and the real-server suite
 * refused it immediately, for a reason worth keeping: a partner who had just
 * completed the tax questionnaire read `tax.readiness: 'ready'` and
 * `outstanding: ['tax_questionnaire_not_completed']` IN THE SAME RESPONSE,
 * because the derivation and the stored observation are two answers and nothing
 * had synced the second.
 *
 * So this takes `payout-batch.service.ts`'s posture, which increment 1 already
 * states at its own call site: the stored triple is an OBSERVATION of what the
 * derivation last said, `recordPartnerReadinessObservation` is its only writer,
 * and every reader that must be right derives live. That is the
 * `deriveNativeCheckoutEligibility` divergence taken for the reason the rule
 * itself gives — the inputs sit on tables this domain does not own and move
 * without anybody touching the partner. The surface a partner reads before
 * asking why they were not paid is exactly where a stale flag must not be.
 */

import {
  REFERRAL_ACTIVE_TAX_QUESTIONNAIRE_VERSION,
  REFERRAL_ENROLLMENT_MODE_RULES,
  type ReferralApplicationPartnerView,
  type ReferralEnrollmentMode,
  type ReferralPartnerOutstandingItem,
  type ReferralPartnerOwnerType,
  type ReferralReadinessSummary,
  type ReferralTermsAcceptanceView,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findLiveApplication,
  listApplicationsForPartner,
  type ReferralApplicationRow,
} from '../../db/referrals/applicationRepository.js';
import { findPartnerByOwner } from '../../db/referrals/partnerRepository.js';
import { readReferralPartnerReadiness } from './earnings/partner-readiness.port.js';
import { deriveAgreementStanding, readTermsAcceptances } from './terms.service.js';
import { activeReferralPartnerAgreement } from './partner-agreement.js';
import { readTaxProfile, type ReferralTaxProfileView } from './tax-profile.service.js';

/**
 * The projection an application surface reads. Every field named.
 *
 * The reviewer's identity and free-text note have NO field here, which is how
 * #146 review rule 9 is held: a projection that spread the row would carry both
 * the day somebody added a column.
 */
export function toReferralApplicationPartnerView(
  row: ReferralApplicationRow,
): ReferralApplicationPartnerView {
  return {
    id: row.id,
    revision: row.revision,
    state: row.state,
    enrollmentMode: row.enrollmentMode,
    ...(row.programId !== null ? { programId: row.programId } : {}),
    promotionMethods: row.promotionMethods as ReferralApplicationPartnerView['promotionMethods'],
    promotionUrls: row.promotionUrls,
    audienceBand: row.audienceBand,
    markets: row.markets,
    prohibitedMethodsAcknowledged: row.prohibitedMethodsAcknowledged,
    hasRelatedParty: row.hasRelatedParty,
    ...(row.relatedPartyDisclosure !== null
      ? { relatedPartyDisclosure: row.relatedPartyDisclosure }
      : {}),
    ...(row.reviewConsentAt !== null ? { reviewConsentAt: row.reviewConsentAt.toISOString() } : {}),
    ...(row.communicationConsentAt !== null
      ? { communicationConsentAt: row.communicationConsentAt.toISOString() }
      : {}),
    ...(row.submittedAt !== null ? { submittedAt: row.submittedAt.toISOString() } : {}),
    ...(row.decidedAt !== null ? { decidedAt: row.decidedAt.toISOString() } : {}),
    ...(row.decisionCode !== null ? { decisionCode: row.decisionCode } : {}),
    ...(row.decisionMessage !== null ? { decisionMessage: row.decisionMessage } : {}),
  };
}

/** The facts the outstanding derivation reads, and the whole of them. */
export interface PartnerStandingFacts {
  partnerState: string;
  enrollmentMode: ReferralEnrollmentMode;
  applicationState: string | undefined;
  agreementStanding: 'accepted' | 'superseded' | 'missing';
  identityReadiness: ReferralReadinessSummary;
  taxReadiness: ReferralReadinessSummary;
  payoutReadiness: ReferralReadinessSummary;
}

/**
 * Everything standing between this partner and a payout, collected.
 *
 * PURE, so the rule is testable without a database and there is one spelling of
 * it. Order is deliberate: what the PARTNER can act on first, what somebody
 * else owes them last.
 */
export function deriveOutstandingItems(
  facts: PartnerStandingFacts,
): readonly ReferralPartnerOutstandingItem[] {
  const items: ReferralPartnerOutstandingItem[] = [];

  if (facts.partnerState === 'terminated') items.push('partner_terminated');
  else if (facts.partnerState === 'suspended') items.push('partner_suspended');

  switch (facts.applicationState) {
    case 'approved':
      break;
    case 'changes_requested':
      items.push('application_changes_requested');
      break;
    case 'submitted':
    case 'under_review':
      items.push('application_under_review');
      break;
    default:
      items.push('application_not_submitted');
      break;
  }

  if (facts.agreementStanding === 'missing') items.push('partner_agreement_not_accepted');
  else if (facts.agreementStanding === 'superseded') items.push('partner_agreement_superseded');

  if (facts.taxReadiness !== 'ready') items.push('tax_questionnaire_not_completed');
  if (facts.identityReadiness !== 'ready') items.push('identity_verification_not_ready');
  if (facts.payoutReadiness !== 'ready') items.push('payout_destination_not_ready');

  if (!REFERRAL_ENROLLMENT_MODE_RULES[facts.enrollmentMode].earnsProductionRewards) {
    items.push('enrollment_is_test_only');
  }

  return items;
}

/**
 * Whether NEW referrals are being credited to this partner right now.
 *
 * #146 "Earning versus withdrawal readiness" item 1. Deliberately narrower than
 * the outstanding list: earning starts at approval and stops at suspension, and
 * none of the payout gates touches it — which is exactly ADR 0005 D15's rule
 * that a participant may accrue before payout onboarding is complete.
 *
 * The PROGRAM's own attribution lever can also stop it, and is not read here:
 * it is per program and this answer is per partner, so a surface that needs it
 * asks `/internal/referrals/programs/:programId/controls`. Reading one program's
 * lever into a partner-wide boolean would be wrong for a partner in two.
 */
export function deriveEarningStarted(facts: PartnerStandingFacts): boolean {
  return facts.partnerState === 'approved';
}

/** Everything a partner surface renders about itself. */
export interface ReferralPartnerStanding {
  partner?: {
    id: string;
    displayName: string;
    ownerType: ReferralPartnerOwnerType;
    state: string;
    enrollmentMode: ReferralEnrollmentMode;
    appealState: string;
    identityReadiness: ReferralReadinessSummary;
    taxReadiness: ReferralReadinessSummary;
    payoutReadiness: ReferralReadinessSummary;
    /** Whether Mercaria may market to this partner. Never a terms acceptance. */
    marketingConsent: boolean;
  };
  application?: ReferralApplicationPartnerView;
  /** Every application ever made, newest first — the reconsideration history. */
  history: readonly ReferralApplicationPartnerView[];
  agreement: {
    standing: 'accepted' | 'superseded' | 'missing';
    requiredVersion: string;
    terms: ReturnType<typeof activeReferralPartnerAgreement>;
    acceptances: readonly ReferralTermsAcceptanceView[];
  };
  tax: ReferralTaxProfileView;
  earningStarted: boolean;
  outstanding: readonly ReferralPartnerOutstandingItem[];
}

/**
 * The whole partner-facing read for one owner.
 *
 * Answers with `partner: undefined` rather than 404 when this owner has never
 * enrolled: "you are not a partner yet, here is what you would be agreeing to"
 * is the state the enrollment surface has to render, and a 404 would make the
 * first screen of the flow an error.
 */
export async function readPartnerStanding(
  input: { ownerType: ReferralPartnerOwnerType; ownerId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralPartnerStanding> {
  const partner = await findPartnerByOwner(db, input);
  const agreementTerms = activeReferralPartnerAgreement();

  if (!partner) {
    return {
      history: [],
      agreement: {
        standing: 'missing',
        requiredVersion: agreementTerms.version,
        terms: agreementTerms,
        acceptances: [],
      },
      tax: {
        profile: undefined,
        // `pending`, never `unknown`: `deriveTaxReadiness` answers exactly this
        // for a partner with no declaration, and an owner with no partner
        // record has none by definition. `unknown` means "nobody has looked",
        // which is what makes #142's column default block — and it would be a
        // lie here, because this read IS looking.
        readiness: 'pending',
        requiredQuestionnaireVersion: REFERRAL_ACTIVE_TAX_QUESTIONNAIRE_VERSION,
      },
      earningStarted: false,
      outstanding: ['application_not_submitted', 'partner_agreement_not_accepted'],
    };
  }

  const [live, all, acceptances, tax, readiness] = await Promise.all([
    findLiveApplication(db, partner.id),
    listApplicationsForPartner(db, partner.id),
    readTermsAcceptances(partner.id, db),
    readTaxProfile(partner.id),
    readReferralPartnerReadiness({
      partnerId: partner.id,
      ownerType: partner.ownerType,
      ownerId: partner.ownerId,
    }),
  ]);

  const facts: PartnerStandingFacts = {
    partnerState: partner.state,
    enrollmentMode: partner.enrollmentMode,
    applicationState: live?.state,
    agreementStanding: deriveAgreementStanding(partner),
    // All three DERIVED, through the same port and the same tax derivation the
    // batch builder uses — see the docblock. Reading the stored columns here
    // put two answers to one question inside a single response.
    identityReadiness: readiness.identity,
    taxReadiness: tax.readiness,
    payoutReadiness: readiness.payout,
  };

  return {
    partner: {
      id: partner.id,
      displayName: partner.displayName,
      ownerType: partner.ownerType,
      state: partner.state,
      enrollmentMode: partner.enrollmentMode,
      appealState: partner.appealState,
      identityReadiness: facts.identityReadiness,
      taxReadiness: facts.taxReadiness,
      payoutReadiness: facts.payoutReadiness,
      marketingConsent: partner.marketingConsentAt !== null,
    },
    ...(live !== undefined ? { application: toReferralApplicationPartnerView(live) } : {}),
    history: all.map(toReferralApplicationPartnerView),
    agreement: {
      standing: facts.agreementStanding,
      requiredVersion: agreementTerms.version,
      terms: agreementTerms,
      acceptances,
    },
    tax,
    earningStarted: deriveEarningStarted(facts),
    outstanding: deriveOutstandingItems(facts),
  };
}
