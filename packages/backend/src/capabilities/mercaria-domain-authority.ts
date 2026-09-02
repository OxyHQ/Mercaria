import type { StorePermission } from '@mercaria/shared-types';

import { findStoreById } from '../db/stores/storeRepository.js';
import { effectivePermissions } from '../middleware/store-authz.js';

const STORE_TOOL_PERMISSIONS: Readonly<Record<string, StorePermission>> = {
  listStoreOrders: 'orders:read',
  readStoreOrder: 'orders:read',
  refundStoreOrder: 'refunds:write',
};

export type MercariaAuthorizationDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: string }>;

function stringInput(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Recalculate Mercaria-owned authority at execution time.
 *
 * Oxy decides who may use the catalog capability. Mercaria remains authoritative
 * for mutable store membership and permissions, so removing a member or their
 * refund permission blocks the next invocation without waiting for a token to
 * expire.
 */
export async function authorizeMercariaCatalogInvocation(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  effectiveAccountId: string,
): Promise<MercariaAuthorizationDecision> {
  const requiredPermission = STORE_TOOL_PERMISSIONS[toolName];
  if (!requiredPermission) {
    if (toolName === 'searchProducts' || toolName === 'listBuyerOrders' || toolName === 'readBuyerOrder') {
      return { allowed: true };
    }
    return { allowed: false, reason: 'unknown_catalog_tool' };
  }

  const storeId = stringInput(input, 'storeId');
  if (!storeId) return { allowed: false, reason: 'store_resource_required' };

  const store = await findStoreById(storeId);
  if (!store) return { allowed: false, reason: 'store_not_found' };
  const membership = store.members.find(({ oxyUserId }) => oxyUserId === effectiveAccountId);
  if (!membership) return { allowed: false, reason: 'store_membership_required' };
  if (!effectivePermissions(membership).has(requiredPermission)) {
    return { allowed: false, reason: `missing_store_permission:${requiredPermission}` };
  }
  return { allowed: true };
}

