/**
 * The gate on `/internal/retail-eligibility/*` — the retail compliance operator
 * surface (#121 operations 3).
 *
 * `requirePaymentOperator` (`operator-authz.ts`), applied to a FIFTH allow-list.
 * The full reasoning — why an allow-list and not a store permission, why empty
 * means NOT MOUNTED (404, never 401), why this is interim until Oxy grows a
 * platform operator role — lives in that file and in `resolvePaymentOperatorIds`'
 * doc comment, and is not restated here.
 *
 * A SEPARATE list from the payments, catalog, guest and analytics ones,
 * deliberately: approving a resale authorization, verifying a product-safety
 * certificate and lifting a RECALL are compliance powers. One list for all five
 * would grant whichever power the operator was not vetted for, and the one this
 * surface holds is the only one whose misuse puts an unsafe product back on
 * sale.
 */

import type { NextFunction, Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { config } from '../config/index.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

/**
 * Refuse anyone not on `RETAIL_OPERATOR_OXY_USER_IDS`. Composes AFTER
 * `authenticateToken`, and reads NOTHING from the request beyond the verified
 * caller — no header, body field or query parameter can influence it.
 */
export function requireRetailOperator(req: Request, res: Response, next: NextFunction): void {
  // Defence in depth against a future mount that forgets the config check —
  // the mount and the gate live in different files, exactly the pair that
  // drifts (the `requirePaymentOperator` precedent).
  if (!config.retailEligibility.operatorSurfaceEnabled) {
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

  if (!config.retailEligibility.operatorOxyUserIds.includes(oxyUserId)) {
    log.general.warn(
      { oxyUserId, path: req.path, method: req.method },
      '[RetailEligibility] a non-operator reached the internal retail-eligibility surface',
    );
    sendError(res, ErrorCodes.FORBIDDEN, 'Operator access is required', 403);
    return;
  }

  next();
}

/**
 * The authenticated operator for the current request. Only called after
 * {@link requireRetailOperator}; a throw rather than a cast because the value is
 * stamped onto every approval, rejection and recall as the ACTOR, and an audit
 * trail naming the wrong person is worse than one that failed to be written.
 */
export function retailOperatorId(req: Request): string {
  return getRequiredOxyUserId(req);
}
