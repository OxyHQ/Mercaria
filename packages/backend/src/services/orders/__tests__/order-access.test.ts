/**
 * #106's authorization section, as a TABLE.
 *
 * The issue names six things order access must authorize and six it must
 * reject. They were previously spread across four routes as four different
 * repository filters, so "does Mercaria reject a sibling seller" was a question
 * you answered by reading code rather than by running something. One pure
 * function makes the whole matrix a test, and this file IS that matrix — every
 * `it` below names the issue's own numbering.
 */

import { describe, expect, it } from 'vitest';
import type { OrderBuyer } from '@mercaria/shared-types';
import {
  authorizeOrderAccess,
  orderAccessSubjectForCommerceActor,
  orderListScopeForSubject,
  resolveGuestPortalSubject,
  type GuestOrderPortalGrant,
  type OrderAccessFacts,
} from '../order-access.service.js';

const NOW = new Date('2026-04-01T12:00:00.000Z');
const GROUP = 'group-1';

/** A store order, whose buyer each case supplies. */
function storeOrder(buyer: OrderBuyer, overrides: Partial<OrderAccessFacts> = {}): OrderAccessFacts {
  return {
    id: 'order-1',
    buyer,
    checkoutGroupId: GROUP,
    sellerType: 'store',
    sellerOxyUserId: null,
    storeId: 'store-1',
    ...overrides,
  };
}

/** A P2P order fulfilled by an individual seller. */
function p2pOrder(buyer: OrderBuyer): OrderAccessFacts {
  return storeOrder(buyer, { sellerType: 'user', sellerOxyUserId: 'seller-1', storeId: null });
}

const OXY_BUYER: OrderBuyer = { origin: 'oxy', oxyUserId: 'oxy-buyer' };
const UNCLAIMED_GUEST: OrderBuyer = { origin: 'guest', guestCheckoutId: 'gc-1' };
const CLAIMED_GUEST: OrderBuyer = {
  origin: 'guest',
  guestCheckoutId: 'gc-1',
  claimedByOxyUserId: 'oxy-claimant',
  claimedAt: NOW.toISOString(),
};

/** A live, inbox-verified portal grant for this group (#108 will mint these). */
function grant(overrides: Partial<GuestOrderPortalGrant> = {}): GuestOrderPortalGrant {
  return {
    grantId: 'grant-1',
    checkoutGroupId: GROUP,
    emailVerified: true,
    expiresAt: new Date(NOW.getTime() + 60_000),
    revokedAt: null,
    ...overrides,
  };
}

describe('#106 authorization — the six it must ALLOW', () => {
  it('1. the original authenticated buyer', () => {
    expect(
      authorizeOrderAccess({ kind: 'oxy_account', oxyUserId: 'oxy-buyer' }, storeOrder(OXY_BUYER), NOW),
    ).toEqual({ allowed: true, reason: 'original_oxy_buyer' });
  });

  it('2. an Oxy account that validly claimed a guest checkout', () => {
    // Reported as `claiming_oxy_account`, NOT as `original_oxy_buyer`: the two
    // are different facts and the audit must be able to tell them apart.
    expect(
      authorizeOrderAccess(
        { kind: 'oxy_account', oxyUserId: 'oxy-claimant' },
        storeOrder(CLAIMED_GUEST),
        NOW,
      ),
    ).toEqual({ allowed: true, reason: 'claiming_oxy_account' });
  });

  it('3. a scoped guest order-portal session (#108 mints the grant)', () => {
    expect(
      authorizeOrderAccess({ kind: 'guest_portal', grant: grant() }, storeOrder(UNCLAIMED_GUEST), NOW),
    ).toEqual({ allowed: true, reason: 'guest_portal_grant' });
  });

  it('4. a store member acting for the store that owns the order', () => {
    expect(
      authorizeOrderAccess({ kind: 'store_member', storeId: 'store-1' }, storeOrder(OXY_BUYER), NOW),
    ).toEqual({ allowed: true, reason: 'store_member' });
  });

  it('5. the P2P seller who must fulfil it', () => {
    expect(
      authorizeOrderAccess(
        { kind: 'p2p_seller', sellerOxyUserId: 'seller-1' },
        p2pOrder(OXY_BUYER),
        NOW,
      ),
    ).toEqual({ allowed: true, reason: 'p2p_seller' });
  });

  it('6. an operator, whose gate is the allow-list and not this function', () => {
    expect(
      authorizeOrderAccess({ kind: 'operator', operatorOxyUserId: 'staff-1' }, storeOrder(UNCLAIMED_GUEST), NOW),
    ).toEqual({ allowed: true, reason: 'operator' });
  });
});

describe('#106 authorization — the six it must REJECT', () => {
  it('1. another guest session with the same email cannot reach the order', () => {
    // There is no email input to this function AT ALL, so "same email" cannot
    // even be expressed — the only guest path is a grant, and a grant is scoped
    // to ONE checkout group. A second guest's grant names a different group.
    expect(
      authorizeOrderAccess(
        { kind: 'guest_portal', grant: grant({ checkoutGroupId: 'somebody-elses-group' }) },
        storeOrder(UNCLAIMED_GUEST),
        NOW,
      ),
    ).toEqual({ allowed: false, reason: 'grant_scope_mismatch' });
  });

  it('2. an Oxy account whose email merely matches gets nothing', () => {
    // Invariant I6. An unclaimed guest order has no Oxy owner, and no argument
    // to this function could make one — which is why the refusal is
    // `order_unclaimed` rather than a comparison that happened to fail.
    expect(
      authorizeOrderAccess(
        { kind: 'oxy_account', oxyUserId: 'oxy-with-the-same-inbox' },
        storeOrder(UNCLAIMED_GUEST),
        NOW,
      ),
    ).toEqual({ allowed: false, reason: 'order_unclaimed' });
  });

  it('3. a sibling seller cannot inspect another seller order', () => {
    expect(
      authorizeOrderAccess({ kind: 'store_member', storeId: 'store-2' }, storeOrder(OXY_BUYER), NOW),
    ).toEqual({ allowed: false, reason: 'not_this_sellers_order' });
    expect(
      authorizeOrderAccess(
        { kind: 'p2p_seller', sellerOxyUserId: 'seller-2' },
        p2pOrder(OXY_BUYER),
        NOW,
      ),
    ).toEqual({ allowed: false, reason: 'not_this_sellers_order' });
  });

  it('3b. a STORE member cannot reach a P2P order and a P2P seller cannot reach a store order', () => {
    // The seller TYPE is tested as well as the id, so the refusal does not
    // depend on `orders_seller_exclusivity_check` holding.
    expect(
      authorizeOrderAccess({ kind: 'store_member', storeId: 'store-1' }, p2pOrder(OXY_BUYER), NOW).allowed,
    ).toBe(false);
    expect(
      authorizeOrderAccess(
        { kind: 'p2p_seller', sellerOxyUserId: 'seller-1' },
        storeOrder(OXY_BUYER),
        NOW,
      ).allowed,
    ).toBe(false);
  });

  it('4. a CART token presented as paid-order access is structurally impossible', () => {
    // Invariant I3, and the reason it is asserted on the TRANSLATION rather
    // than on the decision: a live guest cart session never becomes a subject
    // at all, so there is no branch of `authorizeOrderAccess` it could reach.
    expect(
      orderAccessSubjectForCommerceActor({
        kind: 'guest',
        guestSessionId: 'gs-live',
        transport: 'cookie',
      }),
    ).toBeNull();
    expect(orderAccessSubjectForCommerceActor({ kind: 'anonymous' })).toBeNull();
  });

  it('4b. a guest credential presented ALONGSIDE Oxy auth is not order access either', () => {
    // `presentedGuestSessionId` has exactly two legitimate consumers (cart
    // merge and claim) and this is neither: the subject is the OXY account and
    // carries no trace of the guest session.
    expect(
      orderAccessSubjectForCommerceActor({
        kind: 'oxy',
        oxyUserId: 'oxy-buyer',
        presentedGuestSessionId: 'gs-live',
      }),
    ).toEqual({ kind: 'oxy_account', oxyUserId: 'oxy-buyer' });
  });

  it('5. an order number plus public contact fields authorize nothing', () => {
    // Invariants I2/I4, held by the SIGNATURE: `OrderAccessSubject` has no
    // member carrying an email, a phone or an order number, so the pair cannot
    // be presented. The runtime proof is that the only subject an unauthenticated
    // caller can produce is none at all.
    expect(orderAccessSubjectForCommerceActor({ kind: 'anonymous' })).toBeNull();
    expect(resolveGuestPortalSubject()).toBeNull();
  });

  it('6. claimed-buyer access ENDS when the claim is revoked', () => {
    // ADR 0003 D6 permits the claim pair to move value → NULL (an audited
    // operator unclaim). After it, the order is an unclaimed guest order again
    // and the former claimant is refused — with no second mechanism to keep in
    // step, because the access was always derived from the pair.
    const beforeRevocation = authorizeOrderAccess(
      { kind: 'oxy_account', oxyUserId: 'oxy-claimant' },
      storeOrder(CLAIMED_GUEST),
      NOW,
    );
    const afterRevocation = authorizeOrderAccess(
      { kind: 'oxy_account', oxyUserId: 'oxy-claimant' },
      storeOrder(UNCLAIMED_GUEST),
      NOW,
    );
    expect(beforeRevocation.allowed).toBe(true);
    expect(afterRevocation).toEqual({ allowed: false, reason: 'order_unclaimed' });
  });
});

describe('portal grant liveness — the three ways a grant stops working', () => {
  it('refuses an EXPIRED grant', () => {
    expect(
      authorizeOrderAccess(
        { kind: 'guest_portal', grant: grant({ expiresAt: new Date(NOW.getTime() - 1) }) },
        storeOrder(UNCLAIMED_GUEST),
        NOW,
      ),
    ).toEqual({ allowed: false, reason: 'grant_expired' });
  });

  it('refuses a grant expiring at exactly NOW — the boundary is closed', () => {
    expect(
      authorizeOrderAccess(
        { kind: 'guest_portal', grant: grant({ expiresAt: NOW }) },
        storeOrder(UNCLAIMED_GUEST),
        NOW,
      ),
    ).toEqual({ allowed: false, reason: 'grant_expired' });
  });

  it('refuses a REVOKED grant, even one that has not expired', () => {
    expect(
      authorizeOrderAccess(
        { kind: 'guest_portal', grant: grant({ revokedAt: new Date(NOW.getTime() - 1000) }) },
        storeOrder(UNCLAIMED_GUEST),
        NOW,
      ),
    ).toEqual({ allowed: false, reason: 'grant_revoked' });
  });

  it('refuses a grant with no proven inbox behind it (ADR 0003 D17)', () => {
    // A `post_checkout` grant tracks status from the device that bought; full
    // order access is retrospective and needs the magic-link chain.
    expect(
      authorizeOrderAccess(
        { kind: 'guest_portal', grant: grant({ emailVerified: false }) },
        storeOrder(UNCLAIMED_GUEST),
        NOW,
      ),
    ).toEqual({ allowed: false, reason: 'grant_not_email_verified' });
  });

  it('refuses a grant against an order with NO checkout group at all', () => {
    // A connector import carries none. The comparison is `!==` rather than a
    // null guard precisely so there is no branch in which a missing group could
    // read as a wildcard.
    expect(
      authorizeOrderAccess(
        { kind: 'guest_portal', grant: grant() },
        storeOrder(UNCLAIMED_GUEST, { checkoutGroupId: null }),
        NOW,
      ),
    ).toEqual({ allowed: false, reason: 'grant_scope_mismatch' });
  });
});

describe('list scopes — what each subject may ENUMERATE', () => {
  it('an Oxy account lists what it bought OR claimed', () => {
    expect(orderListScopeForSubject({ kind: 'oxy_account', oxyUserId: 'oxy-1' })).toEqual({
      kind: 'buyer_or_claimant',
      oxyUserId: 'oxy-1',
    });
  });

  it('a seller lists their own orders', () => {
    expect(orderListScopeForSubject({ kind: 'store_member', storeId: 'store-1' })).toEqual({
      kind: 'store',
      storeId: 'store-1',
    });
    expect(orderListScopeForSubject({ kind: 'p2p_seller', sellerOxyUserId: 'seller-1' })).toEqual({
      kind: 'p2p_seller',
      sellerOxyUserId: 'seller-1',
    });
  });

  it('a portal grant and an OPERATOR enumerate nothing', () => {
    // A grant reads ONE group (#108's own scoped read) and an operator opens
    // from a named handle — neither gets an unbounded list of anybody's orders.
    expect(orderListScopeForSubject({ kind: 'guest_portal', grant: grant() })).toBeNull();
    expect(orderListScopeForSubject({ kind: 'operator', operatorOxyUserId: 'staff-1' })).toBeNull();
  });
});
