/**
 * `orderBuyerOf` and `accountWithBuyerAccess` — the ONE translation from an
 * `orders` row's five buyer columns to the {@link OrderBuyer} union (#106).
 *
 * These are pure functions over row shapes, so the value of the tests is in
 * WHICH shapes: each case below is one disjunct of
 * `orders_buyer_identity_check`, plus the two the CHECK forbids, which the
 * function must refuse rather than paper over.
 */

import { describe, expect, it } from 'vitest';
import { accountWithBuyerAccess, orderBuyerOf } from '../order-buyer.js';
import type { OrderBuyerColumns } from '../order-buyer.js';

const CLAIMED_AT = new Date('2026-03-04T05:06:07.000Z');

/** A row with every buyer column empty; each case fills in its own disjunct. */
function row(overrides: Partial<OrderBuyerColumns>): OrderBuyerColumns {
  return {
    buyerOrigin: 'oxy',
    buyerOxyUserId: null,
    buyerGuestCheckoutId: null,
    claimedByOxyUserId: null,
    claimedAt: null,
    sourceProvider: null,
    sourceExternalId: null,
    ...overrides,
  };
}

describe('orderBuyerOf — one union member per legal row shape', () => {
  it('reads an oxy-origin order as its ORIGIN owner', () => {
    const buyer = orderBuyerOf(row({ buyerOrigin: 'oxy', buyerOxyUserId: 'oxy-1' }));
    expect(buyer).toEqual({ origin: 'oxy', oxyUserId: 'oxy-1' });
  });

  it('reads an UNCLAIMED guest order with no claim properties at all', () => {
    // Not `claimedByOxyUserId: undefined` and not an empty string: the property
    // is ABSENT, so a consumer cannot test it for truthiness by accident and
    // read "" as an account id.
    const buyer = orderBuyerOf(row({ buyerOrigin: 'guest', buyerGuestCheckoutId: 'gc-1' }));
    expect(buyer).toEqual({ origin: 'guest', guestCheckoutId: 'gc-1' });
    expect('claimedByOxyUserId' in buyer).toBe(false);
  });

  it('reads a CLAIMED guest order as still GUEST, with the claimant beside it', () => {
    // Invariant I7, at the read layer: the origin survives the claim, and the
    // claimant is inside the guest member rather than replacing it.
    const buyer = orderBuyerOf(
      row({
        buyerOrigin: 'guest',
        buyerGuestCheckoutId: 'gc-1',
        claimedByOxyUserId: 'oxy-9',
        claimedAt: CLAIMED_AT,
      }),
    );
    expect(buyer).toEqual({
      origin: 'guest',
      guestCheckoutId: 'gc-1',
      claimedByOxyUserId: 'oxy-9',
      claimedAt: CLAIMED_AT.toISOString(),
    });
  });

  it('reads an external import as its provenance, never as a buyer id', () => {
    const buyer = orderBuyerOf(
      row({
        buyerOrigin: 'external',
        // The legacy `ext:` value stays in the column and must NOT surface as
        // an Oxy account id — ADR 0003 M9 retires the write, not the data.
        buyerOxyUserId: 'ext:shopify:42',
        sourceProvider: 'shopify',
        sourceExternalId: '42',
      }),
    );
    expect(buyer).toEqual({
      origin: 'external',
      connectorProvider: 'shopify',
      externalReference: '42',
    });
  });

  it('reads an external import with no recorded provenance as bare external', () => {
    expect(orderBuyerOf(row({ buyerOrigin: 'external' }))).toEqual({ origin: 'external' });
  });
});

describe('orderBuyerOf — a row the CHECK forbids is REFUSED, never patched over', () => {
  it('raises on an oxy order with no buyer id', () => {
    expect(() => orderBuyerOf(row({ buyerOrigin: 'oxy' }))).toThrow(/buyer_oxy_user_id/);
  });

  it('raises on a guest order with no contact record', () => {
    expect(() => orderBuyerOf(row({ buyerOrigin: 'guest' }))).toThrow(
      /buyer_guest_checkout_id/,
    );
  });
});

describe('accountWithBuyerAccess — which Oxy account may read the order', () => {
  it('is the original owner for an oxy order', () => {
    expect(accountWithBuyerAccess({ origin: 'oxy', oxyUserId: 'oxy-1' })).toBe('oxy-1');
  });

  it('is NOBODY for an unclaimed guest order', () => {
    expect(accountWithBuyerAccess({ origin: 'guest', guestCheckoutId: 'gc-1' })).toBeUndefined();
  });

  it('is the CLAIMANT for a claimed guest order — the second owner, not the first', () => {
    expect(
      accountWithBuyerAccess({
        origin: 'guest',
        guestCheckoutId: 'gc-1',
        claimedByOxyUserId: 'oxy-9',
        claimedAt: CLAIMED_AT.toISOString(),
      }),
    ).toBe('oxy-9');
  });

  it('is NOBODY for an external import, whatever its legacy buyer column held', () => {
    expect(
      accountWithBuyerAccess({
        origin: 'external',
        connectorProvider: 'shopify',
        externalReference: '42',
      }),
    ).toBeUndefined();
  });
});
