/**
 * The gate on `/internal/referrals/*` — the referral operator surface (#143
 * link rule 8, privacy rule 4).
 *
 * `requirePaymentOperator` (`operator-authz.ts`) and `requireGuestOperator`
 * (`guest-operator-authz.ts`), applied to a SEVENTH allow-list. The full
 * reasoning — why an allow-list and not a store permission, why empty means NOT
 * MOUNTED (404, never 401), why this is interim until Oxy grows a platform
 * operator role — lives in those files and is not restated here.
 *
 * A separate list because the POWER is separate, and it is the sharpest test of
 * the "reuse one of the existing lists unless it is genuinely new" rule this
 * repository applies. Pausing a program's attribution stops partners earning;
 * reading an attribution trace says which partner was credited for which
 * subject. An operator vetted to repair a payment, to trace a cart merge, or to
 * read discovery metrics has been vetted for none of that.
 *
 * #147's partner dashboards and #148's fraud and suspension surface inherit
 * THIS list rather than adding an eighth.
 */

import type { NextFunction, Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { config } from '../config/index.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

/**
 * Refuse anyone not on `REFERRAL_OPERATOR_OXY_USER_IDS`. Composes AFTER
 * `authenticateToken`, and reads NOTHING from the request beyond the verified
 * caller — no header, body field or query parameter can influence it.
 */
export function requireReferralOperator(req: Request, res: Response, next: NextFunction): void {
  // Defence in depth against a future mount that forgets the config check —
  // the mount and the gate live in different files, exactly the pair that drifts.
  if (!config.referrals.operatorSurfaceEnabled) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
    return;
  }

  let oxyUserId: string;
  try {
    oxyUserId = getRequiredOxyUserId(req);
  } catch {
    // `authenticateToken` runs first and answers 401 itself; reaching here
    // userless is a bug, and refusing is the only safe reading of it.
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Authentication required', 401);
    return;
  }

  if (!config.referrals.operatorOxyUserIds.includes(oxyUserId)) {
    log.general.warn(
      { oxyUserId, path: req.path, method: req.method },
      '[Referrals] a non-operator reached the internal referral surface',
    );
    sendError(res, ErrorCodes.FORBIDDEN, 'Operator access is required', 403);
    return;
  }

  next();
}
