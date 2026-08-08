/**
 * Unit tests for `store.service` owner-protection invariants.
 *
 * The repository is mocked, so nothing here opens a database: what is under test
 * is the DECISION — who may demote whom — which is pure logic over the member
 * list and identical before and after the Postgres port.
 *
 * ## What moved OUT of this file, and where it went
 *
 * The old `updateStoreSettings` tests asserted that an ABSENT
 * `notificationSettings`/`taxSettings` block was reconstructed from defaults
 * before being patched. That behaviour is gone rather than changed: all six
 * columns are NOT NULL with exactly the defaults the old code substituted, so
 * there is no absent block left to rebuild. What remains testable HERE is that a
 * patch touches only the fields it names — asserted against the column patch the
 * service hands the repository, which is the whole of its contribution now. That
 * the defaults really are what the columns carry is a property of the DDL, and
 * is asserted against a real database in `db/__tests__/stores.realdb.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StoreMemberRecord, StoreRecord } from '../../db/stores/storeRepository.js';

const findStoreById = vi.fn();
const updateStoreColumns = vi.fn();
const updateStoreMember = vi.fn();
const deleteStoreMember = vi.fn();

vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoreById: (...args: unknown[]) => findStoreById(...args),
  findStoresForMember: vi.fn(),
  insertStore: vi.fn(),
  insertStoreMember: vi.fn(),
  deleteStoreMember: (...args: unknown[]) => deleteStoreMember(...args),
  storeHandleExists: vi.fn().mockResolvedValue(false),
  updateStoreColumns: (...args: unknown[]) => updateStoreColumns(...args),
  updateStoreMember: (...args: unknown[]) => updateStoreMember(...args),
}));

vi.mock('../../db/stores/locationRepository.js', () => ({
  insertLocation: vi.fn(),
}));

import { updateMember, removeMember, updateStoreSettings } from '../store.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const STORE_ID = '000000000000000000000099';

function mkMember(oxyUserId: string, role: StoreMemberRecord['role']): StoreMemberRecord {
  return {
    id: `member-${oxyUserId}`,
    storeId: STORE_ID,
    oxyUserId,
    role,
    permissions: [],
    invitedBy: null,
    joinedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * A store record carrying only what the owner-protection logic reads.
 *
 * Cast rather than spelled out in full: `StoreRecord` has thirty columns and the
 * decision under test reads exactly two of them, so listing the rest would be
 * thirty lines of noise that also has to be maintained every time a column is
 * added. The cast is confined to this helper.
 */
function mkStore(members: StoreMemberRecord[]): StoreRecord {
  return { id: STORE_ID, name: 'Test store', members } as unknown as StoreRecord;
}

beforeEach(() => {
  findStoreById.mockReset();
  updateStoreColumns.mockReset();
  updateStoreMember.mockReset().mockResolvedValue(undefined);
  deleteStoreMember.mockReset().mockResolvedValue(undefined);
});

describe('store.service owner protection — removeMember', () => {
  it('rejects removing the last owner (CONFLICT)', async () => {
    const owner = mkMember('owner-1', 'owner');
    findStoreById.mockResolvedValueOnce(mkStore([owner, mkMember('staff-1', 'staff')]));

    await expect(removeMember(STORE_ID, owner, 'owner-1')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );
    expect(deleteStoreMember).not.toHaveBeenCalled();
  });

  it('rejects a non-owner removing an owner (FORBIDDEN)', async () => {
    const admin = mkMember('admin-1', 'admin');
    findStoreById.mockResolvedValueOnce(mkStore([mkMember('owner-1', 'owner'), admin]));

    await expect(removeMember(STORE_ID, admin, 'owner-1')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
    expect(deleteStoreMember).not.toHaveBeenCalled();
  });

  it('allows an owner to remove a SECOND owner', async () => {
    const owner = mkMember('owner-1', 'owner');
    const store = mkStore([owner, mkMember('owner-2', 'owner')]);
    // Once for the guard read, once for the re-read the service returns.
    findStoreById.mockResolvedValue(store);

    await removeMember(STORE_ID, owner, 'owner-2');
    expect(deleteStoreMember).toHaveBeenCalledWith(STORE_ID, 'owner-2');
  });

  it('allows an admin to remove staff', async () => {
    const admin = mkMember('admin-1', 'admin');
    findStoreById.mockResolvedValue(mkStore([mkMember('owner-1', 'owner'), admin, mkMember('staff-1', 'staff')]));

    await removeMember(STORE_ID, admin, 'staff-1');
    expect(deleteStoreMember).toHaveBeenCalledWith(STORE_ID, 'staff-1');
  });

  it('throws NOT_FOUND for a member who is not on the store', async () => {
    const owner = mkMember('owner-1', 'owner');
    findStoreById.mockResolvedValueOnce(mkStore([owner]));

    await expect(removeMember(STORE_ID, owner, 'nobody')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );
  });
});

describe('store.service owner protection — updateMember', () => {
  it('rejects demoting the last owner (CONFLICT)', async () => {
    const owner = mkMember('owner-1', 'owner');
    findStoreById.mockResolvedValueOnce(mkStore([owner, mkMember('staff-1', 'staff')]));

    await expect(
      updateMember(STORE_ID, owner, 'owner-1', { role: 'admin' }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );
    expect(updateStoreMember).not.toHaveBeenCalled();
  });

  it('rejects a non-owner modifying an owner (FORBIDDEN)', async () => {
    const admin = mkMember('admin-1', 'admin');
    findStoreById.mockResolvedValueOnce(mkStore([mkMember('owner-1', 'owner'), admin]));

    await expect(
      updateMember(STORE_ID, admin, 'owner-1', { role: 'staff' }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
    expect(updateStoreMember).not.toHaveBeenCalled();
  });

  it('rejects a non-owner GRANTING the owner role (FORBIDDEN)', async () => {
    const admin = mkMember('admin-1', 'admin');
    findStoreById.mockResolvedValueOnce(
      mkStore([mkMember('owner-1', 'owner'), admin, mkMember('staff-1', 'staff')]),
    );

    await expect(
      updateMember(STORE_ID, admin, 'staff-1', { role: 'owner' }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
    expect(updateStoreMember).not.toHaveBeenCalled();
  });

  it('allows an owner to demote a SECOND owner', async () => {
    const owner = mkMember('owner-1', 'owner');
    findStoreById.mockResolvedValue(mkStore([owner, mkMember('owner-2', 'owner')]));

    await updateMember(STORE_ID, owner, 'owner-2', { role: 'admin' });
    expect(updateStoreMember).toHaveBeenCalledWith(STORE_ID, 'owner-2', { role: 'admin' });
  });
});

describe('store.service.updateStoreSettings', () => {
  /** The column patch the service handed the repository on its only call. */
  function patchSent(): Record<string, unknown> {
    expect(updateStoreColumns).toHaveBeenCalledTimes(1);
    return updateStoreColumns.mock.calls[0][1] as Record<string, unknown>;
  }

  beforeEach(() => {
    updateStoreColumns.mockResolvedValue(mkStore([]));
  });

  it('flattens long-form policies and notification settings into their columns', async () => {
    await updateStoreSettings(STORE_ID, {
      policies: {
        refundPolicy: 'Returns within 30 days.',
        privacyPolicy: 'We respect your privacy.',
        termsOfService: 'Be excellent to each other.',
      },
      notificationSettings: { lowStockAlerts: false, lowStockThreshold: 3 },
    });

    expect(patchSent()).toEqual({
      policiesRefundPolicy: 'Returns within 30 days.',
      policiesPrivacyPolicy: 'We respect your privacy.',
      policiesTermsOfService: 'Be excellent to each other.',
      notificationSettingsLowStockAlerts: false,
      notificationSettingsLowStockThreshold: 3,
    });
  });

  it('names ONLY the fields the patch supplied', async () => {
    // The assertion that matters, and the reason it is `toEqual` on the whole
    // object rather than a handful of `toHaveProperty`s: an UPDATE that also
    // named `orderEmails` would overwrite a merchant's setting with the default,
    // and a subset assertion cannot see an EXTRA key.
    await updateStoreSettings(STORE_ID, {
      notificationSettings: { orderEmails: false },
    });

    expect(patchSent()).toEqual({ notificationSettingsOrderEmails: false });
  });

  it('folds a tax-settings patch through the same path', async () => {
    await updateStoreSettings(STORE_ID, {
      taxSettings: { pricesIncludeTax: true, taxRegistrationId: 'ES-B12345678' },
    });

    expect(patchSent()).toEqual({
      taxSettingsPricesIncludeTax: true,
      taxSettingsTaxRegistrationId: 'ES-B12345678',
    });
  });

  it('throws NOT_FOUND when the store does not exist', async () => {
    updateStoreColumns.mockResolvedValueOnce(null);

    await expect(
      updateStoreSettings(STORE_ID, { policies: { refundPolicy: 'x' } }),
    ).rejects.toSatisfy((err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND);
  });
});
