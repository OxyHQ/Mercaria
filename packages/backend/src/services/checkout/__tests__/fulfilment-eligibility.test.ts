/**
 * Seller and shipping eligibility, revalidated before any reservation
 * (#105 "Seller and shipping eligibility").
 *
 * Pure functions over a resolved destination and a seller-group list, so every
 * case here is a table row rather than a fixture with a database behind it.
 * What is worth reading is WHICH refusals name a seller: a mixed cart's remedy
 * is to deselect the seller that cannot serve the destination, and a generic
 * "invalid address" leaves a buyer with nothing to do.
 */

import { describe, expect, it } from 'vitest';
import type { CommerceActor } from '../../commerce-actor.js';
import { assertGuestP2PCheckoutAllowed } from '../../guest-p2p/gate.js';
import type { ResolvedFulfilment } from '../destination.js';
import {
  assertPickupLocationEligible,
  assertSellerGroupsAcceptDestination,
  resolveShippingCostMinor,
  type EligibilitySellerGroup,
} from '../fulfilment-eligibility.js';

const GUEST: CommerceActor = { kind: 'guest', guestSessionId: 'gs-1', transport: 'cookie' };

const SHIPPING: ResolvedFulfilment = {
  kind: 'shipping',
  source: 'inline_shipping_address',
  address: {
    recipientName: 'Jane Doe',
    line1: 'Carrer de Colon 1',
    city: 'Valencia',
    postalCode: '46004',
    country: 'ES',
  },
};

function group(overrides: Partial<EligibilitySellerGroup> = {}): EligibilitySellerGroup {
  return {
    sellerKey: 'store:store-A',
    sellerType: 'store',
    shippingMethod: 'standard',
    ...overrides,
  };
}

describe('shipping cost is resolved, never assumed', () => {
  it('returns the configured flat rate for a known method', () => {
    expect(resolveShippingCostMinor('standard')).toBeTypeOf('number');
    expect(resolveShippingCostMinor('standard')).toBeGreaterThanOrEqual(0);
  });

  it('refuses a method this deployment cannot price rather than shipping it free', () => {
    // The failure mode #105 eligibility rule 6 names: an unconfigured method
    // indexing to `undefined`, arithmetic turning that into 0, and an order
    // shipping for nothing. A cast is the only way to construct the input,
    // because the union is what normally prevents it — which is the point: the
    // guard exists for the case where a NEW method reaches the config before
    // its rate does.
    const unknownMethod = 'drone' as unknown as Parameters<typeof resolveShippingCostMinor>[0];
    expect(() => resolveShippingCostMinor(unknownMethod)).toThrow(/not available/);
  });
});

describe('the guest P2P gate is no longer this module\'s (#112)', () => {
  // The gate MOVED to `services/guest-p2p/gate.ts`, which is where its policy,
  // its published criteria and its second call site before payment creation
  // live. What is asserted here is the ORDERING this file's own gate depends
  // on: `checkout.service` runs the P2P gate first, so a guest whose cart holds
  // an individual's listing is told THAT rather than being sent to fix a
  // destination. Full behaviour: `services/guest-p2p/__tests__/gate.test.ts`.
  it('refuses a guest P2P group before any destination question is asked', () => {
    expect(() =>
      assertGuestP2PCheckoutAllowed({
        actor: GUEST,
        groups: [group({ sellerKey: 'user:seller-9', sellerType: 'user' })],
      }),
    ).toThrow(/individual seller/);
  });

  it('takes no actor at all, so it cannot answer a seller-type question twice', () => {
    // The signature is the assertion: `assertSellerGroupsAcceptDestination` has
    // no actor parameter, so a P2P group reaches the destination checks like
    // any other and the seller TYPE is decided in exactly one place.
    expect(() =>
      assertSellerGroupsAcceptDestination({
        fulfilment: SHIPPING,
        groups: [group({ sellerKey: 'user:seller-9', sellerType: 'user' })],
      }),
    ).not.toThrow();
  });
});

describe('pickup fails CLOSED until #93', () => {
  it('refuses every pickup destination, naming the sellers', () => {
    expect(() => assertPickupLocationEligible('loc-1', [group()])).toThrow(/store:store-A/);
    expect(() => assertPickupLocationEligible('loc-1', [group()])).toThrow(/not available yet/);
  });

  it('refuses through the whole gate too, so no caller can skip it', () => {
    expect(() =>
      assertSellerGroupsAcceptDestination({
        fulfilment: {
          kind: 'pickup',
          locationId: 'loc-1',
          pickupContact: {
            displayEmail: 'a@b.co',
            normalizedEmail: 'a@b.co',
          },
        },
        groups: [group()],
      }),
    ).toThrow(/not available yet/);
  });
});

describe('mixed destination and method', () => {
  it('refuses collection chosen for one seller alongside a delivery address', () => {
    try {
      assertSellerGroupsAcceptDestination({
        fulfilment: SHIPPING,
        groups: [group(), group({ sellerKey: 'store:store-B', shippingMethod: 'pickup' })],
      });
      expect.unreachable('a pickup method with a shipping destination must be refused');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('store:store-B');
      expect(message).not.toContain('store:store-A');
    }
  });

  it('accepts a plain multi-seller delivery', () => {
    expect(() =>
      assertSellerGroupsAcceptDestination({
        fulfilment: SHIPPING,
        groups: [group(), group({ sellerKey: 'store:store-B', shippingMethod: 'express' })],
      }),
    ).not.toThrow();
  });

  it('leaks nothing about the cart in a refusal', () => {
    try {
      assertGuestP2PCheckoutAllowed({
        actor: GUEST,
        groups: [group({ sellerKey: 'user:seller-9', sellerType: 'user' })],
      });
      expect.unreachable('a guest P2P group must be refused');
    } catch (err) {
      const message = (err as Error).message;
      // Seller keys and a remedy; no listing, no variant, no quantity, no
      // stock figure — a rejection must not leak inventory (#105 acceptance 4).
      expect(message).not.toMatch(/quantity|stock|variant|listing|available/i);
    }
  });
});
