/**
 * The gate on `/internal/analytics/*` (#77 dashboards).
 *
 * `requirePaymentOperator`, `requireCatalogOperator` and `requireGuestOperator`,
 * applied to a FOURTH allow-list. The full reasoning — why an allow-list and
 * not a store permission, why empty means NOT MOUNTED (404, never 401), why
 * this is interim until Oxy grows a platform operator role — lives in
 * `middleware/operator-authz.ts` and in `resolvePaymentOperatorIds`' doc
 * comment, and is not restated here.
 *
 * A separate list for the same reason the other three are separate from each
 * other, and this one is worth naming explicitly: reading what everybody
 * searched for across the whole marketplace is a different power from repairing
 * payments, from rewiring the catalogue and from inspecting a cart merge. It is
 * arguably the broadest of the four in aggregate — it is the only surface that
 * can answer "what is demand doing" — and it is the one most likely to be
 * granted casually to someone who "just needs the dashboard".
 */

import type { NextFunction, Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { config } from '../config/index.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

/**
 * Refuse anyone not on `ANALYTICS_OPERATOR_OXY_USER_IDS`. Composes AFTER
 * `authenticateToken`, and reads NOTHING from the request beyond the verified
 * caller — no header, body field or query parameter can influence it.
 */
export function requireAnalyticsOperator(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Defence in depth against a future mount that forgets the config check — the
  // mount and the gate live in different files, exactly the pair that drifts.
  if (!config.analytics.operatorSurfaceEnabled) {
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

  if (!config.analytics.operatorOxyUserIds.includes(oxyUserId)) {
    log.general.warn(
      { oxyUserId, path: req.path, method: req.method },
      '[Analytics] a non-operator reached the internal analytics surface',
    );
    sendError(res, ErrorCodes.FORBIDDEN, 'Operator access is required', 403);
    return;
  }

  next();
}
