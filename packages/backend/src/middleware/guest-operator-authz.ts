/**
 * The gate on `/internal/guest-commerce/*` — the guest-commerce diagnostic
 * surface (#104 idempotency requirement 8).
 *
 * `requirePaymentOperator` (`operator-authz.ts`) and `requireCatalogOperator`
 * (`catalog-operator-authz.ts`), applied to a THIRD allow-list. The full
 * reasoning — why an allow-list and not a store permission, why empty means NOT
 * MOUNTED (404, never 401), why this is interim until Oxy grows a platform
 * operator role — lives in those files and in `resolvePaymentOperatorIds`' doc
 * comment, and is not restated here.
 *
 * A separate list for the same reason the catalogue one is separate from the
 * payments one: reading who merged which cart, repairing payments and rewiring
 * the catalogue are three different powers, and one list for all three would
 * grant whichever an operator was not vetted for.
 */

import type { NextFunction, Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { config } from '../config/index.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

/**
 * Refuse anyone not on `GUEST_OPERATOR_OXY_USER_IDS`. Composes AFTER
 * `authenticateToken`, and reads NOTHING from the request beyond the verified
 * caller — no header, body field or query parameter can influence it.
 */
export function requireGuestOperator(req: Request, res: Response, next: NextFunction): void {
  // Defence in depth against a future mount that forgets the config check —
  // the mount and the gate live in different files, exactly the pair that drifts.
  if (!config.guest.operatorSurfaceEnabled) {
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

  if (!config.guest.operatorOxyUserIds.includes(oxyUserId)) {
    log.guest.warn(
      { oxyUserId, path: req.path, method: req.method },
      '[Guest] a non-operator reached the internal guest-commerce surface',
    );
    sendError(res, ErrorCodes.FORBIDDEN, 'Operator access is required', 403);
    return;
  }

  next();
}
