import type { StorePermission } from '@mercaria/shared-types';

import { findStoreById } from '../db/stores/storeRepository.js';

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
 * Oxy decides who may use the catalog capability, and who belongs to the Oxy
 * account that owns a store (ADR 0012). A capability invocation carries the
 * EFFECTIVE account and no caller session to ask Oxy with, so a store tool is
 * allowed only when that account IS the store's owning account — which holds
 * every permission. A person who wants an agent to act for an organization's
 * store has the agent act as the organization, and Oxy authorizes that act.
 * Re-read on every invocation, so moving a store to another account blocks the
 * next call without waiting for a ticket to expire.
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
  if (store.oxyAccountId !== effectiveAccountId) {
    return { allowed: false, reason: 'store_owner_account_required' };
  }
  return { allowed: true };
}

