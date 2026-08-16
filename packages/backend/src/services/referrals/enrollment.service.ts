/**
 * Enrollment: which door a partner came through, what they told Mercaria, and
 * the submission that asks for a decision (#146 increment 2, ADR 0005 D2).
 *
 * ## Where the authorization is, and where it deliberately is not
 *
 * Nowhere in this file. Every function takes an `{ ownerType, ownerId }` pair
 * that the ROUTE has already established: the `store` half is mounted under
 * `/admin/stores/:storeId`, where `loadStore` plus
 * `requireStorePermission('store:manage')` answer "may this Oxy account act for
 * this store" before a referral module runs, and the `user` half is mounted
 * where the owner IS `getRequiredOxyUserId(req)`. That is #85's two-mount shape
 * (`/admin/stores/:storeId/activation` beside `/seller/activation/policies`),
 * and taking it is what closes increment 1's stated reason for leaving the tax
 * route unmounted — "answering it here would be a second answer" is satisfied
 * by answering it in NEITHER half of this domain.
 *
 * `referral-enrollment-isolation.test.ts` fails the build if a module here
 * learns to read a role matrix, a permission array or a store membership.
 *
 * ## The mode is a TABLE, and the state machine reads it
 *
 * No function here asks "is the mode `staff_test`". What differs between the
 * eight modes is `REFERRAL_ENROLLMENT_MODE_RULES` — who may enroll that way,
 * whether an applicant may NAME it, whether a submission needs a human, whether
 * creating one needs stated evidence, and whether it earns real money. #83's
 * `claim-methods.ts` decision, and the reason is the same: a service that
 * branches on the mode is one that will branch on it in three of the four
 * places it matters.
 *
 * The mode is supplied ONCE, when the partner record is created, and every
 * later step reads it off the row. An applicant cannot re-declare it on
 * submission — which is what makes `selfServe: false` a real bound rather than
 * a check on the first request only.
 */

import {
  REFERRAL_ENROLLMENT_MODE_RULES,
  type ReferralApplicationState,
  type ReferralEnrollmentMode,
  type ReferralPartnerOwnerType,
  type ReferralPartnerState,
} from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { appendReferralEvent } from '../../db/referrals/eventRepository.js';
import {
  findApplicationById,
  findLiveApplication,
  insertApplicationReview,
  insertDraftApplication,
  submitApplication,
  transitionApplication,
  updateApplicationAnswers,
  type ReferralApplicationRow,
} from '../../db/referrals/applicationRepository.js';
import {
  findPartnerByOwner,
  insertPartner,
  lockPartnerForEnrollment,
  transitionPartnerState,
  type ReferralPartnerRow,
} from '../../db/referrals/partnerRepository.js';
import {
  missingSubmissionRequirements,
  normalizeApplicationAnswers,
  type RawApplicationAnswers,
} from './application-answers.js';

/**
 * The partner STANDING that corresponds to one application state.
 *
 * ONE table rather than a branch per transition, so the two can never drift.
 * `withdrawn` maps to `draft` because a withdrawn application leaves an owner
 * who may start another one — mapping it to `rejected` would put a refusal on a
 * record nobody refused.
 */
const PARTNER_STATE_FOR_APPLICATION: Readonly<
  Record<ReferralApplicationState, ReferralPartnerState>
> = {
  draft: 'draft',
  submitted: 'applied',
  under_review: 'under_review',
  approved: 'approved',
  rejected: 'rejected',
  changes_requested: 'changes_requested',
  withdrawn: 'draft',
};

/** Which partner states each application transition may be applied from. */
const PARTNER_STATES_BEFORE: Readonly<
  Record<ReferralApplicationState, readonly ReferralPartnerState[]>
> = {
  draft: ['draft', 'rejected'],
  submitted: ['draft', 'invited', 'changes_requested'],
  under_review: ['applied'],
  approved: ['applied', 'invited', 'under_review'],
  rejected: ['applied', 'under_review'],
  changes_requested: ['applied', 'under_review'],
  withdrawn: ['draft', 'applied', 'under_review', 'changes_requested'],
};

/** A partner and their live application, as every enrollment write returns it. */
export interface ReferralEnrollmentResult {
  partner: ReferralPartnerRow;
  application: ReferralApplicationRow;
}

/**
 * Move the partner's standing to match an application state, or refuse.
 *
 * Exported for the review service, which performs the same move from the other
 * side of the decision. A refusal here is a genuine race — somebody suspended
 * the partner between the two statements — and 409 is the honest answer.
 */
export async function alignPartnerStanding(
  tx: DatabaseOrTransaction,
  input: { partnerId: string; applicationState: ReferralApplicationState; at: Date },
): Promise<ReferralPartnerRow> {
  const to = PARTNER_STATE_FOR_APPLICATION[input.applicationState];
  const row = await transitionPartnerState(tx, {
    id: input.partnerId,
    expected: PARTNER_STATES_BEFORE[input.applicationState],
    to,
    at: input.at,
  });
  if (!row) {
    throw conflict(
      `The partner's standing changed while this application was being decided; nothing moved.`,
    );
  }
  return row;
}

/**
 * Start or update a DRAFT application, creating the partner record if this
 * owner has none.
 *
 * Idempotent by construction: `insertPartner` converges on the owner's existing
 * row and `insertDraftApplication` converges on the partial unique, so a double
 * click produces one partner, one draft and one `partner_application_started`
 * event.
 *
 * The MODE is honoured only when the record is being created. An owner who
 * already has one keeps the mode they were enrolled under — an invited partner
 * cannot re-declare themselves an open applicant, and nobody can name a mode
 * `selfServe: false` at all.
 */
export async function startPartnerApplication(input: {
  ownerType: ReferralPartnerOwnerType;
  ownerId: string;
  displayName: string;
  /** Only read when the partner record does not yet exist. */
  enrollmentMode?: ReferralEnrollmentMode;
  actorOxyUserId: string;
  answers: RawApplicationAnswers;
  at?: Date;
}): Promise<ReferralEnrollmentResult> {
  const at = input.at ?? new Date();
  const answers = normalizeApplicationAnswers(input.answers, at);
  const db = getDb();

  return await db.transaction(async (tx) => {
    const existing = await findPartnerByOwner(tx, {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
    });

    let partner: ReferralPartnerRow;
    if (existing) {
      partner = existing;
      if (partner.state === 'suspended' || partner.state === 'terminated') {
        throw conflict(`This partner is ${partner.state} and cannot start a new application`);
      }
    } else {
      const mode = input.enrollmentMode ?? 'open_application';
      const rule = REFERRAL_ENROLLMENT_MODE_RULES[mode];
      if (!rule.selfServe) {
        // Not "unrecognized mode": naming the refusal is what stops somebody
        // adding a self-serve branch for `staff_test` later without noticing
        // that this is the sentence they are deleting.
        throw validationError(`Enrollment mode ${mode} is created by an operator, not applied for`);
      }
      if (!rule.eligibleOwnerTypes.includes(input.ownerType)) {
        throw validationError(`A ${input.ownerType} partner cannot enroll through ${mode}`);
      }
      const created = await insertPartner(tx, {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        displayName: input.displayName,
        state: 'draft',
        at,
        promotionMethods: answers.promotionMethods,
        enrollmentMode: mode,
      });
      partner = created.row;
    }

    const draft = await insertDraftApplication(tx, {
      partnerId: partner.id,
      enrollmentMode: partner.enrollmentMode,
      answers,
    });

    let application = draft.row;
    if (draft.created) {
      await appendReferralEvent(tx, {
        subjectType: 'partner',
        subjectId: partner.id,
        action: 'partner_application_started',
        actorKind: 'partner',
        actorRef: input.actorOxyUserId,
        reason: `Application opened under ${partner.enrollmentMode}`,
      });
    } else {
      const updated = await updateApplicationAnswers(tx, { id: application.id, answers });
      if (!updated) {
        throw conflict(
          `This application is ${application.state} and its answers can no longer be edited`,
        );
      }
      application = updated;
    }

    return { partner, application };
  });
}

/**
 * Submit the live application for a decision.
 *
 * A mode whose rule says no human is needed is APPROVED here, in the same
 * transaction, with a `system` review row carrying the mode as its reason —
 * because "the operator who created this record IS the review" has to leave a
 * row somewhere, or an operator reading the trail later sees an approval with
 * no decision behind it.
 *
 * A re-submission after `changes_requested` BUMPS the revision (in the update
 * statement, not here), which is what lets the review trail's
 * `UNIQUE(application_id, revision)` admit a second decision.
 */
export async function submitPartnerApplication(input: {
  ownerType: ReferralPartnerOwnerType;
  ownerId: string;
  actorOxyUserId: string;
  at?: Date;
}): Promise<ReferralEnrollmentResult> {
  const at = input.at ?? new Date();
  const db = getDb();

  return await db.transaction(async (tx) => {
    const partner = await requireOwnedPartner(tx, input);
    await lockPartnerForEnrollment(tx, partner.id);

    const live = await findLiveApplication(tx, partner.id);
    if (!live) throw notFound('No application to submit');
    if (!['draft', 'changes_requested'].includes(live.state)) {
      throw conflict(`This application is ${live.state} and cannot be submitted`);
    }

    const missing = missingSubmissionRequirements({
      promotionMethods: live.promotionMethods as never,
      promotionUrls: live.promotionUrls,
      audienceBand: live.audienceBand as never,
      markets: live.markets,
      prohibitedMethodsAcknowledged: live.prohibitedMethodsAcknowledged,
      hasRelatedParty: live.hasRelatedParty,
      relatedPartyDisclosure: live.relatedPartyDisclosure,
      reviewConsentAt: live.reviewConsentAt,
      communicationConsentAt: live.communicationConsentAt,
      programId: live.programId,
    });
    if (missing.length > 0) {
      throw validationError(`This application is not complete: ${missing.join('; ')}`);
    }

    const submitted = await submitApplication(tx, {
      id: live.id,
      at,
      submittedByOxyUserId: input.actorOxyUserId,
    });
    if (!submitted) {
      throw conflict('This application changed while it was being submitted; nothing moved.');
    }

    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: partner.id,
      action: 'partner_applied',
      actorKind: 'partner',
      actorRef: input.actorOxyUserId,
      reason: `Submitted revision ${String(submitted.revision)} under ${partner.enrollmentMode}`,
    });

    const rule = REFERRAL_ENROLLMENT_MODE_RULES[partner.enrollmentMode];
    if (rule.requiresOperatorReview) {
      const aligned = await alignPartnerStanding(tx, {
        partnerId: partner.id,
        applicationState: 'submitted',
        at,
      });
      return { partner: aligned, application: submitted };
    }

    await insertApplicationReview(tx, {
      applicationId: submitted.id,
      revision: submitted.revision,
      decision: 'approved',
      rejectionCode: null,
      partnerMessage: null,
      reviewerNote: `Approved without review: ${partner.enrollmentMode} is vetted at creation`,
      evidenceRefs: [],
      reviewedByOxyUserId: 'system',
      reviewedAt: at,
    });
    const approved = await transitionApplication(tx, {
      id: submitted.id,
      expected: ['submitted'],
      to: 'approved',
      at,
    });
    if (!approved) {
      throw conflict('This application changed while it was being approved; nothing moved.');
    }
    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: partner.id,
      action: 'partner_approved',
      actorKind: 'system',
      reason: `Enrollment mode ${partner.enrollmentMode} needs no separate review`,
    });
    const aligned = await alignPartnerStanding(tx, {
      partnerId: partner.id,
      applicationState: 'approved',
      at,
    });
    return { partner: aligned, application: approved };
  });
}

/** Close one's own application. Terminal for that row; a new one may be started. */
export async function withdrawPartnerApplication(input: {
  ownerType: ReferralPartnerOwnerType;
  ownerId: string;
  actorOxyUserId: string;
  at?: Date;
}): Promise<ReferralEnrollmentResult> {
  const at = input.at ?? new Date();
  const db = getDb();

  return await db.transaction(async (tx) => {
    const partner = await requireOwnedPartner(tx, input);
    await lockPartnerForEnrollment(tx, partner.id);

    const live = await findLiveApplication(tx, partner.id);
    if (!live) throw notFound('No application to withdraw');
    if (live.state === 'approved') {
      throw conflict('An approved application cannot be withdrawn');
    }

    const withdrawn = await transitionApplication(tx, {
      id: live.id,
      expected: ['draft', 'submitted', 'under_review', 'changes_requested'],
      to: 'withdrawn',
      at,
    });
    if (!withdrawn) {
      throw conflict('This application changed while it was being withdrawn; nothing moved.');
    }

    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: partner.id,
      action: 'partner_application_withdrawn',
      actorKind: 'partner',
      actorRef: input.actorOxyUserId,
      reason: `Withdrew revision ${String(withdrawn.revision)}`,
    });

    const aligned = await alignPartnerStanding(tx, {
      partnerId: partner.id,
      applicationState: 'withdrawn',
      at,
    });
    return { partner: aligned, application: withdrawn };
  });
}

/**
 * Create a partner in an OPERATOR-ONLY mode (#146 enrollment modes 4, 7 and 8).
 *
 * The three modes an applicant may not name arrive here instead, and the two
 * that declare `requiresOperatorEvidence` are refused without it — which is
 * enrollment mode 8's "explicit evidence" as a shape rather than a convention.
 * Evidence is opaque REFERENCES (a contract id, an Oxy `file_id`), never a URL
 * and never a document: Mercaria records what to go and look at and fetches
 * nothing.
 */
export async function createPartnerAsOperator(input: {
  ownerType: ReferralPartnerOwnerType;
  ownerId: string;
  displayName: string;
  enrollmentMode: ReferralEnrollmentMode;
  actorOxyUserId: string;
  reason: string;
  evidenceRefs?: readonly string[];
  at?: Date;
}): Promise<{ partner: ReferralPartnerRow; created: boolean }> {
  const at = input.at ?? new Date();
  const rule = REFERRAL_ENROLLMENT_MODE_RULES[input.enrollmentMode];
  if (rule.selfServe) {
    throw validationError(
      `Enrollment mode ${input.enrollmentMode} is applied for, not created by an operator`,
    );
  }
  if (!rule.eligibleOwnerTypes.includes(input.ownerType)) {
    throw validationError(
      `A ${input.ownerType} partner cannot enroll through ${input.enrollmentMode}`,
    );
  }
  const evidenceRefs = input.evidenceRefs ?? [];
  if (rule.requiresOperatorEvidence && evidenceRefs.length === 0) {
    throw validationError(
      `Enrollment mode ${input.enrollmentMode} requires the evidence it was created on`,
    );
  }

  const db = getDb();
  return await db.transaction(async (tx) => {
    const { row, created } = await insertPartner(tx, {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      displayName: input.displayName,
      state: 'invited',
      at,
      promotionMethods: [],
      enrollmentMode: input.enrollmentMode,
    });
    if (created) {
      await appendReferralEvent(tx, {
        subjectType: 'partner',
        subjectId: row.id,
        action: 'partner_invited',
        actorKind: 'operator',
        actorRef: input.actorOxyUserId,
        reason:
          evidenceRefs.length > 0
            ? `${input.reason} [mode ${input.enrollmentMode}; evidence ${evidenceRefs.join(', ')}]`
            : `${input.reason} [mode ${input.enrollmentMode}]`,
      });
    }
    return { partner: row, created };
  });
}

/** Read one application by id, refusing one that belongs to another partner. */
export async function readApplicationForPartner(
  db: DatabaseOrTransaction,
  input: { partnerId: string; applicationId: string },
): Promise<ReferralApplicationRow> {
  const row = await findApplicationById(db, input.applicationId);
  // ONE indistinguishable 404 for "no such application" and "somebody else's":
  // a distinguishable answer is an oracle over application ids.
  if (!row || row.partnerId !== input.partnerId) throw notFound('Application not found');
  return row;
}

async function requireOwnedPartner(
  tx: DatabaseOrTransaction,
  key: { ownerType: ReferralPartnerOwnerType; ownerId: string },
): Promise<ReferralPartnerRow> {
  const partner = await findPartnerByOwner(tx, key);
  if (!partner) throw notFound('Referral partner not found');
  return partner;
}
