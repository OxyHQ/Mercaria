/**
 * `GUEST_SELLER_ACTIVATION_REQUIRED=true` — the #85 seam in its enforcing
 * position, in its own file for the frozen-config reason its two siblings are.
 *
 * The behaviour looks alarming and is the point: with the flag on, EVERY guest
 * checkout is refused, because `readGuestSellerActivation` cannot report a
 * seller as activated until #85 builds the state and no configuration makes it.
 * That is the fail-closed direction, and shipping the lever now is what stops a
 * deployment believing it enforces merchant activation while enforcing nothing.
 *
 * The flag is OFF by default (`guest-rollout.test.ts` asserts that), because ADR
 * 0006 G14 decided guest eligibility is the intersection of the gates that
 * already exist — so a default of ON would refuse a checkout the ADR says is
 * eligible.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { CommerceActor } from '../../commerce-actor.js';
import type { EligibilitySellerGroup } from '../fulfilment-eligibility.js';
import { isCheckoutRefusal } from '../refusal.js';

const GUEST: CommerceActor = { kind: 'guest', guestSessionId: 'gs-activation', transport: 'cookie' };
const OXY: CommerceActor = { kind: 'oxy', oxyUserId: 'buyer-activation' };

const GROUPS: EligibilitySellerGroup[] = [
  { sellerKey: 'store:one', sellerType: 'store', shippingMethod: 'standard' },
  { sellerKey: 'store:two', sellerType: 'store', shippingMethod: 'standard' },
];

let rollout: typeof import('../guest-rollout.js');

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'activation-test-pii-key';
  process.env.GUEST_EMAIL_HASH_KEY = 'activation-test-email-hash-key';
  process.env.GUEST_SELLER_ACTIVATION_REQUIRED = 'true';
  // The four incident levers stay OFF: this file is about the #85 policy gate,
  // and a refusal from a kill switch would prove nothing about it.
  delete process.env.GUEST_CHECKOUT_BLOCKED_PLATFORMS;
  delete process.env.GUEST_CHECKOUT_BLOCKED_MARKETS;
  delete process.env.GUEST_CHECKOUT_BLOCKED_SELLER_KEYS;
  delete process.env.GUEST_CHECKOUT_BLOCKED_FULFILMENT_METHODS;

  rollout = await import('../guest-rollout.js');
});

describe('with merchant activation required and #85 unbuilt', () => {
  it('refuses a guest checkout under its OWN reason code, naming the sellers', () => {
    let reason: string | undefined;
    let message = '';
    try {
      rollout.assertGuestCheckoutRolloutAllowed({
        actor: GUEST,
        destinationCountry: 'ES',
        groups: GROUPS,
      });
    } catch (error: unknown) {
      reason = isCheckoutRefusal(error) ? error.reason : 'unclassified';
      message = error instanceof Error ? error.message : String(error);
    }

    // Its own reason, not `seller_not_payment_ready`: one seller cannot be PAID
    // and the other has not ACCEPTED, and a merchant sent to the wrong screen
    // stays stuck.
    expect(reason).toBe('guest_seller_not_activated');
    // Named, unlike the kill switches — a mixed cart's remedy is to deselect
    // the sellers that cannot serve a guest, which needs the keys.
    expect(message).toContain('store:one');
    expect(message).toContain('store:two');
  });

  it('leaves an AUTHENTICATED checkout untouched', () => {
    expect(() =>
      rollout.assertGuestCheckoutRolloutAllowed({
        actor: OXY,
        destinationCountry: 'ES',
        groups: GROUPS,
      }),
    ).not.toThrow();
  });
});
