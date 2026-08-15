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
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import {
  readProgramControls,
  setProgramControls,
} from '../services/referrals/controls.service.js';
import { operatorAttributionTrace } from '../services/referrals/read.service.js';

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
      reason: string;
    };
    sendSuccess(
      res,
      await setProgramControls({
        programId: routeParam(req, 'programId'),
        redirectEnabled: body.redirectEnabled,
        attributionEnabled: body.attributionEnabled,
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
