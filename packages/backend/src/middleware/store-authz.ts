/**
 * Store authorization middleware.
 *
 * Composes AFTER `authenticateToken` (so `req.userId` and `req.accessToken` are
 * set) on every `/admin/stores/:storeId/...` route:
 *   1. `loadStore` — resolve `:storeId`, resolve the caller's access through the
 *      Oxy account that owns the store, attach `req.store` + `req.storeAccess`.
 *   2. `requireStorePermission(perm)` — gate on `req.storeAccess.permissions`.
 *
 * Who belongs to the owning account, and in which role, is Oxy's answer; how a
 * role becomes permissions is `STORE_ROLE_PERMISSIONS` plus the caller's
 * override. Both live in `services/store-access.service.ts` (ADR 0012).
 */

import type { Request, Response, NextFunction } from 'express';
import { isLiveEntityId } from '@oxy.so/db';
import type { StoreAccess, StorePermission } from '@mercaria/shared-types';
import { findStoreById, type StoreRow } from '../db/stores/storeRepository.js';
import { resolveStoreAccess, storeCallerFrom } from '../services/store-access.service.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';
import { isMercariaError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

// Extend Express Request with the loaded store context. The base augmentation
// (userId/user/…) lives in `auth.ts`; this only adds the store fields.
declare global {
  namespace Express {
    interface Request {
      store?: StoreRow;
      storeAccess?: StoreAccess;
    }
  }
}

/**
 * Resolve `:storeId`, attach `req.store` + `req.storeAccess`. Responds:
 *   - 400 if the param is missing/malformed,
 *   - 401 if the request carries no verified caller,
 *   - 404 if no store with that id exists,
 *   - 403 if the caller has no role in the account that owns it,
 *   - 503 if Oxy cannot say — authorization fails CLOSED.
 *
 * MUST run after `authenticateToken`.
 */
export async function loadStore(req: Request, res: Response, next: NextFunction): Promise<void> {
  const raw = req.params.storeId;
  const storeId = Array.isArray(raw) ? raw[0] : raw;

  // Shape-only: both id shapes this schema stores are accepted (a 24-hex
  // ObjectId for a pre-cutover store, a uuid v7 for one created since). This
  // exists to turn a malformed param into a 400 instead of a pointless query —
  // never as a precondition on the lookup, which answers "no such store" itself.
  if (!storeId || !isLiveEntityId(storeId)) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'Invalid storeId', 400);
    return;
  }

  const caller = storeCallerFrom(req);
  if (!caller) {
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Authentication required', 401);
    return;
  }

  try {
    const store = await findStoreById(storeId);
    if (!store) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Store not found', 404);
      return;
    }

    const access = await resolveStoreAccess(caller, store);
    if (!access) {
      sendError(res, ErrorCodes.FORBIDDEN, 'You cannot act for this store', 403);
      return;
    }

    req.store = store;
    req.storeAccess = access;
    next();
  } catch (err) {
    if (isMercariaError(err)) {
      sendError(res, err.code, err.message, err.httpStatus);
      return;
    }
    log.general.error({ err, storeId }, 'Failed to load store for authorization');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to load store', 500);
  }
}

/**
 * Gate a route on the caller's EFFECTIVE permissions — `(role defaults ∪
 * granted) − revoked` — containing `perm`. MUST run after `loadStore`.
 */
export function requireStorePermission(perm: StorePermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const access = req.storeAccess;
    if (!access) {
      sendError(res, ErrorCodes.FORBIDDEN, 'Store access required', 403);
      return;
    }
    if (!access.permissions.includes(perm)) {
      sendError(res, ErrorCodes.FORBIDDEN, `Missing permission: ${perm}`, 403);
      return;
    }
    next();
  };
}
