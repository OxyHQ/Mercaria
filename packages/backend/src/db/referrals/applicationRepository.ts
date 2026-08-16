/**
 * Reads and writes for `referral_partner_applications` and its append-only
 * decision trail (#146 increment 2).
 *
 * Every state move is a single-statement CAS from an expected SET, the
 * `transitionPartnerState` shape — so "approve a submitted application" cannot
 * approve one an operator rejected between the read and the write, and the
 * `undefined` return is an ordinary refusal the caller maps rather than an
 * error.
 *
 * The content UPDATE is deliberately NOT guarded here beyond its CAS: the
 * database's own `mercaria_referral_application_content_freeze` trigger is what
 * makes "answers cannot move once submitted" true against a service bug, a
 * replay and `psql` alike. A repository check would be a second, weaker
 * spelling of it.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  ReferralApplicationDecision,
  ReferralApplicationRejectionCode,
  ReferralApplicationState,
  ReferralAudienceBand,
  ReferralEnrollmentMode,
  ReferralPromotionMethod,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  referralPartnerApplicationReviews,
  referralPartnerApplications,
} from '../schema/referrals.js';

/** One application row as the services read it back. */
export type ReferralApplicationRow = typeof referralPartnerApplications.$inferSelect;

/** One decision row as the services read it back. */
export type ReferralApplicationReviewRow = typeof referralPartnerApplicationReviews.$inferSelect;

/** The answers an applicant supplies, and the whole of them. */
export interface ReferralApplicationAnswers {
  promotionMethods: readonly ReferralPromotionMethod[];
  promotionUrls: readonly string[];
  audienceBand: ReferralAudienceBand;
  markets: readonly string[];
  prohibitedMethodsAcknowledged: boolean;
  hasRelatedParty: boolean;
  relatedPartyDisclosure: string | null;
  reviewConsentAt: Date | null;
  communicationConsentAt: Date | null;
  programId: string | null;
}

/**
 * The application a partner currently has open, if any.
 *
 * "Open" is the same set the partial unique covers, so this read and that index
 * cannot disagree about what "already has one" means.
 */
export const LIVE_APPLICATION_STATES: readonly ReferralApplicationState[] = [
  'draft',
  'submitted',
  'under_review',
  'changes_requested',
  'approved',
];

export async function findLiveApplication(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<ReferralApplicationRow | undefined> {
  const [row] = await db
    .select()
    .from(referralPartnerApplications)
    .where(
      and(
        eq(referralPartnerApplications.partnerId, partnerId),
        inArray(referralPartnerApplications.state, [...LIVE_APPLICATION_STATES]),
      ),
    );
  return row;
}

export async function findApplicationById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralApplicationRow | undefined> {
  const [row] = await db
    .select()
    .from(referralPartnerApplications)
    .where(eq(referralPartnerApplications.id, id));
  return row;
}

/**
 * The partner's MOST RECENT application, whatever state it is in.
 *
 * Distinct from `findLiveApplication` and the distinction is load-bearing: a
 * decision has to be able to find the application it just decided, and
 * `rejected` and `withdrawn` are outside the live set by design. A reviewer
 * retrying a rejection would otherwise be told "no application to decide" while
 * an identical retry of an approval converged — one operation, two answers,
 * decided by which verdict was reached first.
 */
export async function findLatestApplication(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<ReferralApplicationRow | undefined> {
  const [row] = await db
    .select()
    .from(referralPartnerApplications)
    .where(eq(referralPartnerApplications.partnerId, partnerId))
    .orderBy(desc(referralPartnerApplications.createdAt), desc(referralPartnerApplications.id))
    .limit(1);
  return row;
}

/** One decision on one revision, if it has been made. */
export async function findApplicationReview(
  db: DatabaseOrTransaction,
  input: { applicationId: string; revision: number },
): Promise<ReferralApplicationReviewRow | undefined> {
  const [row] = await db
    .select()
    .from(referralPartnerApplicationReviews)
    .where(
      and(
        eq(referralPartnerApplicationReviews.applicationId, input.applicationId),
        eq(referralPartnerApplicationReviews.revision, input.revision),
      ),
    );
  return row;
}

/** Every application this partner has ever made, newest first. */
export async function listApplicationsForPartner(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<readonly ReferralApplicationRow[]> {
  return await db
    .select()
    .from(referralPartnerApplications)
    .where(eq(referralPartnerApplications.partnerId, partnerId))
    .orderBy(desc(referralPartnerApplications.createdAt), desc(referralPartnerApplications.id));
}

/**
 * Open a DRAFT.
 *
 * `onConflictDoNothing` on the partial unique plus a re-read — the
 * `insertPartner` shape, and the `ON CONFLICT` must repeat the index's own
 * predicate or Postgres cannot infer the arbiter (the `ensureCart` finding).
 */
export async function insertDraftApplication(
  db: DatabaseOrTransaction,
  input: {
    partnerId: string;
    enrollmentMode: ReferralEnrollmentMode;
    answers: ReferralApplicationAnswers;
  },
): Promise<{ row: ReferralApplicationRow; created: boolean }> {
  const [inserted] = await db
    .insert(referralPartnerApplications)
    .values({
      partnerId: input.partnerId,
      enrollmentMode: input.enrollmentMode,
      state: 'draft',
      revision: 1,
      programId: input.answers.programId,
      promotionMethods: [...input.answers.promotionMethods],
      promotionUrls: [...input.answers.promotionUrls],
      audienceBand: input.answers.audienceBand,
      markets: [...input.answers.markets],
      prohibitedMethodsAcknowledged: input.answers.prohibitedMethodsAcknowledged,
      hasRelatedParty: input.answers.hasRelatedParty,
      relatedPartyDisclosure: input.answers.relatedPartyDisclosure,
      reviewConsentAt: input.answers.reviewConsentAt,
      communicationConsentAt: input.answers.communicationConsentAt,
    })
    .onConflictDoNothing({
      target: referralPartnerApplications.partnerId,
      // The partial index's OWN predicate, repeated. Postgres cannot infer a
      // partial unique as the arbiter without it and the insert would 500 —
      // the `ensureCart` finding, and the reason every `ON CONFLICT` in this
      // repository against a partial unique carries one.
      where: inArray(referralPartnerApplications.state, [...LIVE_APPLICATION_STATES]),
    })
    .returning();
  if (inserted) return { row: inserted, created: true };

  const existing = await findLiveApplication(db, input.partnerId);
  if (!existing) {
    throw new Error(
      `referral_partner_applications insert for partner ${input.partnerId} conflicted with a row ` +
        'that then could not be read back.',
    );
  }
  return { row: existing, created: false };
}

/**
 * Replace an EDITABLE application's answers.
 *
 * The CAS names the two editable states rather than trusting a read, and the
 * trigger refuses the write anyway if the state moved underneath it — belt and
 * braces on purpose, because the CAS answers `undefined` (a refusal a caller
 * maps to a 409) where the trigger raises.
 */
export async function updateApplicationAnswers(
  db: DatabaseOrTransaction,
  input: { id: string; answers: ReferralApplicationAnswers },
): Promise<ReferralApplicationRow | undefined> {
  const [row] = await db
    .update(referralPartnerApplications)
    .set({
      programId: input.answers.programId,
      promotionMethods: [...input.answers.promotionMethods],
      promotionUrls: [...input.answers.promotionUrls],
      audienceBand: input.answers.audienceBand,
      markets: [...input.answers.markets],
      prohibitedMethodsAcknowledged: input.answers.prohibitedMethodsAcknowledged,
      hasRelatedParty: input.answers.hasRelatedParty,
      relatedPartyDisclosure: input.answers.relatedPartyDisclosure,
      reviewConsentAt: input.answers.reviewConsentAt,
      communicationConsentAt: input.answers.communicationConsentAt,
    })
    .where(
      and(
        eq(referralPartnerApplications.id, input.id),
        inArray(referralPartnerApplications.state, ['draft', 'changes_requested']),
      ),
    )
    .returning();
  return row;
}

/**
 * Move a DRAFT or a CHANGES-REQUESTED application to `submitted`.
 *
 * A re-submission BUMPS the revision, in the same statement, which is what
 * makes `UNIQUE(application_id, revision)` on the review trail admit a second
 * decision: a reviewer who asked for changes may only decide again once the
 * applicant has answered.
 */
export async function submitApplication(
  db: DatabaseOrTransaction,
  input: { id: string; at: Date; submittedByOxyUserId: string },
): Promise<ReferralApplicationRow | undefined> {
  const [row] = await db
    .update(referralPartnerApplications)
    .set({
      state: 'submitted',
      submittedAt: input.at,
      submittedByOxyUserId: input.submittedByOxyUserId,
      revision: sql`case when ${referralPartnerApplications.state} = 'changes_requested'
                        then ${referralPartnerApplications.revision} + 1
                        else ${referralPartnerApplications.revision} end`,
      // A re-submission clears the PREVIOUS decision from the working document.
      // The decision itself is not lost — it is a row on the append-only trail,
      // which is the whole reason the two are separate tables.
      decidedAt: null,
      decisionCode: null,
      decisionMessage: null,
    })
    .where(
      and(
        eq(referralPartnerApplications.id, input.id),
        inArray(referralPartnerApplications.state, ['draft', 'changes_requested']),
      ),
    )
    .returning();
  return row;
}

/** One application state transition, as a CAS from an expected SET. */
export async function transitionApplication(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    expected: readonly ReferralApplicationState[];
    to: ReferralApplicationState;
    at: Date;
    decisionCode?: ReferralApplicationRejectionCode | null;
    decisionMessage?: string | null;
  },
): Promise<ReferralApplicationRow | undefined> {
  const decided = input.to === 'approved' || input.to === 'rejected' || input.to === 'changes_requested';
  const [row] = await db
    .update(referralPartnerApplications)
    .set({
      state: input.to,
      ...(decided ? { decidedAt: input.at } : {}),
      ...(input.decisionCode !== undefined ? { decisionCode: input.decisionCode } : {}),
      ...(input.decisionMessage !== undefined ? { decisionMessage: input.decisionMessage } : {}),
    })
    .where(
      and(
        eq(referralPartnerApplications.id, input.id),
        inArray(referralPartnerApplications.state, [...input.expected]),
      ),
    )
    .returning();
  return row;
}

/**
 * Record ONE decision, on ONE revision.
 *
 * `onConflictDoNothing` on `(application_id, revision)` plus a re-read: a
 * double-clicked approval converges on the first reviewer's row rather than
 * surfacing a 23505, and the caller compares what came back against what it
 * asked for.
 */
export async function insertApplicationReview(
  db: DatabaseOrTransaction,
  input: {
    applicationId: string;
    revision: number;
    decision: ReferralApplicationDecision;
    rejectionCode: ReferralApplicationRejectionCode | null;
    partnerMessage: string | null;
    reviewerNote: string | null;
    evidenceRefs: readonly string[];
    reviewedByOxyUserId: string;
    reviewedAt: Date;
  },
): Promise<{ row: ReferralApplicationReviewRow; created: boolean }> {
  const [inserted] = await db
    .insert(referralPartnerApplicationReviews)
    .values({
      applicationId: input.applicationId,
      revision: input.revision,
      decision: input.decision,
      rejectionCode: input.rejectionCode,
      partnerMessage: input.partnerMessage,
      reviewerNote: input.reviewerNote,
      evidenceRefs: [...input.evidenceRefs],
      reviewedByOxyUserId: input.reviewedByOxyUserId,
      reviewedAt: input.reviewedAt,
    })
    .onConflictDoNothing({
      target: [
        referralPartnerApplicationReviews.applicationId,
        referralPartnerApplicationReviews.revision,
      ],
    })
    .returning();
  if (inserted) return { row: inserted, created: true };

  const [existing] = await db
    .select()
    .from(referralPartnerApplicationReviews)
    .where(
      and(
        eq(referralPartnerApplicationReviews.applicationId, input.applicationId),
        eq(referralPartnerApplicationReviews.revision, input.revision),
      ),
    );
  if (!existing) {
    throw new Error(
      `referral_partner_application_reviews insert for ${input.applicationId} revision ` +
        `${String(input.revision)} conflicted with a row that then could not be read back.`,
    );
  }
  return { row: existing, created: false };
}

/** The whole decision trail for one application, oldest revision first. */
export async function listApplicationReviews(
  db: DatabaseOrTransaction,
  applicationId: string,
): Promise<readonly ReferralApplicationReviewRow[]> {
  return await db
    .select()
    .from(referralPartnerApplicationReviews)
    .where(eq(referralPartnerApplicationReviews.applicationId, applicationId))
    .orderBy(referralPartnerApplicationReviews.revision);
}
