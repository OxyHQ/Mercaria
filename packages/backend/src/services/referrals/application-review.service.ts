/**
 * The operator side of enrollment: review, decision, appeal (#146 increment 2,
 * "Review and approval").
 *
 * ## One decision per REVISION, and the database says so
 *
 * `UNIQUE(application_id, revision)` on the append-only trail is #55's
 * `review_round` device: a reviewer decides a revision exactly once, a
 * double-clicked approval converges on the first row rather than raising, and a
 * reviewer who asked for changes may decide again only once the applicant has
 * RE-SUBMITTED — which is the one thing that bumps the revision. So "an
 * approval cannot be reused" is a property of the index, not of a comparison
 * somebody remembers to write.
 *
 * ## Two audiences, two fields, and the type is what separates them
 *
 * #146 review rule 9 asks that ordinary rejection copy reveal no sensitive risk
 * signal. That is held THREE ways here. The vocabulary
 * (`ReferralApplicationRejectionCode`) has no member that could name one. The
 * partner-facing sentence and the reviewer's own note are different columns,
 * and `ReferralApplicationPartnerView` has no field the note could arrive in —
 * the `MerchantOrder` device, a different TYPE rather than a filtered one. And
 * `referral-enrollment-isolation.test.ts` scans the partner projection for the
 * seven disclosures named in `REFERRAL_APPLICATION_FORBIDDEN_DISCLOSURES`.
 *
 * ## What this service does NOT do
 *
 * It grants nothing. There is no store permission, no membership, no claim, no
 * payment onboarding and no allow-list entry anywhere on the approval path
 * (#146 review rule 7, a scanned gate) — an approved partner has a standing and
 * that is all. It also does not touch the three readiness columns: #146 review
 * rule 8 keeps public-profile approval and financial readiness apart, and those
 * columns have exactly one writer, which is the readiness sync.
 */

import {
  REFERRAL_ENROLLMENT_MODE_RULES,
  type ReferralApplicationDecision,
  type ReferralApplicationRejectionCode,
} from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import { appendReferralEvent } from '../../db/referrals/eventRepository.js';
import {
  findApplicationReview,
  findLatestApplication,
  findLiveApplication,
  insertApplicationReview,
  transitionApplication,
  type ReferralApplicationRow,
  type ReferralApplicationReviewRow,
} from '../../db/referrals/applicationRepository.js';
import {
  findPartnerById,
  lockPartnerForEnrollment,
  transitionPartnerAppeal,
  type ReferralPartnerRow,
} from '../../db/referrals/partnerRepository.js';
import { alignPartnerStanding } from './enrollment.service.js';

/** What one decision produced. */
export interface ReferralReviewResult {
  partner: ReferralPartnerRow;
  application: ReferralApplicationRow;
  review: ReferralApplicationReviewRow;
  /** False when this exact revision had already been decided — a convergence. */
  decisionRecorded: boolean;
}

/**
 * Claim a submitted application for review.
 *
 * A CAS rather than a read-then-write, so two operators opening the same inbox
 * item converge: the loser sees `submitted` no longer available and reads the
 * row back as `under_review`, which is a successful outcome rather than an
 * error. It records no reviewer on the application — who is LOOKING at
 * something is not a decision, and a column for it would be a lock nobody
 * releases when they close the tab.
 */
export async function startApplicationReview(input: {
  partnerId: string;
  actorOxyUserId: string;
  at?: Date;
}): Promise<{ partner: ReferralPartnerRow; application: ReferralApplicationRow }> {
  const at = input.at ?? new Date();
  const db = getDb();

  return await db.transaction(async (tx) => {
    const partner = await requirePartner(tx, input.partnerId);
    await lockPartnerForEnrollment(tx, partner.id);

    const live = await findLiveApplication(tx, partner.id);
    if (!live) throw notFound('No application to review');
    if (live.state === 'under_review') return { partner, application: live };
    if (live.state !== 'submitted') {
      throw conflict(`This application is ${live.state} and is not waiting for review`);
    }

    const moved = await transitionApplication(tx, {
      id: live.id,
      expected: ['submitted'],
      to: 'under_review',
      at,
    });
    if (!moved) throw conflict('This application changed while it was being claimed');

    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: partner.id,
      action: 'partner_application_review_started',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: `Review opened on revision ${String(moved.revision)}`,
    });

    const aligned = await alignPartnerStanding(tx, {
      partnerId: partner.id,
      applicationState: 'under_review',
      at,
    });
    return { partner: aligned, application: moved };
  });
}

/**
 * Decide the live application.
 *
 * The review row is written FIRST and its `created` flag is what makes the
 * whole operation idempotent: a repeat on the same revision converges on the
 * first reviewer's decision and the application transition then finds nothing
 * to move, which is the correct outcome rather than a 409. Writing the
 * transition first and the row second would let a retry record a second
 * decision on a revision somebody already decided.
 */
export async function decideApplication(input: {
  partnerId: string;
  decision: ReferralApplicationDecision;
  rejectionCode?: ReferralApplicationRejectionCode;
  /** The sentence the APPLICANT reads. Bounded, and never the reviewer's note. */
  partnerMessage?: string;
  /** The reviewer's own reasoning. Operator-only, by the absence of a field. */
  reviewerNote?: string;
  evidenceRefs?: readonly string[];
  actorOxyUserId: string;
  at?: Date;
}): Promise<ReferralReviewResult> {
  const at = input.at ?? new Date();
  const refusing = input.decision === 'rejected' || input.decision === 'changes_requested';
  if (refusing && input.rejectionCode === undefined) {
    throw validationError(`A ${input.decision} decision must name its reason code`);
  }
  if (!refusing && input.rejectionCode !== undefined) {
    throw validationError('An approval carries no reason code');
  }

  const db = getDb();
  return await db.transaction(async (tx) => {
    const partner = await requirePartner(tx, input.partnerId);
    await lockPartnerForEnrollment(tx, partner.id);

    // The LATEST application, not the live one. A rejection takes its row out
    // of the live set, so a reviewer retrying one would be told "no application
    // to decide" while an identical retry of an approval converged — one
    // operation, two answers, decided by which verdict was reached first.
    const live = await findLatestApplication(tx, partner.id);
    if (!live) throw notFound('No application to decide');

    // ALREADY DECIDED at this revision: converge on the first reviewer's
    // decision and report it. This read has to come BEFORE the state guard, or
    // the guard refuses every retry and the `UNIQUE(application_id, revision)`
    // convergence below becomes unreachable — a mechanism green and inert,
    // which the real-server suite caught on its first run. The race is still
    // the index's to settle; this only handles the sequential retry.
    const decidedAlready = await findApplicationReview(tx, {
      applicationId: live.id,
      revision: live.revision,
    });
    if (decidedAlready) {
      return { partner, application: live, review: decidedAlready, decisionRecorded: false };
    }

    if (live.state !== 'submitted' && live.state !== 'under_review') {
      throw conflict(`This application is ${live.state} and cannot be decided`);
    }

    const { row: review, created } = await insertApplicationReview(tx, {
      applicationId: live.id,
      revision: live.revision,
      decision: input.decision,
      rejectionCode: input.rejectionCode ?? null,
      partnerMessage: input.partnerMessage ?? null,
      reviewerNote: input.reviewerNote ?? null,
      evidenceRefs: input.evidenceRefs ?? [],
      reviewedByOxyUserId: input.actorOxyUserId,
      reviewedAt: at,
    });

    if (!created) {
      // Somebody decided this revision already. Converge on THEIR decision and
      // report it, rather than applying this caller's — which may differ.
      return { partner, application: live, review, decisionRecorded: false };
    }

    const decided = await transitionApplication(tx, {
      id: live.id,
      expected: ['submitted', 'under_review'],
      to: input.decision,
      at,
      decisionCode: input.rejectionCode ?? null,
      decisionMessage: input.partnerMessage ?? null,
    });
    if (!decided) throw conflict('This application changed while it was being decided');

    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: partner.id,
      action:
        input.decision === 'approved'
          ? 'partner_approved'
          : input.decision === 'rejected'
            ? 'partner_application_rejected'
            : 'partner_application_changes_requested',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      // The stored reason names the CODE and the revision and never the
      // partner-facing sentence: `referral_events.reason` is free text an
      // operator reads, and copying the applicant's copy into it would give one
      // message two homes that can disagree.
      reason: `Revision ${String(live.revision)}: ${input.decision}${
        input.rejectionCode !== undefined ? ` (${input.rejectionCode})` : ''
      }`,
    });

    const aligned = await alignPartnerStanding(tx, {
      partnerId: partner.id,
      applicationState: input.decision,
      at,
    });
    return { partner: aligned, application: decided, review, decisionRecorded: true };
  });
}

/**
 * Open an appeal against a suspension or a termination (#146 review rule 5).
 *
 * `referral_partners.appeal_state` and the `appeal_opened` / `appeal_resolved`
 * event actions have existed since #142 with NOTHING writing them; this is the
 * service they were waiting for. An appeal against a REJECTED APPLICATION is
 * deliberately not this — reconsideration there is a new application, which the
 * partial unique already permits once the refusal is terminal, and calling that
 * an appeal would give one word two mechanisms.
 */
export async function openPartnerAppeal(input: {
  partnerId: string;
  actorOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<ReferralPartnerRow> {
  const at = input.at ?? new Date();
  const db = getDb();

  return await db.transaction(async (tx) => {
    const partner = await requirePartner(tx, input.partnerId);
    if (partner.state !== 'suspended' && partner.state !== 'terminated') {
      throw conflict(`A ${partner.state} partner has no decision to appeal`);
    }

    const row = await transitionPartnerAppeal(tx, {
      id: partner.id,
      expected: ['none', 'rejected'],
      to: 'open',
      at,
    });
    if (!row) {
      const current = await requirePartner(tx, input.partnerId);
      if (current.appealState === 'open') return current;
      throw conflict(`This partner's appeal is ${current.appealState} and cannot be reopened`);
    }

    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: partner.id,
      action: 'appeal_opened',
      actorKind: 'partner',
      actorRef: input.actorOxyUserId,
      reason: input.reason,
    });
    return row;
  });
}

/**
 * Resolve an open appeal.
 *
 * Accepting one records the DECISION and nothing more: reinstatement is
 * `reinstatePartner`, a separate audited act with its own CAS and its own
 * event. Folding the two together would let one request both accept an appeal
 * and restore a partner's standing, and an operator reading the trail could not
 * tell which of the two somebody actually intended.
 */
export async function resolvePartnerAppeal(input: {
  partnerId: string;
  accepted: boolean;
  actorOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<ReferralPartnerRow> {
  const at = input.at ?? new Date();
  const db = getDb();

  return await db.transaction(async (tx) => {
    const row = await transitionPartnerAppeal(tx, {
      id: input.partnerId,
      expected: ['open'],
      to: input.accepted ? 'accepted' : 'rejected',
      at,
    });
    if (!row) {
      const current = await requirePartner(tx, input.partnerId);
      throw conflict(`This partner's appeal is ${current.appealState}, not open`);
    }

    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: row.id,
      action: 'appeal_resolved',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: `${input.accepted ? 'accepted' : 'rejected'}: ${input.reason}`,
    });
    return row;
  });
}

/**
 * Whether this partner's enrollment mode earns REAL money.
 *
 * Read off the rule table rather than compared against a mode name, so a mode
 * added to `REFERRAL_ENROLLMENT_MODE_RULES` without an answer fails `tsc`
 * rather than defaulting to payable. The payout gate consumes it.
 */
export function enrollmentEarnsProductionRewards(partner: {
  enrollmentMode: string;
}): boolean {
  const rule =
    REFERRAL_ENROLLMENT_MODE_RULES[
      partner.enrollmentMode as keyof typeof REFERRAL_ENROLLMENT_MODE_RULES
    ];
  // An UNRECOGNISED mode blocks. The column's CHECK makes one unreachable, and
  // the fail-closed reading is the only safe one for a question whose `true`
  // sends somebody money.
  return rule !== undefined && rule.earnsProductionRewards;
}

async function requirePartner(
  db: Parameters<typeof findPartnerById>[0],
  id: string,
): Promise<ReferralPartnerRow> {
  const row = await findPartnerById(db, id);
  if (!row) throw notFound('Referral partner not found');
  return row;
}
