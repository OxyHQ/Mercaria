/**
 * Every guest-checkout kill switch thrown at once (#107 acceptance 13, fraud
 * rule 8) — the mirror of `guest-rollout.test.ts`, which pins the default.
 *
 * Its own file because `config/index.ts` freezes at module load: a lever's ON
 * state and its OFF state cannot be exercised in one process.
 *
 * The two assertions that matter most are not the refusals themselves — those
 * are a `.includes` — but what surrounds them:
 *
 *  - an AUTHENTICATED checkout passes every one of these levers, so a guest
 *    rollback is never a marketplace outage;
 *  - the refusal names NO dimension, so a client cannot map the switchboard by
 *    varying one input per request.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { CommerceActor } from '../../commerce-actor.js';
import type { EligibilitySellerGroup } from '../fulfilment-eligibility.js';
import { isCheckoutRefusal } from '../refusal.js';

const GUEST_WEB: CommerceActor = { kind: 'guest', guestSessionId: 'gs-lever', transport: 'cookie' };
const GUEST_NATIVE: CommerceActor = {
  kind: 'guest',
  guestSessionId: 'gs-lever-native',
  transport: 'header',
};
const OXY: CommerceActor = { kind: 'oxy', oxyUserId: 'buyer-lever' };

const OPEN_GROUP: EligibilitySellerGroup = {
  sellerKey: 'store:open',
  sellerType: 'store',
  shippingMethod: 'standard',
};
const BLOCKED_SELLER_GROUP: EligibilitySellerGroup = {
  sellerKey: 'store:Blocked',
  sellerType: 'store',
  shippingMethod: 'standard',
};
const BLOCKED_METHOD_GROUP: EligibilitySellerGroup = {
  sellerKey: 'store:open',
  sellerType: 'store',
  shippingMethod: 'express',
};

let rollout: typeof import('../guest-rollout.js');

/** The reason a call refused with, or `undefined` when it did not refuse. */
function refusalReasonOf(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (error: unknown) {
    return isCheckoutRefusal(error) ? error.reason : 'unclassified';
  }
}

/** The message a call refused with. */
function refusalMessageOf(run: () => void): string {
  try {
    run();
    return '';
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'lever-test-pii-key';
  process.env.GUEST_EMAIL_HASH_KEY = 'lever-test-email-hash-key';
  process.env.GUEST_CHECKOUT_BLOCKED_PLATFORMS = 'native';
  process.env.GUEST_CHECKOUT_BLOCKED_MARKETS = 'fr, pt';
  // Mixed case on purpose: a seller key embeds a uuid and must NOT be folded,
  // so this value has to match byte for byte and `store:blocked` must not.
  process.env.GUEST_CHECKOUT_BLOCKED_SELLER_KEYS = 'store:Blocked';
  process.env.GUEST_CHECKOUT_BLOCKED_FULFILMENT_METHODS = 'express';

  rollout = await import('../guest-rollout.js');
});

describe('each dimension refuses independently', () => {
  it('blocks the named PLATFORM and leaves the other one open', () => {
    expect(
      refusalReasonOf(() =>
        rollout.assertGuestCheckoutRolloutAllowed({
          actor: GUEST_NATIVE,
          destinationCountry: 'ES',
          groups: [OPEN_GROUP],
        }),
      ),
    ).toBe('guest_rollout_blocked');
    expect(
      refusalReasonOf(() =>
        rollout.assertGuestCheckoutRolloutAllowed({
          actor: GUEST_WEB,
          destinationCountry: 'ES',
          groups: [OPEN_GROUP],
        }),
      ),
    ).toBeUndefined();
  });

  it('blocks the named MARKETS, case-insensitively, and leaves the rest open', () => {
    for (const country of ['FR', 'PT']) {
      expect(
        refusalReasonOf(() =>
          rollout.assertGuestCheckoutRolloutAllowed({
            actor: GUEST_WEB,
            destinationCountry: country,
            groups: [OPEN_GROUP],
          }),
        ),
        country,
      ).toBe('guest_rollout_blocked');
    }
    expect(
      refusalReasonOf(() =>
        rollout.assertGuestCheckoutRolloutAllowed({
          actor: GUEST_WEB,
          destinationCountry: 'ES',
          groups: [OPEN_GROUP],
        }),
      ),
    ).toBeUndefined();
  });

  it('blocks the named MERCHANT, byte for byte, and leaves its neighbours open', () => {
    expect(rollout.readGuestSellerActivation('store:Blocked')).toEqual({
      state: 'blocked_by_operator',
    });
    // The same key in another case is a DIFFERENT seller. Folding case here
    // would make one lever entry silently withdraw two merchants.
    expect(rollout.readGuestSellerActivation('store:blocked')).toEqual({ state: 'unrecorded' });

    expect(
      refusalReasonOf(() =>
        rollout.assertGuestCheckoutRolloutAllowed({
          actor: GUEST_WEB,
          destinationCountry: 'ES',
          groups: [OPEN_GROUP, BLOCKED_SELLER_GROUP],
        }),
      ),
    ).toBe('guest_rollout_blocked');
  });

  it('blocks the named FULFILMENT method and leaves the others open', () => {
    expect(
      refusalReasonOf(() =>
        rollout.assertGuestCheckoutRolloutAllowed({
          actor: GUEST_WEB,
          destinationCountry: 'ES',
          groups: [BLOCKED_METHOD_GROUP],
        }),
      ),
    ).toBe('guest_rollout_blocked');
  });
});

describe('what the levers cannot reach', () => {
  it('never refuses an AUTHENTICATED checkout, whatever is switched off', () => {
    // Every dimension at once, including the blocked platform's transport —
    // which an Oxy actor does not even have. A guest rollback that took
    // authenticated checkout down with it would be an outage wearing a
    // rollout's name.
    expect(() =>
      rollout.assertGuestCheckoutRolloutAllowed({
        actor: OXY,
        destinationCountry: 'FR',
        groups: [BLOCKED_SELLER_GROUP, BLOCKED_METHOD_GROUP],
      }),
    ).not.toThrow();
  });

  it('refuses without naming the dimension that fired', () => {
    const messages = [
      refusalMessageOf(() =>
        rollout.assertGuestCheckoutRolloutAllowed({
          actor: GUEST_NATIVE,
          destinationCountry: 'ES',
          groups: [OPEN_GROUP],
        }),
      ),
      refusalMessageOf(() =>
        rollout.assertGuestCheckoutRolloutAllowed({
          actor: GUEST_WEB,
          destinationCountry: 'FR',
          groups: [OPEN_GROUP],
        }),
      ),
      refusalMessageOf(() =>
        rollout.assertGuestCheckoutRolloutAllowed({
          actor: GUEST_WEB,
          destinationCountry: 'ES',
          groups: [BLOCKED_SELLER_GROUP],
        }),
      ),
      refusalMessageOf(() =>
        rollout.assertGuestCheckoutRolloutAllowed({
          actor: GUEST_WEB,
          destinationCountry: 'ES',
          groups: [BLOCKED_METHOD_GROUP],
        }),
      ),
    ];

    // All four are the SAME sentence — which is what makes them
    // indistinguishable to a client probing one input at a time.
    expect(new Set(messages).size).toBe(1);
    const [message] = messages;
    expect(message).toMatch(/temporarily unavailable/);
    for (const leak of ['native', 'platform', 'FR', 'market', 'store:Blocked', 'express']) {
      expect(message, `the refusal names ${leak}`).not.toContain(leak);
    }
  });
});
