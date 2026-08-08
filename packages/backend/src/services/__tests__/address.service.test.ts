/**
 * Unit tests for `address.service`.
 *
 * The `addresses` table is Postgres now, so `db/buyers/addressRepository` is
 * mocked in place of the `Address` model.
 *
 * ## The single-default invariant is no longer testable HERE, and that is a gain
 *
 * The previous version of this file asserted that promoting an address issued an
 * `updateMany` clearing every OTHER default — the service's own two-statement
 * implementation of an invariant Mongo could not state. That implementation is
 * gone: `addresses_oxy_user_id_default_key` is a partial unique index, and the
 * demote+promote pair now lives inside ONE repository transaction because the
 * index rejects any other ordering. A mocked repository cannot tell a real
 * transaction from a function that returns the right object, so asserting it here
 * would prove nothing about the property. It is asserted against a real server in
 * `db/__tests__/buyers.realdb.test.ts`, including that two defaults are genuinely
 * REFUSED — which is the half no mock can reach.
 *
 * What stays here is what the service still decides: forwarding the caller's
 * scope and patch unchanged, turning a repository miss into NOT_FOUND, and
 * serializing a row whose optional fields are NULL rather than absent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findAddressesByUser = vi.fn();
const insertAddress = vi.fn();
const updateAddress = vi.fn();
const deleteAddress = vi.fn();

vi.mock('../../db/buyers/addressRepository.js', () => ({
  findAddressesByUser: (...args: unknown[]) => findAddressesByUser(...args),
  insertAddress: (...args: unknown[]) => insertAddress(...args),
  updateAddress: (...args: unknown[]) => updateAddress(...args),
  deleteAddress: (...args: unknown[]) => deleteAddress(...args),
}));

import { create, list, remove, update } from '../address.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const USER = 'user-1';
const ADDR_ID = '000000000000000000000010';

/** Every row fixture carries the same timestamps; none of them is asserted on. */
const AT = new Date('2026-01-01T00:00:00.000Z');

/**
 * An `addresses` ROW as the repository returns it: flat, `id` rather than `_id`,
 * and every optional field NULL rather than absent.
 */
function addressRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ADDR_ID,
    oxyUserId: USER,
    label: null,
    recipientName: 'Jane',
    line1: '1 Main St',
    line2: null,
    city: 'Town',
    region: null,
    postalCode: '12345',
    country: 'US',
    phone: null,
    isDefault: false,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('address.service.update', () => {
  it('forwards the buyer scope, the address id and the patch unchanged', async () => {
    // The promotion itself is the repository's transaction; what the service owes
    // is that the caller's scope reaches it, since that scoping IS the
    // authorization for this address.
    updateAddress.mockResolvedValue(addressRow({ isDefault: true }));

    const dto = await update(USER, ADDR_ID, { isDefault: true });

    expect(updateAddress).toHaveBeenCalledWith(USER, ADDR_ID, { isDefault: true });
    expect(dto.isDefault).toBe(true);
  });

  it('raises NOT_FOUND when the address is not the buyer’s', async () => {
    // The repository returns `null` for "no such address" AND for "someone
    // else's" — the caller cannot tell them apart, which is the point.
    updateAddress.mockResolvedValue(null);

    await expect(update(USER, ADDR_ID, { recipientName: 'John' })).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );
  });
});

describe('address.service.remove', () => {
  it('raises NOT_FOUND when nothing was deleted', async () => {
    deleteAddress.mockResolvedValue({ deleted: false, promotedId: null });

    await expect(remove(USER, ADDR_ID)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );
  });

  it('succeeds when the row was removed, whether or not a successor was promoted', async () => {
    deleteAddress.mockResolvedValue({ deleted: true, promotedId: 'address-2' });

    await expect(remove(USER, ADDR_ID)).resolves.toBeUndefined();
    expect(deleteAddress).toHaveBeenCalledWith(USER, ADDR_ID);
  });
});

describe('address.service — serialization', () => {
  it('omits NULL optionals rather than emitting them as null', async () => {
    // Mongo left an unset optional ABSENT; Postgres stores NULL. Emitting the
    // null would make every client special-case a field that used to be missing.
    findAddressesByUser.mockResolvedValue([addressRow()]);

    const [dto] = await list(USER);

    expect(Object.hasOwn(dto, 'label')).toBe(false);
    expect(Object.hasOwn(dto, 'line2')).toBe(false);
    expect(Object.hasOwn(dto, 'region')).toBe(false);
    expect(Object.hasOwn(dto, 'phone')).toBe(false);
    expect(dto).toMatchObject({ id: ADDR_ID, recipientName: 'Jane', isDefault: false });
  });

  it('carries the optional fields through when they are set', async () => {
    // The mirror case: without it the assertion above passes against a
    // serializer that drops those four fields unconditionally.
    insertAddress.mockResolvedValue(
      addressRow({ label: 'Home', line2: 'Apt 4', region: 'CA', phone: '+15551234' }),
    );

    const dto = await create(USER, {
      recipientName: 'Jane',
      line1: '1 Main St',
      line2: 'Apt 4',
      label: 'Home',
      region: 'CA',
      phone: '+15551234',
      city: 'Town',
      postalCode: '12345',
      country: 'US',
    });

    expect(dto).toMatchObject({
      label: 'Home',
      line2: 'Apt 4',
      region: 'CA',
      phone: '+15551234',
    });
  });
});
