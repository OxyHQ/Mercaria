/**
 * The gate on `/internal/supplier-preflight/*` — the supply-operations surface
 * (#122 operations 4–5).
 *
 * `requirePaymentOperator` (`operator-authz.ts`), applied to a SIXTH allow-list.
 * The full reasoning — why an allow-list and not a store permission, why empty
 * means NOT MOUNTED (404, never 401), why this is interim until Oxy grows a
 * platform operator role — lives in that file and in `resolvePaymentOperatorIds`'
 * doc comment, and is not restated here.
 *
 * A SEPARATE list from the payments, catalog, guest, analytics and retail ones,
 * for a power none of them holds: this surface reads what Mercaria PAYS its
 * suppliers — wholesale unit costs, supplier fees, quoted shipping — and it
 * flips the supplier and market kill switches. A compliance reviewer vetted to
 * verify a product-safety certificate is not thereby vetted to see Mercaria's
 * cost base, and a payments operator vetted to replay a charge is not thereby
 * vetted to turn a market back on.
 */

import type { NextFunction, Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { config } from '../config/index.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

/**
 * Refuse anyone not on `PROCUREMENT_OPERATOR_OXY_USER_IDS`. Composes AFTER
 * `authenticateToken`, and reads NOTHING from the request beyond the verified
 * caller — no header, body field or query parameter can influence it.
 */
export function requireProcurementOperator(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Defence in depth against a future mount that forgets the config check —
  // the mount and the gate live in different files, exactly the pair that
  // drifts (the `requirePaymentOperator` precedent).
  if (!config.supplierPreflight.operatorSurfaceEnabled) {
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

  if (!config.supplierPreflight.operatorOxyUserIds.includes(oxyUserId)) {
    log.general.warn(
      { oxyUserId, path: req.path, method: req.method },
      '[SupplierPreflight] a non-operator reached the internal supplier-preflight surface',
    );
    sendError(res, ErrorCodes.FORBIDDEN, 'Operator access is required', 403);
    return;
  }

  next();
}

/**
 * The authenticated operator for the current request. Only called after
 * {@link requireProcurementOperator}; a throw rather than a cast because the
 * value is stamped onto every kill switch and lift as the ACTOR, and an audit
 * trail naming the wrong person is worse than one that failed to be written.
 */
export function procurementOperatorId(req: Request): string {
  return getRequiredOxyUserId(req);
}
