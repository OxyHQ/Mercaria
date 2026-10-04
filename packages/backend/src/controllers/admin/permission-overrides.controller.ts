/**
 * Store permission-override controller (THIN).
 *
 * Lists, writes and removes the per-person exceptions to the role map
 * (`store_permission_overrides`, ADR 0012). Who belongs to the store is not
 * here: that is the owning Oxy account's membership, which the dashboard reads
 * from Oxy directly. The rules — the owning account takes no override, a
 * permission cannot be both granted and revoked, nobody grants or revokes what
 * they do not hold — live in `store.service`.
 */

import type { Request, Response } from 'express';
import type {
  SetStorePermissionOverrideInput,
  StorePermissionOverride,
} from '@mercaria/shared-types';
import type { StorePermissionOverrideRow } from '../../db/stores/storeRepository.js';
import { listStorePermissionOverrides } from '../../db/stores/storeRepository.js';
import {
  removeStorePermissionOverride,
  setStorePermissionOverride,
} from '../../services/store.service.js';
import { storeCallerFrom } from '../../services/store-access.service.js';
import { sendError, sendSuccess, ErrorCodes } from '../../utils/api-response.js';
import { respondWithError } from '../../lib/errors/error-codes.js';
import { routeParam } from '../../utils/request.js';
import { log } from '../../lib/logger.js';

/** Serialize an override row to the `StorePermissionOverride` DTO. */
function toOverrideDTO(row: StorePermissionOverrideRow): StorePermissionOverride {
  return {
    oxyUserId: row.oxyUserId,
    granted: [...row.granted],
    revoked: [...row.revoked],
    updatedByOxyUserId: row.updatedByOxyUserId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** GET /admin/stores/:storeId/permission-overrides — every exception on the store. */
export async function listOverrides(req: Request, res: Response): Promise<void> {
  const store = req.store;
  if (!store) {
    respondWithError(res, undefined, 'Store not loaded');
    return;
  }
  try {
    const rows = await listStorePermissionOverrides(store.id);
    sendSuccess(res, rows.map(toOverrideDTO));
  } catch (err) {
    log.general.error({ err }, 'Failed to list store permission overrides');
    respondWithError(res, err, 'Failed to load permission overrides');
  }
}

/**
 * PUT /admin/stores/:storeId/permission-overrides/:oxyUserId — replace one
 * person's exception. Two empty sets remove it: 200 with `null`.
 */
export async function putOverride(req: Request, res: Response): Promise<void> {
  const { store, storeAccess } = req;
  const caller = storeCallerFrom(req);
  if (!store || !storeAccess) {
    respondWithError(res, undefined, 'Store not loaded');
    return;
  }
  if (!caller) {
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Authentication required', 401);
    return;
  }
  const oxyUserId = routeParam(req, 'oxyUserId');
  try {
    const body = req.body as SetStorePermissionOverrideInput;
    const row = await setStorePermissionOverride({
      store,
      caller,
      callerAccess: storeAccess,
      oxyUserId,
      granted: body.granted,
      revoked: body.revoked,
    });
    sendSuccess(res, row ? toOverrideDTO(row) : null);
  } catch (err) {
    log.general.error({ err, oxyUserId }, 'Failed to write store permission override');
    respondWithError(res, err, 'Failed to save the permission override');
  }
}

/** DELETE /admin/stores/:storeId/permission-overrides/:oxyUserId — remove one exception. */
export async function deleteOverride(req: Request, res: Response): Promise<void> {
  const store = req.store;
  if (!store) {
    respondWithError(res, undefined, 'Store not loaded');
    return;
  }
  const oxyUserId = routeParam(req, 'oxyUserId');
  try {
    await removeStorePermissionOverride(store.id, oxyUserId);
    sendSuccess(res, { oxyUserId, deleted: true });
  } catch (err) {
    log.general.error({ err, oxyUserId }, 'Failed to remove store permission override');
    respondWithError(res, err, 'Failed to remove the permission override');
  }
}
