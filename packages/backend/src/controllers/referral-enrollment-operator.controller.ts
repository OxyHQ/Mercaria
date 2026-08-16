/**
 * The operator side of referral enrollment (#146 increment 2, "Review and
 * approval").
 *
 * On the SAME `REFERRAL_OPERATOR_OXY_USER_IDS` allow-list #143 and #145 use,
 * NOT an eighth. Deciding whether somebody may be a referral partner and
 * approving what they are paid are the same economy, and splitting them would
 * put one half of a partner's fate behind a list the other half's operator is
 * not on — the argument #145 already made when it joined this list.
 *
 * ## What this surface CANNOT be asked
 *
 * The route set is CLOSED, and the omissions are the design:
 *
 *  - no "set this partner's state" — every move is a decision on an
 *    APPLICATION, or one of #142's existing audited transitions;
 *  - no "edit this application" — the answers are the applicant's, frozen by
 *    trigger once submitted, and a reviewer who could rewrite them would be
 *    approving something the partner never sent;
 *  - no "delete this review" and no "amend this decision" — the trail is
 *    append-only, and a correction is a NEW decision on a NEW revision, which
 *    only a re-submission produces;
 *  - no "grant this partner X" of any kind. #146 review rule 7, and a scanned
 *    gate.
 *
 * ## The trace opens from a PARTNER and nothing else
 *
 * No email, no promotion URL, no display-name search. "Which partner is this
 * person" is not a question this surface can be asked, which is the same bound
 * every other operator trace in this repository carries.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { notFound, respondWithError, validationError } from '../lib/errors/error-codes.js';
import { getDb } from '../db/postgres.js';
import {
  findLiveApplication,
  listApplicationReviews,
  listApplicationsForPartner,
} from '../db/referrals/applicationRepository.js';
import {
  findPartnerById,
  listPartnersByState,
} from '../db/referrals/partnerRepository.js';
import { listTermsAcceptances } from '../db/referrals/termsAcceptanceRepository.js';
import {
  decideApplication,
  resolvePartnerAppeal,
  startApplicationReview,
} from '../services/referrals/application-review.service.js';
import { createPartnerAsOperator } from '../services/referrals/enrollment.service.js';
import {
  reinstatePartner,
  suspendPartner,
  terminatePartner,
} from '../services/referrals/partner.service.js';
import { readDuplicateSignals } from '../services/referrals/duplicate-signals.js';
import { toReferralApplicationPartnerView } from '../services/referrals/partner-standing.service.js';
import { toReferralTermsAcceptanceView } from '../services/referrals/terms.service.js';
import type {
  ReferralAppealResolutionBody,
  ReferralApplicationDecisionBody,
  ReferralOperatorPartnerBody,
} from '../middleware/referral-partner-schemas.js';
import { referralPartnerInboxQuerySchema } from '../middleware/referral-partner-schemas.js';
import { sendSuccess } from '../utils/api-response.js';

/** Bounded, like every other operator list here. Never a whole table. */
const DEFAULT_INBOX_LIMIT = 50;

/** The review inbox: which partners are waiting, and for what. */
export async function listReferralPartnerInboxHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = referralPartnerInboxQuerySchema.safeParse(req.query);
    if (!parsed.success) throw validationError(parsed.error.issues[0]?.message ?? 'Invalid query');
    const raw = parsed.data.state;
    const states =
      raw === undefined
        ? (['applied', 'under_review', 'changes_requested'] as const)
        : Array.isArray(raw)
          ? raw
          : [raw];

    const db = getDb();
    const partners = await listPartnersByState(db, {
      states,
      limit: parsed.data.limit ?? DEFAULT_INBOX_LIMIT,
    });

    // One live application per partner, read individually rather than joined:
    // the inbox is bounded at 200 and the join would have to repeat
    // `LIVE_APPLICATION_STATES`, which is a second spelling of the partial
    // unique's own predicate.
    const rows = await Promise.all(
      partners.map(async (partner) => {
        const live = await findLiveApplication(db, partner.id);
        return {
          partnerId: partner.id,
          displayName: partner.displayName,
          ownerType: partner.ownerType,
          state: partner.state,
          enrollmentMode: partner.enrollmentMode,
          appealState: partner.appealState,
          riskState: partner.riskState,
          ...(live !== undefined
            ? { application: toReferralApplicationPartnerView(live) }
            : {}),
        };
      }),
    );
    sendSuccess(res, { partners: rows });
  } catch (err) {
    respondWithError(res, err, 'Failed to read the referral partner inbox');
  }
}

/**
 * Everything an operator needs to decide one partner.
 *
 * The DUPLICATE SIGNALS are computed here, now, over the live rows — never read
 * from a stored table. A stored signal is right on the day it is written and
 * wrong the moment the other partner is terminated or renamed, and the place
 * that must not happen is a reviewer reading "duplicate" about somebody who no
 * longer exists.
 */
export async function getReferralPartnerReviewHandler(req: Request, res: Response): Promise<void> {
  try {
    const partnerId = req.params.partnerId;
    if (typeof partnerId !== 'string' || partnerId.length === 0) {
      throw validationError('A partner id is required');
    }
    const db = getDb();
    const partner = await findPartnerById(db, partnerId);
    if (!partner) throw notFound('Referral partner not found');

    const [applications, acceptances, live] = await Promise.all([
      listApplicationsForPartner(db, partner.id),
      listTermsAcceptances(db, partner.id),
      findLiveApplication(db, partner.id),
    ]);
    const reviews = live === undefined ? [] : await listApplicationReviews(db, live.id);
    const duplicateSignals = await readDuplicateSignals(db, {
      partnerId: partner.id,
      ownerType: partner.ownerType,
      ownerId: partner.ownerId,
      displayName: partner.displayName,
      promotionUrls: live?.promotionUrls ?? [],
    });

    sendSuccess(res, {
      partner: {
        id: partner.id,
        displayName: partner.displayName,
        ownerType: partner.ownerType,
        ownerId: partner.ownerId,
        state: partner.state,
        enrollmentMode: partner.enrollmentMode,
        riskState: partner.riskState,
        appealState: partner.appealState,
        identityReadiness: partner.identityReadiness,
        taxReadiness: partner.taxReadiness,
        payoutReadiness: partner.payoutReadiness,
        marketingConsent: partner.marketingConsentAt !== null,
      },
      ...(live !== undefined ? { application: toReferralApplicationPartnerView(live) } : {}),
      history: applications.map(toReferralApplicationPartnerView),
      // The reviewer's own note IS included here and nowhere else: this is the
      // operator surface, and the separation #146 review rule 9 asks for is
      // between the two AUDIENCES, not between an operator and their own trail.
      reviews: reviews.map((review) => ({
        revision: review.revision,
        decision: review.decision,
        rejectionCode: review.rejectionCode,
        partnerMessage: review.partnerMessage,
        reviewerNote: review.reviewerNote,
        evidenceRefs: review.evidenceRefs,
        reviewedByOxyUserId: review.reviewedByOxyUserId,
        reviewedAt: review.reviewedAt.toISOString(),
      })),
      termsAcceptances: acceptances.map(toReferralTermsAcceptanceView),
      duplicateSignals,
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to read the referral partner review');
  }
}

/** Claim a submitted application for review. */
export async function startReferralApplicationReviewHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const partnerId = requirePartnerId(req);
    const result = await startApplicationReview({
      partnerId,
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, {
      partnerState: result.partner.state,
      application: toReferralApplicationPartnerView(result.application),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to open the application review');
  }
}

/** Approve, reject or request changes on the live application. */
export async function decideReferralApplicationHandler(req: Request, res: Response): Promise<void> {
  try {
    const partnerId = requirePartnerId(req);
    const body = req.body as ReferralApplicationDecisionBody;
    const result = await decideApplication({
      partnerId,
      decision: body.decision,
      ...(body.rejectionCode !== undefined ? { rejectionCode: body.rejectionCode } : {}),
      ...(body.partnerMessage !== undefined ? { partnerMessage: body.partnerMessage } : {}),
      ...(body.reviewerNote !== undefined ? { reviewerNote: body.reviewerNote } : {}),
      ...(body.evidenceRefs !== undefined ? { evidenceRefs: body.evidenceRefs } : {}),
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, {
      partnerState: result.partner.state,
      application: toReferralApplicationPartnerView(result.application),
      // False means this revision had ALREADY been decided and the answer
      // reported is the first reviewer's — a convergence, not a failure.
      decisionRecorded: result.decisionRecorded,
      decision: result.review.decision,
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to decide the referral application');
  }
}

/** Create a partner in one of the three operator-only enrollment modes. */
export async function createReferralPartnerHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as ReferralOperatorPartnerBody;
    const result = await createPartnerAsOperator({
      ownerType: body.ownerType,
      ownerId: body.ownerId,
      displayName: body.displayName,
      enrollmentMode: body.enrollmentMode,
      actorOxyUserId: getRequiredOxyUserId(req),
      reason: body.reason,
      ...(body.evidenceRefs !== undefined ? { evidenceRefs: body.evidenceRefs } : {}),
    });
    sendSuccess(res, {
      partnerId: result.partner.id,
      state: result.partner.state,
      enrollmentMode: result.partner.enrollmentMode,
      created: result.created,
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to create the referral partner');
  }
}

/**
 * Resolve an open appeal.
 *
 * Accepting one records the DECISION and nothing else — reinstatement stays
 * `POST /partners/:partnerId/reinstate`'s job, a separate audited act. One
 * request doing both would leave an operator reading the trail unable to tell
 * which of the two somebody actually intended.
 */
export async function resolveReferralAppealHandler(req: Request, res: Response): Promise<void> {
  try {
    const partnerId = requirePartnerId(req);
    const body = req.body as ReferralAppealResolutionBody;
    const partner = await resolvePartnerAppeal({
      partnerId,
      accepted: body.accepted,
      actorOxyUserId: getRequiredOxyUserId(req),
      reason: body.reason,
    });
    sendSuccess(res, { partnerId: partner.id, appealState: partner.appealState });
  } catch (err) {
    respondWithError(res, err, 'Failed to resolve the appeal');
  }
}

/**
 * Suspend, reinstate or terminate a partner's STANDING.
 *
 * #142 shipped all three services and mounted none of them, which left #146's
 * review rule 1 naming two states nothing could reach and an appeal path with
 * nothing to appeal. They arrive here rather than growing their own surface
 * because they are the same decision the review path makes, one step later in
 * a partner's life, and an operator already trusted to reject an application is
 * the one who suspends the partner it approved.
 *
 * `confirmedFraud` is a parameter of TERMINATION only, and it sets
 * `risk_state`. What it does NOT do is void, reverse or reduce a single reward
 * — ADR 0005 D15's "skipped, not voided" and #144's `reverseReward` are the
 * only thing that touches money, and neither is reachable from here.
 */
export function transitionReferralPartnerStandingHandler(
  action: 'suspend' | 'reinstate' | 'terminate',
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const partnerId = requirePartnerId(req);
      const body = req.body as { reason: string; confirmedFraud?: boolean };
      const actorOxyUserId = getRequiredOxyUserId(req);
      const partner =
        action === 'suspend'
          ? await suspendPartner({ partnerId, actorOxyUserId, reason: body.reason })
          : action === 'reinstate'
            ? await reinstatePartner({ partnerId, actorOxyUserId, reason: body.reason })
            : await terminatePartner({
                partnerId,
                actorOxyUserId,
                reason: body.reason,
                confirmedFraud: body.confirmedFraud === true,
              });
      sendSuccess(res, {
        partnerId: partner.id,
        state: partner.state,
        riskState: partner.riskState,
        appealState: partner.appealState,
      });
    } catch (err) {
      respondWithError(res, err, `Failed to ${action} the referral partner`);
    }
  };
}

function requirePartnerId(req: Request): string {
  const partnerId = req.params.partnerId;
  if (typeof partnerId !== 'string' || partnerId.length === 0) {
    throw validationError('A partner id is required');
  }
  return partnerId;
}
