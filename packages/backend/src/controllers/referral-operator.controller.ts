/**
 * The referral operator controllers (THIN) — #143.
 *
 * The route set behind them is CLOSED and it is three reads plus one write.
 * What is deliberately absent is the design: there is no "attribute this
 * subject to that partner", no "create a touch", no "extend this window", no
 * "move this attribution" and no delete. Every one of those would be a way to
 * make the referral record say something nobody observed, and #142 already
 * publishes the two corrections an operator legitimately makes
 * (`invalidateAttribution`, `correctAttribution`), each append-only and each
 * naming its actor.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { CurrencyCode, ReferralEarningDiscrepancyStatus } from '@mercaria/shared-types';
import { sendSuccess } from '../utils/api-response.js';
import { notFound, respondWithError, validationError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { getDb } from '../db/postgres.js';
import { appendReferralEvent } from '../db/referrals/eventRepository.js';
import {
  listEarningDiscrepancies,
  transitionEarningDiscrepancy,
} from '../db/referralEarnings/discrepancyRepository.js';
import {
  readProgramControls,
  setProgramControls,
} from '../services/referrals/controls.service.js';
import { operatorAttributionTrace } from '../services/referrals/read.service.js';
import {
  readReferralPartnerBalances,
  traceReferralEarnings,
} from '../services/referrals/earnings/read.service.js';
import {
  approvePayoutBatch,
  buildPayoutBatchForPartner,
  cancelPayoutBatch,
  settlePayoutBatch,
} from '../services/referrals/earnings/payout-batch.service.js';
import { bookPartnerRecovery } from '../services/referrals/earnings/posting.service.js';
import { reconcileReferralEarnings } from '../services/referrals/earnings/reconciliation.service.js';
import {
  freezePartnerRewards,
  liftPartnerFreeze,
  vestDueRewards,
} from '../services/referrals/earnings/vesting.service.js';

/**
 * A REQUIRED query parameter, refused rather than defaulted.
 *
 * `programId` scopes the payout lever a balance is derived under, so guessing
 * one would answer "may this partner be paid" against a program nobody named.
 */
function requiredQuery(req: Request, name: string): string {
  const value = req.query[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationError(`\`${name}\` is required`);
  }
  return value.trim();
}

/** `GET /internal/referrals/programs/:programId/controls`. */
export async function getReferralProgramControlsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(res, await readProgramControls(routeParam(req, 'programId')));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read referral program controls');
  }
}

/** `PUT /internal/referrals/programs/:programId/controls`. */
export async function setReferralProgramControlsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as {
      redirectEnabled: boolean;
      attributionEnabled: boolean;
      payoutEnabled: boolean;
      reason: string;
    };
    sendSuccess(
      res,
      await setProgramControls({
        programId: routeParam(req, 'programId'),
        redirectEnabled: body.redirectEnabled,
        attributionEnabled: body.attributionEnabled,
        payoutEnabled: body.payoutEnabled,
        actorOxyUserId: getRequiredOxyUserId(req),
        reason: body.reason,
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to set referral program controls');
  }
}

/**
 * `GET /internal/referrals/attributions/:attributionId` — the trace.
 *
 * Opens from an ATTRIBUTION id and nothing else. There is no lookup by email,
 * by order, by session or by device — #143 privacy rule 4 asks that operator
 * inspection be access-controlled and audited, and the sharpest form of that is
 * a surface which cannot be asked "show me everything this person did".
 */
export async function getReferralAttributionTraceHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(res, await operatorAttributionTrace(routeParam(req, 'attributionId')));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to trace the referral attribution');
  }
}

// ─── The earnings ledger's operator surface (#145) ───────────────────────────
//
// The route set stays CLOSED, and what is absent is again the design. There is
// no "mark this reward paid", no "void this reward", no "book this entry", no
// "edit this posting", no "set this batch's total" and no delete. Every write
// below DRIVES an existing idempotent path a machine already takes:
//
//  - building, approving, settling and cancelling a batch are the four steps of
//    ONE capability, and the settlement is the same function the loop calls;
//  - a freeze WITHHOLDS and never destroys (ADR 0005 D18), so it is safe for an
//    operator to hold while #148 automates the detection that should drive it;
//  - VOIDING stays #144's `reverseReward` with a fraud cause and has no route,
//    because deciding that a conversion was fraudulent is #148's and a route
//    here would be a way around that;
//  - a recovery RECORDS money that arrived (R7) rather than deciding that it
//    should;
//  - resolving a discrepancy is a note about a finding, never a change to what
//    the finding measured.

/** `GET /internal/referrals/partners/:partnerId/earnings?programId=`. */
export async function getReferralEarningsTraceHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await traceReferralEarnings({
        partnerId: routeParam(req, 'partnerId'),
        programId: requiredQuery(req, 'programId'),
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to trace referral earnings');
  }
}

/** `GET /internal/referrals/partners/:partnerId/balances?programId=`. */
export async function getReferralPartnerBalancesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await readReferralPartnerBalances({
        partnerId: routeParam(req, 'partnerId'),
        programId: requiredQuery(req, 'programId'),
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read referral partner balances');
  }
}

/** `POST /internal/referrals/partners/:partnerId/payout-batches`. */
export async function openReferralPayoutBatchHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as {
      programId: string;
      currency: CurrencyCode;
      finalPayout?: boolean;
      withholdingMinor?: number;
      reason: string;
    };
    sendSuccess(
      res,
      await buildPayoutBatchForPartner({
        partnerId: routeParam(req, 'partnerId'),
        programId: body.programId,
        currency: body.currency,
        createdByOxyUserId: getRequiredOxyUserId(req),
        ...(body.finalPayout === undefined ? {} : { finalPayout: body.finalPayout }),
        ...(body.withholdingMinor === undefined
          ? {}
          : { withholdingMinor: body.withholdingMinor }),
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to open a referral payout batch');
  }
}

/** `POST /internal/referrals/payout-batches/:batchId/approve`. */
export async function approveReferralPayoutBatchHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as { reason: string };
    sendSuccess(
      res,
      await approvePayoutBatch({
        batchId: routeParam(req, 'batchId'),
        approvedByOxyUserId: getRequiredOxyUserId(req),
        reason: body.reason,
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to approve a referral payout batch');
  }
}

/**
 * `POST /internal/referrals/payout-batches/:batchId/settle`.
 *
 * The SAME function the loop calls. With `REFERRAL_PAYOUT_BATCHES_ENABLED` off
 * this is how a batch settles at all, which is why the surface stays mounted
 * while every lever is down.
 */
export async function settleReferralPayoutBatchHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(res, await settlePayoutBatch({ batchId: routeParam(req, 'batchId') }));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to settle a referral payout batch');
  }
}

/** `POST /internal/referrals/payout-batches/:batchId/cancel`. */
export async function cancelReferralPayoutBatchHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as { reason: string };
    sendSuccess(
      res,
      await cancelPayoutBatch({
        batchId: routeParam(req, 'batchId'),
        cancelledByOxyUserId: getRequiredOxyUserId(req),
        reason: body.reason,
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to cancel a referral payout batch');
  }
}

/** `POST /internal/referrals/partners/:partnerId/freeze` — ADR 0005 D18/R8. */
export async function freezeReferralPartnerRewardsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as { reason: string };
    const actor = getRequiredOxyUserId(req);
    sendSuccess(
      res,
      await freezePartnerRewards({
        partnerId: routeParam(req, 'partnerId'),
        cause: 'partner_suspended',
        // The ACTOR is the source: two operators freezing the same partner for
        // two reasons are two decisions, and one key would swallow the second.
        sourceRef: `operator:${actor}`,
        actorKind: 'operator',
        actorRef: actor,
        reason: body.reason,
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to freeze referral rewards');
  }
}

/** `POST /internal/referrals/partners/:partnerId/unfreeze`. */
export async function liftReferralPartnerFreezeHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as { reason: string };
    const actor = getRequiredOxyUserId(req);
    sendSuccess(
      res,
      await liftPartnerFreeze({
        partnerId: routeParam(req, 'partnerId'),
        sourceRef: `operator:${actor}`,
        actorKind: 'operator',
        actorRef: actor,
        reason: body.reason,
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to lift a referral reward freeze');
  }
}

/** `POST /internal/referrals/partners/:partnerId/recoveries` — ADR 0005 R7. */
export async function recordReferralRecoveryHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as {
      recoveryRef: string;
      amountMinor: number;
      currency: CurrencyCode;
      reason: string;
    };
    const actor = getRequiredOxyUserId(req);
    const partnerId = routeParam(req, 'partnerId');
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const posting = await bookPartnerRecovery(tx, {
        partnerId,
        amountMinor: body.amountMinor,
        currency: body.currency,
        recoveryRef: body.recoveryRef,
        occurredAt: new Date(),
        description: `Referral recovery ${body.recoveryRef} for partner ${partnerId}`,
      });
      await appendReferralEvent(tx, {
        subjectType: 'partner',
        subjectId: partnerId,
        action: 'partner_recovery_recorded',
        actorKind: 'operator',
        actorRef: actor,
        reason: `${String(body.amountMinor)} ${body.currency} (${body.recoveryRef}): ${body.reason}`,
      });
      return posting;
    });
    sendSuccess(res, result);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to record a referral recovery');
  }
}

/** `GET /internal/referrals/earnings/discrepancies`. */
export async function listReferralEarningDiscrepanciesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    sendSuccess(
      res,
      await listEarningDiscrepancies(getDb(), {
        limit: 100,
        ...(status ? { statuses: [status as ReferralEarningDiscrepancyStatus] } : {}),
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list referral earning discrepancies');
  }
}

/** `POST /internal/referrals/earnings/discrepancies/:id/resolve`. */
export async function resolveReferralEarningDiscrepancyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as { status: 'acknowledged' | 'resolved'; note: string };
    const actor = getRequiredOxyUserId(req);
    const db = getDb();
    const row = await transitionEarningDiscrepancy(db, {
      id: routeParam(req, 'id'),
      expected: ['open', 'acknowledged'],
      to: body.status,
      at: new Date(),
      actorOxyUserId: actor,
      note: body.note,
    });
    if (!row) throw notFound('Referral earning discrepancy not found');
    await appendReferralEvent(db, {
      subjectType: 'partner',
      subjectId: row.partnerId,
      action: 'earnings_discrepancy_resolved',
      actorKind: 'operator',
      actorRef: actor,
      reason: `${row.kind} → ${body.status}: ${body.note}`,
    });
    sendSuccess(res, row);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to resolve a referral earning discrepancy');
  }
}

/**
 * `POST /internal/referrals/earnings/reconcile` — run one page of the sweep.
 *
 * Drives the same function the loop drives. It DETECTS and repairs nothing, so
 * an operator running it during an incident cannot make anything worse.
 */
export async function runReferralReconciliationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    sendSuccess(
      res,
      await reconcileReferralEarnings({ limit: 25, ...(cursor ? { cursor } : {}) }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to reconcile referral earnings');
  }
}

/**
 * `POST /internal/referrals/earnings/vest[?partnerId=]` — run one page of the
 * vesting sweep, optionally narrowed to one partner.
 *
 * The same function the loop calls, and idempotent: a reward already `vested`
 * fails the compare-and-swap and nothing is appended.
 */
export async function runReferralVestingHandler(req: Request, res: Response): Promise<void> {
  try {
    const partnerId = typeof req.query.partnerId === 'string' ? req.query.partnerId : undefined;
    sendSuccess(res, await vestDueRewards({ limit: 200, ...(partnerId ? { partnerId } : {}) }));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to run the referral vesting sweep');
  }
}
