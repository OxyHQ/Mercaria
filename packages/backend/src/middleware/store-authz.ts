/**
 * Store authorization middleware.
 *
 * Composes AFTER `authenticateToken` (so `req.userId` is set) on every
 * `/admin/stores/:storeId/...` route:
 *   1. `loadStore`             — resolve `:storeId`, attach `req.store` +
 *                                `req.storeMembership`, 404/403 as appropriate.
 *   2. `requireStoreRole(...)` — gate on the member's ROLE.
 *   3. `requireStorePermission(perm)` — gate on the member's EFFECTIVE
 *                                permission set (role defaults ∪ explicit grants).
 *
 * Owner-protection rules (cannot remove/demote the last owner; only an owner may
 * change/remove another owner) live in `store.service`, NOT here.
 */

import type { Request, Response, NextFunction } from 'express';
import { isValidObjectId } from 'mongoose';
import type { StoreRole, StorePermission } from '@mercaria/shared-types';
import { Store, type IStore, type IStoreMember } from '../models/store.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

// Extend Express Request with the loaded store context. The base augmentation
// (userId/user/…) lives in `auth.ts`; this only adds the store fields.
declare global {
  namespace Express {
    interface Request {
      store?: IStore;
      storeMembership?: IStoreMember;
    }
  }
}

/** The full set of permissions a store can grant. */
const ALL_PERMISSIONS: readonly StorePermission[] = [
  'store:manage',
  'members:manage',
  'products:read',
  'products:write',
  'inventory:write',
  'locations:write',
  'collections:write',
  'discounts:write',
  'settings:write',
  'orders:read',
  'orders:fulfill',
  'stats:read',
  'customers:read',
  'customers:write',
  'draft_orders:write',
  'refunds:write',
  'channels:write',
];

/**
 * Permissions an admin holds — everything EXCEPT `store:manage`. `store:manage`
 * is the only store-level destructive op (rename/handle/brand, status, ownership
 * transfer); an admin runs the whole business (members, settings, discounts,
 * refunds, tax, locations, collections) but cannot reconfigure the store itself.
 */
const ADMIN_PERMISSIONS: readonly StorePermission[] = ALL_PERMISSIONS.filter(
  (p) => p !== 'store:manage',
);

/**
 * Permissions staff hold by default — the OPERATIONAL set: run the shop floor +
 * POS, but NOT configure the business. Staff get products/inventory (read+write),
 * orders (read+fulfill), customers (read+write), draft orders (POS), and stats —
 * and are DENIED `members:manage`, `store:manage`, `settings:write`,
 * `discounts:write`, `refunds:write`, `locations:write`, `collections:write`
 * and `channels:write`.
 */
const STAFF_PERMISSIONS: readonly StorePermission[] = [
  'products:read',
  'products:write',
  'inventory:write',
  'orders:read',
  'orders:fulfill',
  'stats:read',
  'customers:read',
  'customers:write',
  'draft_orders:write',
];

/**
 * Final B7 role → default-permission matrix. A member's EFFECTIVE permissions are
 * these defaults UNIONed with their explicit `permissions[]` grants.
 *
 * | permission         | owner | admin | staff |
 * |--------------------|:-----:|:-----:|:-----:|
 * | store:manage       |   ✓   |       |       |
 * | members:manage     |   ✓   |   ✓   |       |
 * | settings:write     |   ✓   |   ✓   |       |
 * | discounts:write    |   ✓   |   ✓   |       |
 * | refunds:write      |   ✓   |   ✓   |       |
 * | locations:write    |   ✓   |   ✓   |       |
 * | collections:write  |   ✓   |   ✓   |       |
 * | channels:write     |   ✓   |   ✓   |       |
 * | products:read      |   ✓   |   ✓   |   ✓   |
 * | products:write     |   ✓   |   ✓   |   ✓   |
 * | inventory:write    |   ✓   |   ✓   |   ✓   |
 * | orders:read        |   ✓   |   ✓   |   ✓   |
 * | orders:fulfill     |   ✓   |   ✓   |   ✓   |
 * | stats:read         |   ✓   |   ✓   |   ✓   |
 * | customers:read     |   ✓   |   ✓   |   ✓   |
 * | customers:write    |   ✓   |   ✓   |   ✓   |
 * | draft_orders:write |   ✓   |   ✓   |   ✓   |
 *
 * - `owner` — every permission (17/17, incl. `store:manage`).
 * - `admin` — every permission EXCEPT `store:manage` (16/17).
 * - `staff` — the operational shop-floor + POS set (9/17); cannot configure the
 *   business (no manage/settings/discounts/refunds/locations/collections/channels).
 */
export const ROLE_PERMISSIONS: Record<StoreRole, StorePermission[]> = {
  owner: [...ALL_PERMISSIONS],
  admin: [...ADMIN_PERMISSIONS],
  staff: [...STAFF_PERMISSIONS],
};

/** Compute a member's effective permissions: role defaults ∪ explicit grants. */
export function effectivePermissions(member: IStoreMember): Set<StorePermission> {
  const effective = new Set<StorePermission>(ROLE_PERMISSIONS[member.role]);
  for (const perm of member.permissions) {
    effective.add(perm);
  }
  return effective;
}

/**
 * Resolve `:storeId`, attach `req.store` + `req.storeMembership`. Responds:
 *   - 400 if the param is missing/malformed,
 *   - 404 if no store with that id exists,
 *   - 403 if the caller is authenticated but not a member of the store.
 *
 * MUST run after `authenticateToken` so `req.userId` is present.
 */
export async function loadStore(req: Request, res: Response, next: NextFunction): Promise<void> {
  const raw = req.params.storeId;
  const storeId = Array.isArray(raw) ? raw[0] : raw;

  if (!storeId || !isValidObjectId(storeId)) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'Invalid storeId', 400);
    return;
  }

  const callerId = req.userId;
  if (!callerId) {
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Authentication required', 401);
    return;
  }

  try {
    const store = await Store.findById(storeId);
    if (!store) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Store not found', 404);
      return;
    }

    const membership = store.members.find((m) => m.oxyUserId === callerId);
    if (!membership) {
      sendError(res, ErrorCodes.FORBIDDEN, 'You are not a member of this store', 403);
      return;
    }

    req.store = store;
    req.storeMembership = membership;
    next();
  } catch (err) {
    log.general.error({ err, storeId }, 'Failed to load store for authorization');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to load store', 500);
  }
}

/**
 * Gate a route on the caller holding one of `roles`. MUST run after `loadStore`
 * (which attaches `req.storeMembership`).
 */
export function requireStoreRole(...roles: StoreRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const membership = req.storeMembership;
    if (!membership) {
      sendError(res, ErrorCodes.FORBIDDEN, 'Store membership required', 403);
      return;
    }
    if (!roles.includes(membership.role)) {
      sendError(res, ErrorCodes.FORBIDDEN, 'Insufficient role for this action', 403);
      return;
    }
    next();
  };
}

/**
 * Gate a route on the caller's EFFECTIVE permission set (role defaults ∪ explicit
 * grants) containing `perm`. MUST run after `loadStore`.
 */
export function requireStorePermission(perm: StorePermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const membership = req.storeMembership;
    if (!membership) {
      sendError(res, ErrorCodes.FORBIDDEN, 'Store membership required', 403);
      return;
    }
    if (!effectivePermissions(membership).has(perm)) {
      sendError(res, ErrorCodes.FORBIDDEN, `Missing permission: ${perm}`, 403);
      return;
    }
    next();
  };
}
