import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findStoreById: vi.fn(),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoreById: mocks.findStoreById,
}));

import { authorizeMercariaCatalogInvocation } from '../mercaria-domain-authority.js';

const ACCOUNT_ID = 'account-1';
const STORE_ID = 'store-1';

/** A store owned by `oxyAccountId` (ADR 0012). */
function storeOwnedBy(oxyAccountId: string) {
  return { id: STORE_ID, oxyAccountId };
}

beforeEach(() => {
  mocks.findStoreById.mockReset();
});

describe('Mercaria live domain authority', () => {
  it('allows account-scoped read tools without inventing a store grant', async () => {
    await expect(
      authorizeMercariaCatalogInvocation('listBuyerOrders', {}, ACCOUNT_ID),
    ).resolves.toEqual({ allowed: true });
    expect(mocks.findStoreById).not.toHaveBeenCalled();
  });

  it('fails closed without a store, or when the store is not the effective account’s', async () => {
    await expect(
      authorizeMercariaCatalogInvocation('listStoreOrders', {}, ACCOUNT_ID),
    ).resolves.toEqual({ allowed: false, reason: 'store_resource_required' });

    mocks.findStoreById.mockResolvedValueOnce(null);
    await expect(
      authorizeMercariaCatalogInvocation('listStoreOrders', { storeId: STORE_ID }, ACCOUNT_ID),
    ).resolves.toEqual({ allowed: false, reason: 'store_not_found' });

    // A capability carries no session to ask Oxy who belongs to the owning
    // account with, so a member is not enough: the agent acts AS the account.
    mocks.findStoreById.mockResolvedValueOnce(storeOwnedBy('org-someone-else'));
    await expect(
      authorizeMercariaCatalogInvocation('refundStoreOrder', { storeId: STORE_ID }, ACCOUNT_ID),
    ).resolves.toEqual({ allowed: false, reason: 'store_owner_account_required' });
  });

  it('allows every store tool to the store’s owning account, re-read per call', async () => {
    mocks.findStoreById.mockResolvedValue(storeOwnedBy(ACCOUNT_ID));

    await expect(
      authorizeMercariaCatalogInvocation(
        'readStoreOrder',
        { storeId: STORE_ID, orderId: 'order-1' },
        ACCOUNT_ID,
      ),
    ).resolves.toEqual({ allowed: true });
    await expect(
      authorizeMercariaCatalogInvocation(
        'refundStoreOrder',
        { storeId: STORE_ID, orderId: 'order-1' },
        ACCOUNT_ID,
      ),
    ).resolves.toEqual({ allowed: true });
    expect(mocks.findStoreById).toHaveBeenCalledTimes(2);
  });

  it('refuses a tool it does not know', async () => {
    await expect(
      authorizeMercariaCatalogInvocation('dropDatabase', { storeId: STORE_ID }, ACCOUNT_ID),
    ).resolves.toEqual({ allowed: false, reason: 'unknown_catalog_tool' });
  });
});
