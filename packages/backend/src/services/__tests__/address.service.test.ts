/**
 * Unit tests for `address.service`.
 *
 * `mongodb-memory-server` is not available, so the `Address` model is mocked.
 * The key F3 invariant under test: promoting an address to the default
 * (`isDefault: true`) clears every OTHER default for that user (single default
 * per user).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findOne = vi.fn();
const updateMany = vi.fn();

vi.mock('../../models/address.js', () => ({
  Address: {
    findOne: (...args: unknown[]) => findOne(...args),
    updateMany: (...args: unknown[]) => updateMany(...args),
    find: vi.fn(),
    create: vi.fn(),
    exists: vi.fn(),
    deleteOne: vi.fn(),
  },
}));

import { update } from '../address.service.js';

const USER = 'user-1';
const ADDR_ID = '000000000000000000000010';

/** A mock address doc whose `isDefault` is mutated in place by the service. */
function mockAddressDoc(isDefault: boolean) {
  const now = new Date();
  const doc = {
    _id: ADDR_ID,
    oxyUserId: USER,
    recipientName: 'Jane',
    line1: '1 Main St',
    city: 'Town',
    postalCode: '12345',
    country: 'US',
    isDefault,
    createdAt: now,
    updatedAt: now,
    save: vi.fn().mockResolvedValue(undefined),
    toObject() {
      return {
        _id: doc._id,
        oxyUserId: doc.oxyUserId,
        recipientName: doc.recipientName,
        line1: doc.line1,
        city: doc.city,
        postalCode: doc.postalCode,
        country: doc.country,
        isDefault: doc.isDefault,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      };
    },
  };
  return doc;
}

beforeEach(() => {
  findOne.mockReset();
  updateMany.mockReset();
  updateMany.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
});

describe('address.service.update — single-default invariant', () => {
  it('clears every other default when promoting an address to default', async () => {
    const doc = mockAddressDoc(false);
    findOne.mockResolvedValueOnce(doc);

    const dto = await update(USER, ADDR_ID, { isDefault: true });

    // The new address is the default…
    expect(dto.isDefault).toBe(true);
    expect(doc.save).toHaveBeenCalled();
    // …and every OTHER default for this user was cleared (excluding self).
    expect(updateMany).toHaveBeenCalledTimes(1);
    const [filter, patch] = updateMany.mock.calls[0];
    expect(filter).toEqual({ oxyUserId: USER, isDefault: true, _id: { $ne: ADDR_ID } });
    expect(patch).toEqual({ $set: { isDefault: false } });
  });

  it('does not touch other addresses when isDefault is not promoted', async () => {
    const doc = mockAddressDoc(true);
    findOne.mockResolvedValueOnce(doc);

    await update(USER, ADDR_ID, { recipientName: 'John' });

    expect(updateMany).not.toHaveBeenCalled();
    expect(doc.save).toHaveBeenCalled();
  });
});
