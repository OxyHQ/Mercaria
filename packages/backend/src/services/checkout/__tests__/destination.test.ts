/**
 * The actor rules of the checkout destination contract (#105 "Actor rules",
 * "Migration and compatibility").
 *
 * Two of the rules asserted here are STRUCTURAL and cannot be broken by a code
 * change that still compiles — "a guest cannot reference a saved address" and
 * "a guest cannot ask for one to be saved" both rest on
 * `addressBookOwnerForActor` returning `null` for every non-Oxy actor, which is
 * a `switch` over a union with no common `id` field. The tests below still
 * exist, because a future edit could reach for `findAddress` with some other
 * id, and a test is what would notice.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutInput } from '@mercaria/shared-types';
import type { CommerceActor } from '../../commerce-actor.js';

const findAddress = vi.fn();
vi.mock('../../../db/buyers/addressRepository.js', () => ({
  findAddress: (...args: unknown[]) => findAddress(...args),
}));

const {
  addressBookOwnerForActor,
  destinationFromInput,
  resolveCheckoutContract,
} = await import('../destination.js');

const OXY: CommerceActor = { kind: 'oxy', oxyUserId: 'buyer-1' };
const GUEST: CommerceActor = { kind: 'guest', guestSessionId: 'gs-1', transport: 'cookie' };
const ANON: CommerceActor = { kind: 'anonymous' };

const SAVED_ROW = {
  id: 'addr-1',
  recipientName: 'Jane Doe',
  line1: 'Carrer de Colon 1',
  line2: null,
  city: 'Valencia',
  region: null,
  postalCode: '46004',
  country: 'ES',
  phone: null,
};

const INLINE = {
  recipientName: 'Jane Doe',
  line1: 'Carrer de Colon 1',
  city: 'Valencia',
  postalCode: '46004',
  country: 'ES',
};

beforeEach(() => {
  findAddress.mockReset();
  findAddress.mockResolvedValue(SAVED_ROW);
});

describe('the address book is reachable only from an Oxy actor', () => {
  it('maps an Oxy actor to an owner and every other actor to null', () => {
    expect(addressBookOwnerForActor(OXY)).toEqual({ oxyUserId: 'buyer-1' });
    expect(addressBookOwnerForActor(GUEST)).toBeNull();
    expect(addressBookOwnerForActor(ANON)).toBeNull();
  });

  it('resolves a saved address for an Oxy actor, scoped to that account', async () => {
    const result = await resolveCheckoutContract(OXY, {
      destination: { type: 'saved_address', addressId: 'addr-1' },
    });
    expect(findAddress).toHaveBeenCalledWith('buyer-1', 'addr-1');
    expect(result.fulfilment).toMatchObject({ kind: 'shipping', source: 'saved_address' });
  });

  it('refuses a GUEST naming a saved address WITHOUT ever querying for it', async () => {
    await expect(
      resolveCheckoutContract(GUEST, {
        destination: { type: 'saved_address', addressId: 'addr-1' },
        contact: { email: 'jane@example.com' },
      }),
    ).rejects.toThrow(/Oxy account/);
    // The lookup is what would leak whether that id exists; the refusal comes
    // before it because there is no owner to scope one with.
    expect(findAddress).not.toHaveBeenCalled();
  });
});

describe('inline destinations', () => {
  it('accepts an inline address from an Oxy actor and does NOT save it by default', async () => {
    const result = await resolveCheckoutContract(OXY, {
      destination: { type: 'inline_shipping_address', address: INLINE },
    });
    expect(result.fulfilment).toMatchObject({
      kind: 'shipping',
      source: 'inline_shipping_address',
    });
    expect(result.fulfilment).not.toHaveProperty('saveToAddressBook');
  });

  it('carries a save REQUEST only when it was made explicitly', async () => {
    const result = await resolveCheckoutContract(OXY, {
      destination: {
        type: 'inline_shipping_address',
        address: INLINE,
        saveToAddressBook: true,
        saveLabel: 'Home',
      },
    });
    expect(result.fulfilment).toMatchObject({ saveToAddressBook: { label: 'Home' } });
  });

  it('never carries a save request for a guest, even when the field is sent', async () => {
    const result = await resolveCheckoutContract(GUEST, {
      destination: {
        type: 'inline_shipping_address',
        address: INLINE,
        saveToAddressBook: true,
      },
      contact: { email: 'jane@example.com' },
    });
    // A shared form may send the field; a guest has no address book, so the
    // key simply is not there for the checkout to act on.
    expect(result.fulfilment).not.toHaveProperty('saveToAddressBook');
  });

  it('refuses an anonymous caller outright', async () => {
    await expect(
      resolveCheckoutContract(ANON, {
        destination: { type: 'inline_shipping_address', address: INLINE },
      }),
    ).rejects.toThrow(/cart/);
  });
});

describe('contact is required for a guest and optional for an Oxy buyer', () => {
  it('refuses a guest with no contact', async () => {
    await expect(
      resolveCheckoutContract(GUEST, {
        destination: { type: 'inline_shipping_address', address: INLINE },
      }),
    ).rejects.toThrow(/email address/);
  });

  it('accepts an Oxy buyer with no contact, and takes nothing from a profile', async () => {
    const result = await resolveCheckoutContract(OXY, {
      destination: { type: 'saved_address', addressId: 'addr-1' },
    });
    expect(result.contact).toBeUndefined();
  });

  it('accepts an Oxy buyer WITH contact and normalizes it the same way', async () => {
    const result = await resolveCheckoutContract(OXY, {
      destination: { type: 'saved_address', addressId: 'addr-1' },
      contact: { email: 'Jane@Example.COM' },
    });
    expect(result.contact?.displayEmail).toBe('Jane@Example.COM');
    expect(result.contact?.normalizedEmail).toBe('jane@example.com');
  });
});

describe('marketing consent is separate, optional and defaults to false', () => {
  it('is false when absent', async () => {
    const result = await resolveCheckoutContract(OXY, {
      destination: { type: 'saved_address', addressId: 'addr-1' },
    });
    expect(result.marketingOptIn).toBe(false);
  });

  it('is true only when explicitly true', async () => {
    for (const value of [undefined, false] as const) {
      const result = await resolveCheckoutContract(OXY, {
        destination: { type: 'saved_address', addressId: 'addr-1' },
        ...(value === undefined ? {} : { marketingOptIn: value }),
      });
      expect(result.marketingOptIn).toBe(false);
    }
    const optedIn = await resolveCheckoutContract(OXY, {
      destination: { type: 'saved_address', addressId: 'addr-1' },
      marketingOptIn: true,
    });
    expect(optedIn.marketingOptIn).toBe(true);
  });
});

describe('the two contract versions', () => {
  it('maps a v1 `addressId` body to a saved_address destination', () => {
    expect(destinationFromInput({ addressId: 'addr-9' } satisfies CheckoutInput)).toEqual({
      type: 'saved_address',
      addressId: 'addr-9',
    });
  });

  it('passes a v2 destination through untouched', () => {
    const destination = { type: 'pickup', locationId: 'loc-1', pickupContact: { email: 'a@b.co' } } as const;
    expect(destinationFromInput({ destination })).toBe(destination);
  });

  it('refuses a body carrying BOTH rather than inventing a precedence', () => {
    expect(() =>
      destinationFromInput({
        addressId: 'addr-9',
        destination: { type: 'inline_shipping_address', address: INLINE },
      }),
    ).toThrow(/not both/);
  });

  it('refuses a body carrying neither', () => {
    expect(() => destinationFromInput({})).toThrow(/destination/);
  });

  it('drives an OLD client end to end, unchanged', async () => {
    const result = await resolveCheckoutContract(OXY, { addressId: 'addr-1' });
    expect(findAddress).toHaveBeenCalledWith('buyer-1', 'addr-1');
    expect(result.fulfilment).toMatchObject({ kind: 'shipping', source: 'saved_address' });
    expect(result.contact).toBeUndefined();
  });
});

describe('pickup', () => {
  it('produces no address at all — nothing here can fabricate a street', async () => {
    const result = await resolveCheckoutContract(OXY, {
      destination: {
        type: 'pickup',
        locationId: 'loc-1',
        pickupContact: { email: 'collector@example.com', phone: '+34600123456' },
      },
    });
    expect(result.fulfilment).toEqual({
      kind: 'pickup',
      locationId: 'loc-1',
      pickupContact: {
        displayEmail: 'collector@example.com',
        normalizedEmail: 'collector@example.com',
        displayPhone: '+34600123456',
        canonicalPhone: '+34600123456',
      },
    });
    expect(result.impliedShippingMethod).toBe('pickup');
  });
});
