/**
 * The gate on `/internal/payments/*` — issue #50, operator surface.
 *
 * ## Why this is an ALLOW-LIST and not a permission
 *
 * Mercaria has exactly one authorization vocabulary — store permissions — and it
 * is scoped to a STORE by construction: `requireStorePermission` reads
 * `req.storeMembership`, which `loadStore` put there after checking the caller
 * is a member of THAT store. The operator surface is the opposite scope. It
 * reads across every store and every P2P seller, and issue #50 is explicit that
 * seller operators must not reach it.
 *
 * There is no store permission that could express "may see all stores' money"
 * without becoming one a store owner could grant themselves — and inventing a
 * platform-wide role would mean inventing its grant surface, its audit and its
 * recovery path: a second identity system beside Oxy's, in the one repository
 * that must not have one.
 *
 * So the allow-list is deliberately the crudest thing that is correct. Oxy user
 * ids in configuration, changed only by whoever can deploy, with no in-app way
 * to grant it and no way for a compromised merchant session to reach it.
 *
 * **This is interim.** When Oxy grows a platform-level operator role, this file
 * and `resolvePaymentOperatorIds` in `config/index.ts` are the two places that
 * change: the allow-list becomes a claim on the credential and the variable goes
 * away. It is a stand-in for that claim, not a design Mercaria intends to keep.
 *
 * ## 404 when the surface is off, 403 when the caller is not on it
 *
 * The empty allow-list is answered by NOT MOUNTING the router at all (see
 * `app.ts`), so Express's own 404 handles it and no code here runs. That follows
 * `STRIPE_ENABLED`'s rule rather than the outbox's: there is nothing to park,
 * and a 401 would tell an unauthenticated caller that an operator surface exists
 * on this deployment.
 *
 * The guard below is the second half — a real, authenticated Oxy user who is not
 * on the list gets 403 and a log line naming them. That distinction matters:
 * "this deployment has no operator surface" and "you are not one of its
 * operators" are different facts and only the second should be discoverable by
 * someone holding a valid credential.
 */

import type { NextFunction, Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { config } from '../config/index.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

/**
 * Refuse anyone not on `PAYMENT_OPERATOR_OXY_USER_IDS`.
 *
 * Composes AFTER `authenticateToken`, so `getRequiredOxyUserId` has a verified
 * caller to read. It deliberately reads NOTHING from the request beyond that:
 * no header, no body field, no query parameter can influence the decision, which
 * is what makes the surface unreachable by anything a merchant dashboard could
 * send.
 */
export function requirePaymentOperator(req: Request, res: Response, next: NextFunction): void {
  // Defence in depth against a future mount that forgets the config check. The
  // router is not mounted when the list is empty, so this branch is unreachable
  // today — and it is written out because the mount is in a different file from
  // the gate, which is exactly the pair that drifts.
  if (!config.payments.operatorSurfaceEnabled) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
    return;
  }

  let oxyUserId: string;
  try {
    oxyUserId = getRequiredOxyUserId(req);
  } catch {
    // `authenticateToken` runs first and answers 401 itself, so reaching here
    // means it let through a request with no user — a bug rather than an
    // anonymous caller. Refusing is the only safe reading of it.
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Authentication required', 401);
    return;
  }

  if (!config.payments.operatorOxyUserIds.includes(oxyUserId)) {
    // Logged at `warn` with the caller: a merchant credential probing the
    // platform's own reconciliation surface is worth seeing, and a store
    // permission cannot produce this — the only way to be here is to hold a
    // valid Oxy token and guess the path.
    log.general.warn(
      { oxyUserId, path: req.path, method: req.method },
      '[Payments] a non-operator reached the internal payments surface',
    );
    sendError(res, ErrorCodes.FORBIDDEN, 'Operator access is required', 403);
    return;
  }

  next();
}

/**
 * The authenticated operator for the current request.
 *
 * Only ever called after {@link requirePaymentOperator}, which is what makes the
 * throw unreachable — but it is a throw rather than a cast, because the value it
 * returns is stamped onto every repair as the ACTOR, and an audit trail naming
 * the wrong person is worse than one that failed to be written.
 */
export function operatorId(req: Request): string {
  return getRequiredOxyUserId(req);
}
