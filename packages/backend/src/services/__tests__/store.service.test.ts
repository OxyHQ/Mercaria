/**
 * Unit tests for `store.service` owner-protection invariants.
 *
 * `Store` is mocked (no DB). Tests assert: the last owner cannot be removed or
 * demoted, and a non-owner cannot remove/modify an owner. The happy paths
 * (owner removing a second owner, admin removing staff) confirm the guards are
 * not over-broad.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IStoreMember } from '../../models/store.js';

const findById = vi.fn();

vi.mock('../../models/store.js', () => ({
  Store: {
    findById: (...args: unknown[]) => findById(...args),
    exists: vi.fn().mockResolvedValue(null),
  },
  ALL_STORE_PERMISSIONS: [
    'store:manage',
    'members:manage',
    'products:read',
    'products:write',
    'inventory:write',
    'orders:read',
    'orders:fulfill',
    'stats:read',
  ],
}));

import { updateMember, removeMember } from '../store.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const STORE_ID = '000000000000000000000099';

function mkMember(oxyUserId: string, role: IStoreMember['role']): IStoreMember {
  return { oxyUserId, role, permissions: [], joinedAt: new Date() };
}

/** A mock store doc whose `members` array is mutated in place by the service. */
function mockStoreDoc(members: IStoreMember[]) {
  const doc = {
    _id: STORE_ID,
    members,
    save: vi.fn().mockResolvedValue(undefined),
    toObject() {
      return { _id: STORE_ID, members: doc.members };
    },
  };
  return doc;
}

beforeEach(() => {
  findById.mockReset();
});

describe('store.service owner protection — removeMember', () => {
  it('rejects removing the last owner (CONFLICT)', async () => {
    const owner = mkMember('owner-1', 'owner');
    findById.mockResolvedValueOnce(mockStoreDoc([owner, mkMember('staff-1', 'staff')]));

    await expect(removeMember(STORE_ID, owner, 'owner-1')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );
  });

  it('rejects a non-owner removing an owner (FORBIDDEN)', async () => {
    const admin = mkMember('admin-1', 'admin');
    findById.mockResolvedValueOnce(
      mockStoreDoc([mkMember('owner-1', 'owner'), admin]),
    );

    await expect(removeMember(STORE_ID, admin, 'owner-1')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
  });

  it('allows an owner to remove a SECOND owner (>1 owner remains-safe)', async () => {
    const owner1 = mkMember('owner-1', 'owner');
    const doc = mockStoreDoc([owner1, mkMember('owner-2', 'owner')]);
    findById.mockResolvedValueOnce(doc);

    const result = await removeMember(STORE_ID, owner1, 'owner-2');

    expect(doc.save).toHaveBeenCalled();
    expect(result.members.map((m) => m.oxyUserId)).toEqual(['owner-1']);
  });

  it('allows an admin to remove a staff member', async () => {
    const admin = mkMember('admin-1', 'admin');
    const doc = mockStoreDoc([
      mkMember('owner-1', 'owner'),
      admin,
      mkMember('staff-1', 'staff'),
    ]);
    findById.mockResolvedValueOnce(doc);

    const result = await removeMember(STORE_ID, admin, 'staff-1');

    expect(result.members.some((m) => m.oxyUserId === 'staff-1')).toBe(false);
  });
});

describe('store.service owner protection — updateMember', () => {
  it('rejects demoting the last owner (CONFLICT)', async () => {
    const owner = mkMember('owner-1', 'owner');
    findById.mockResolvedValueOnce(mockStoreDoc([owner, mkMember('staff-1', 'staff')]));

    await expect(
      updateMember(STORE_ID, owner, 'owner-1', { role: 'admin' }),
    ).rejects.toSatisfy((err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT);
  });

  it('rejects a non-owner modifying an owner (FORBIDDEN)', async () => {
    const admin = mkMember('admin-1', 'admin');
    findById.mockResolvedValueOnce(
      mockStoreDoc([mkMember('owner-1', 'owner'), admin]),
    );

    await expect(
      updateMember(STORE_ID, admin, 'owner-1', { role: 'staff' }),
    ).rejects.toSatisfy((err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN);
  });

  it('rejects a non-owner promoting someone to owner (FORBIDDEN)', async () => {
    const admin = mkMember('admin-1', 'admin');
    findById.mockResolvedValueOnce(
      mockStoreDoc([mkMember('owner-1', 'owner'), admin, mkMember('staff-1', 'staff')]),
    );

    await expect(
      updateMember(STORE_ID, admin, 'staff-1', { role: 'owner' }),
    ).rejects.toSatisfy((err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN);
  });

  it('allows an owner to demote a SECOND owner (another owner remains)', async () => {
    const owner1 = mkMember('owner-1', 'owner');
    const doc = mockStoreDoc([owner1, mkMember('owner-2', 'owner')]);
    findById.mockResolvedValueOnce(doc);

    const result = await updateMember(STORE_ID, owner1, 'owner-2', { role: 'admin' });

    expect(doc.save).toHaveBeenCalled();
    expect(result.members.find((m) => m.oxyUserId === 'owner-2')?.role).toBe('admin');
  });
});
