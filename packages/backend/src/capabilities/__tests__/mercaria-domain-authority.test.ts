import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findStoreById: vi.fn(),
  effectivePermissions: vi.fn(),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoreById: mocks.findStoreById,
}));

vi.mock('../../middleware/store-authz.js', () => ({
  effectivePermissions: mocks.effectivePermissions,
}));

import { authorizeMercariaCatalogInvocation } from '../mercaria-domain-authority.js';

const ACCOUNT_ID = 'account-1';
const STORE_ID = 'store-1';

function storeWithMembers(...accountIds: string[]) {
  return {
    id: STORE_ID,
    members: accountIds.map((oxyUserId) => ({ oxyUserId })),
  };
}

beforeEach(() => {
  mocks.findStoreById.mockReset();
  mocks.effectivePermissions.mockReset();
});

describe('Mercaria live domain authority', () => {
  it('allows account-scoped read tools without inventing a store grant', async () => {
    await expect(authorizeMercariaCatalogInvocation(
      'listBuyerOrders',
      {},
      ACCOUNT_ID,
    )).resolves.toEqual({ allowed: true });
    expect(mocks.findStoreById).not.toHaveBeenCalled();
  });

  it('fails closed when the store, live membership, or live permission is absent', async () => {
    await expect(authorizeMercariaCatalogInvocation(
      'listStoreOrders',
      {},
      ACCOUNT_ID,
    )).resolves.toEqual({ allowed: false, reason: 'store_resource_required' });

    mocks.findStoreById.mockResolvedValueOnce(null);
    await expect(authorizeMercariaCatalogInvocation(
      'listStoreOrders',
      { storeId: STORE_ID },
      ACCOUNT_ID,
    )).resolves.toEqual({ allowed: false, reason: 'store_not_found' });

    mocks.findStoreById.mockResolvedValueOnce(storeWithMembers('someone-else'));
    await expect(authorizeMercariaCatalogInvocation(
      'listStoreOrders',
      { storeId: STORE_ID },
      ACCOUNT_ID,
    )).resolves.toEqual({ allowed: false, reason: 'store_membership_required' });

    mocks.findStoreById.mockResolvedValueOnce(storeWithMembers(ACCOUNT_ID));
    mocks.effectivePermissions.mockReturnValueOnce(new Set());
    await expect(authorizeMercariaCatalogInvocation(
      'refundStoreOrder',
      { storeId: STORE_ID },
      ACCOUNT_ID,
    )).resolves.toEqual({
      allowed: false,
      reason: 'missing_store_permission:refunds:write',
    });
  });

  it('requires the exact live permission for each store tool', async () => {
    mocks.findStoreById.mockResolvedValue(storeWithMembers(ACCOUNT_ID));
    mocks.effectivePermissions.mockReturnValue(new Set(['orders:read', 'refunds:write']));

    await expect(authorizeMercariaCatalogInvocation(
      'readStoreOrder',
      { storeId: STORE_ID, orderId: 'order-1' },
      ACCOUNT_ID,
    )).resolves.toEqual({ allowed: true });
    await expect(authorizeMercariaCatalogInvocation(
      'refundStoreOrder',
      { storeId: STORE_ID, orderId: 'order-1' },
      ACCOUNT_ID,
    )).resolves.toEqual({ allowed: true });
  });
});
