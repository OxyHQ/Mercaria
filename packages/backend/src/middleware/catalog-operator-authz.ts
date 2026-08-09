/**
 * The gate on `/internal/commerce-graph/*` — the canonical-graph operator
 * surface (#54's linkage endpoints; #59's merge tooling joins it later).
 *
 * `requirePaymentOperator` (`operator-authz.ts`), applied to a different
 * allow-list. The full reasoning — why an allow-list and not a store
 * permission, why empty means NOT MOUNTED (404, never 401), why this is
 * interim until Oxy grows a platform operator role — lives in that file and
 * in `resolvePaymentOperatorIds`' doc comment, and is not restated here.
 * ADR 0002 D17/D24 name this surface's variable
 * (`CATALOG_OPERATOR_OXY_USER_IDS`) and bind it to that precedent.
 *
 * A SEPARATE list from the payments one, deliberately: who may link merchants
 * to stores and who may repair payments are different powers, and one list
 * for both would grant whichever power the operator was not vetted for.
 */

import type { NextFunction, Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { config } from '../config/index.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

/**
 * Refuse anyone not on `CATALOG_OPERATOR_OXY_USER_IDS`. Composes AFTER
 * `authenticateToken`, and reads NOTHING from the request beyond the verified
 * caller — no header, body field or query parameter can influence it.
 */
export function requireCatalogOperator(req: Request, res: Response, next: NextFunction): void {
  // Defence in depth against a future mount that forgets the config check —
  // the mount and the gate live in different files, exactly the pair that
  // drifts (the `requirePaymentOperator` precedent).
  if (!config.catalog.graphOperatorSurfaceEnabled) {
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

  if (!config.catalog.graphOperatorOxyUserIds.includes(oxyUserId)) {
    log.general.warn(
      { oxyUserId, path: req.path, method: req.method },
      '[CommerceGraph] a non-operator reached the internal commerce-graph surface',
    );
    sendError(res, ErrorCodes.FORBIDDEN, 'Operator access is required', 403);
    return;
  }

  next();
}

/**
 * The authenticated operator for the current request. Only called after
 * {@link requireCatalogOperator}; a throw rather than a cast because the value
 * is stamped onto every link and revocation as the ACTOR, and an audit trail
 * naming the wrong person is worse than one that failed to be written.
 */
export function catalogOperatorId(req: Request): string {
  return getRequiredOxyUserId(req);
}
