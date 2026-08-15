/**
 * `GUEST_SELLER_ACTIVATION_REQUIRED=true` — the #85 gate in its enforcing
 * position, in its own file for the frozen-config reason its two siblings are.
 *
 * ## What changed when #85 landed
 *
 * Before: `readGuestSellerActivation` could not return `activated` under any
 * input, so turning this flag on refused EVERY guest checkout. That was the
 * seam, and it was the fail-closed direction on purpose.
 *
 * Now the answer is #85's guest conjunction, derived per seller. This file pins
 * the two halves that matter and nothing about the derivation itself (which is
 * `merchant-activation/__tests__/requirements.test.ts`' subject): a seller whose
 * conjunction HOLDS gets through, and one whose conjunction does not is refused
 * under the same reason code, with the same named-sellers message, in the same
 * position in the gate order. The seam closed without any of that moving.
 *
 * The activation read is MOCKED here, deliberately. This file's subject is the
 * GATE — the flag, the reason code, the message and the actor split — and giving
 * it a real derivation would make it fail for eleven reasons that belong to
 * other files. The derivation's own realdb suite drives the real thing.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommerceActor } from '../../commerce-actor.js';
import type { EligibilitySellerGroup } from '../fulfilment-eligibility.js';
import { isCheckoutRefusal } from '../refusal.js';

const GUEST: CommerceActor = { kind: 'guest', guestSessionId: 'gs-activation', transport: 'cookie' };
const OXY: CommerceActor = { kind: 'oxy', oxyUserId: 'buyer-activation' };

const ACTIVATED: EligibilitySellerGroup = {
  sellerKey: 'store:activated',
  sellerType: 'store',
  shippingMethod: 'standard',
};
const NOT_ACTIVATED: EligibilitySellerGroup = {
  sellerKey: 'store:one',
  sellerType: 'store',
  shippingMethod: 'standard',
};
const ALSO_NOT_ACTIVATED: EligibilitySellerGroup = {
  sellerKey: 'store:two',
  sellerType: 'store',
  shippingMethod: 'standard',
};

/**
 * The mock. `store:activated` is the only seller whose conjunction holds — one
 * positive and two negatives, so a gate that refused everything and a gate that
 * refused nothing both fail this file.
 */
vi.mock('../../merchant-activation/guest-activation.js', () => ({
  readGuestSellerActivation: (sellerKey: string) =>
    Promise.resolve(
      sellerKey === 'store:activated'
        ? { state: 'activated' }
        : { state: 'not_activated', reason: 'policy_not_accepted' },
    ),
}));

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

/** The reason a call refused with, or `undefined` when it did not refuse. */
async function refusalOf(
  groups: EligibilitySellerGroup[],
  actor: CommerceActor = GUEST,
): Promise<{ reason?: string; message: string }> {
  try {
    await rollout.assertGuestCheckoutRolloutAllowed({
      actor,
      destinationCountry: 'ES',
      groups,
    });
    return { message: '' };
  } catch (error: unknown) {
    return {
      reason: isCheckoutRefusal(error) ? error.reason : 'unclassified',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

describe('with merchant activation required', () => {
  it('refuses an unactivated seller under its OWN reason code, naming the sellers', async () => {
    const refusal = await refusalOf([NOT_ACTIVATED, ALSO_NOT_ACTIVATED]);

    // Its own reason, not `seller_not_payment_ready`: one seller cannot be PAID
    // and the other has not been ACTIVATED, and a merchant sent to the wrong
    // screen stays stuck.
    expect(refusal.reason).toBe('guest_seller_not_activated');
    // Named, unlike the kill switches — a mixed cart's remedy is to deselect
    // the sellers that cannot serve a guest, which needs the keys.
    expect(refusal.message).toContain('store:one');
    expect(refusal.message).toContain('store:two');
  });

  it('admits a seller whose guest conjunction HOLDS', async () => {
    // The positive control. Without it a gate that refused unconditionally —
    // which is precisely what this file asserted before #85 landed — would pass
    // every other case here.
    expect(await refusalOf([ACTIVATED])).toEqual({ message: '' });
  });

  it('refuses a MIXED cart and names only the seller that failed', async () => {
    const refusal = await refusalOf([ACTIVATED, NOT_ACTIVATED]);
    expect(refusal.reason).toBe('guest_seller_not_activated');
    expect(refusal.message).toContain('store:one');
    expect(refusal.message).not.toContain('store:activated');
  });

  it('leaves an AUTHENTICATED checkout untouched', async () => {
    expect(await refusalOf([NOT_ACTIVATED, ALSO_NOT_ACTIVATED], OXY)).toEqual({ message: '' });
  });
});
