/**
 * The guest-P2P gate: default closed, server-authoritative by seller type, and
 * deterministic on a mixed cart (#112 default state 1–6, acceptance 4, 6, 9).
 *
 * Pure functions over an actor and a group list, so every case is a table row.
 * What is worth reading is which groups a refusal NAMES — the remedy for a
 * mixed cart is to deselect them — and what it does not say.
 */

import { describe, expect, it } from 'vitest';
import { CHECKOUT_REFUSAL_REASONS } from '../../checkout/refusal.js';
import { isCheckoutRefusal } from '../../checkout/refusal.js';
import { GUEST_CHECKOUT_BLOCK_REASONS } from '@mercaria/shared-types';
import type { CommerceActor } from '../../commerce-actor.js';
import { readGuestP2PAuthorization } from '../authorization.js';
import {
  assertGuestP2PCheckoutAllowed,
  assertGuestP2PPaymentAllowed,
  guestCheckoutAvailabilityFor,
  guestP2PBlockedSellerKeys,
  p2pSellerKeys,
} from '../gate.js';

const GUEST: CommerceActor = { kind: 'guest', guestSessionId: 'gs-1', transport: 'cookie' };
const GUEST_NATIVE: CommerceActor = { kind: 'guest', guestSessionId: 'gs-2', transport: 'header' };
const OXY: CommerceActor = { kind: 'oxy', oxyUserId: 'buyer-1' };
const ANONYMOUS: CommerceActor = { kind: 'anonymous' };

const STORE = { sellerKey: 'store:store-A', sellerType: 'store' } as const;
const STORE_B = { sellerKey: 'store:store-B', sellerType: 'store' } as const;
const PERSON = { sellerKey: 'user:seller-9', sellerType: 'user' } as const;
const PERSON_B = { sellerKey: 'user:seller-2', sellerType: 'user' } as const;
const RETAIL = { sellerKey: 'platform:mercaria', sellerType: 'platform' } as const;

describe('the decision is recorded, and no state means yes', () => {
  it('reports the dated no-go decision it is published under', () => {
    const authorization = readGuestP2PAuthorization();
    expect(authorization.state).toBe('not_authorized');
    expect(authorization.decision.outcome).toBe('no_go');
    expect(authorization.decision.date).toBe('2026-08-10');
    expect(authorization.decision.documentPath).toMatch(/^docs\/guest-p2p\/.+\.md$/);
  });

  it('takes no argument, so no combination of inputs can find a yes', () => {
    expect(readGuestP2PAuthorization).toHaveLength(0);
  });
});

describe('the gate is default CLOSED and refuses only the P2P groups', () => {
  it('refuses a guest buying from an individual seller, naming that seller', () => {
    try {
      assertGuestP2PCheckoutAllowed({ actor: GUEST, groups: [STORE, PERSON] });
      expect.unreachable('a guest P2P group must be refused');
    } catch (err) {
      expect(isCheckoutRefusal(err)).toBe(true);
      const message = (err as Error).message;
      // Named, and ONLY the offending one: the store group is still placeable
      // through `sellerKeys`, which is what "separate, do not reject the whole
      // cart" means on the wire.
      expect(message).toContain('user:seller-9');
      expect(message).not.toContain('store:store-A');
    }
  });

  it('uses ONE reason code, and it is a member of the checkout vocabulary', () => {
    try {
      assertGuestP2PCheckoutAllowed({ actor: GUEST, groups: [PERSON] });
      expect.unreachable('a guest P2P group must be refused');
    } catch (err) {
      expect(isCheckoutRefusal(err)).toBe(true);
      if (!isCheckoutRefusal(err)) return;
      expect(err.reason).toBe('p2p_seller_excluded');
      expect(CHECKOUT_REFUSAL_REASONS).toContain(err.reason);
    }
  });

  it('names every P2P seller in a cart that has several, sorted', () => {
    try {
      assertGuestP2PCheckoutAllowed({ actor: GUEST, groups: [PERSON, STORE, PERSON_B] });
      expect.unreachable('a guest P2P group must be refused');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('user:seller-2, user:seller-9');
    }
  });

  it('refuses on either guest transport — the credential carriage is not the gate', () => {
    for (const actor of [GUEST, GUEST_NATIVE]) {
      expect(() => assertGuestP2PCheckoutAllowed({ actor, groups: [PERSON] })).toThrow(
        /individual seller/,
      );
    }
  });

  it('leaves a guest store-only cart alone, including the retail pseudo-group', () => {
    expect(() =>
      assertGuestP2PCheckoutAllowed({ actor: GUEST, groups: [STORE, STORE_B, RETAIL] }),
    ).not.toThrow();
  });

  it('leaves an Oxy buyer and an anonymous caller alone (acceptance 9)', () => {
    for (const actor of [OXY, ANONYMOUS]) {
      expect(() =>
        assertGuestP2PCheckoutAllowed({ actor, groups: [PERSON, STORE] }),
      ).not.toThrow();
    }
  });

  it('leaks nothing about the cart', () => {
    try {
      assertGuestP2PCheckoutAllowed({ actor: GUEST, groups: [PERSON] });
      expect.unreachable('a guest P2P group must be refused');
    } catch (err) {
      expect((err as Error).message).not.toMatch(
        /quantity|stock|variant|listing|available|price|€|\$/i,
      );
    }
  });

  it('says nothing about WHY beyond the one code — no criterion is nameable', () => {
    try {
      assertGuestP2PCheckoutAllowed({ actor: GUEST, groups: [PERSON] });
      expect.unreachable('a guest P2P group must be refused');
    } catch (err) {
      const message = (err as Error).message;
      // A client varying one input at a time must not be able to read out the
      // policy: no criterion name, no market, no cap, no trust tier.
      expect(message).not.toMatch(/trust|payout|stripe|category|photo|condition|cap|market/i);
    }
  });
});

describe('the pre-payment revalidation seam (checkout behaviour 2, acceptance 6)', () => {
  it('refuses before the rail is opened when a guest group reached order placement', () => {
    try {
      assertGuestP2PPaymentAllowed({
        actor: GUEST,
        orders: [
          { id: 'order-store', sellerType: 'store' },
          { id: 'order-person', sellerType: 'user' },
        ],
      });
      expect.unreachable('a P2P order must never reach payment creation for a guest');
    } catch (err) {
      expect(isCheckoutRefusal(err)).toBe(true);
      if (!isCheckoutRefusal(err)) return;
      expect(err.reason).toBe('p2p_seller_excluded');
      // The buyer's remedy is the same, and the sentence says the one thing
      // that matters at this point in the flow.
      expect(err.message).toMatch(/[Nn]othing has been charged/);
    }
  });

  it('reads the ORDERS, so it does not depend on the first gate having run', () => {
    // The inputs are disjoint from the first gate's on purpose: this one is a
    // statement about the rows a single PaymentIntent is about to cover.
    expect(() =>
      assertGuestP2PPaymentAllowed({
        actor: GUEST,
        orders: [{ id: 'order-store', sellerType: 'store' }],
      }),
    ).not.toThrow();
  });

  it('never fires for an Oxy buyer, whatever the orders are', () => {
    expect(() =>
      assertGuestP2PPaymentAllowed({
        actor: OXY,
        orders: [{ id: 'order-person', sellerType: 'user' }],
      }),
    ).not.toThrow();
  });

  it('names no seller key in the payment-stage refusal', () => {
    try {
      assertGuestP2PPaymentAllowed({
        actor: GUEST,
        orders: [{ id: 'order-person', sellerType: 'user' }],
      });
      expect.unreachable('a P2P order must never reach payment creation for a guest');
    } catch (err) {
      // By this point the buyer cannot deselect anything — the orders exist —
      // so the keys would be noise, and an order id in a buyer-facing message
      // is a handle they have no use for.
      expect((err as Error).message).not.toContain('order-person');
      expect((err as Error).message).not.toContain('user:');
    }
  });
});

describe('the cart says the same thing before checkout (visible before checkout)', () => {
  it('blocks a P2P group for a guest owner, with the sign-in remedy', () => {
    const availability = guestCheckoutAvailabilityFor(
      { kind: 'guest_session', guestSessionId: 'gs-1' },
      PERSON,
    );
    expect(availability).toEqual({
      status: 'blocked',
      reason: 'p2p_seller_excluded',
      signInResolves: true,
    });
  });

  it('carries a reason the checkout vocabulary also knows', () => {
    for (const reason of GUEST_CHECKOUT_BLOCK_REASONS) {
      // Two vocabularies describing one refusal must not drift: the cart's flag
      // and the sentence checkout throws are the same decision.
      expect(CHECKOUT_REFUSAL_REASONS).toContain(reason);
    }
  });

  it('marks a store group available for a guest owner', () => {
    expect(
      guestCheckoutAvailabilityFor({ kind: 'guest_session', guestSessionId: 'gs-1' }, STORE),
    ).toEqual({ status: 'available' });
  });

  it('says NOTHING for an Oxy owner — the field is absent, never "available"', () => {
    for (const group of [STORE, PERSON]) {
      expect(
        guestCheckoutAvailabilityFor({ kind: 'oxy_user', oxyUserId: 'buyer-1' }, group),
      ).toBeUndefined();
    }
  });

  it('agrees with what the gate would refuse, for every actor and group', () => {
    // The cart annotation and the checkout gate are two readings of one rule;
    // this is the assertion that they cannot disagree.
    const groups = [STORE, PERSON, RETAIL];
    const blockedByGate = guestP2PBlockedSellerKeys(GUEST, groups);
    const blockedByCart = groups
      .filter(
        (group) =>
          guestCheckoutAvailabilityFor({ kind: 'guest_session', guestSessionId: 'gs-1' }, group)
            ?.status === 'blocked',
      )
      .map((group) => group.sellerKey);
    expect(blockedByCart).toEqual(blockedByGate);
  });
});

describe('seller-type classification', () => {
  it('treats only `user` as a P2P individual', () => {
    expect(p2pSellerKeys([STORE, PERSON, RETAIL, STORE_B, PERSON_B])).toEqual([
      'user:seller-2',
      'user:seller-9',
    ]);
  });

  it('returns nothing for a cart with no individual sellers', () => {
    expect(p2pSellerKeys([STORE, RETAIL])).toEqual([]);
  });
});
