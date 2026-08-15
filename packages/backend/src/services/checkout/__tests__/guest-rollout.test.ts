/**
 * The guest-checkout rollout gate with NOTHING configured (#107).
 *
 * The default is the interesting case here, and it is the one a behavioural
 * test can actually prove: every lever is a block list, every block list is
 * empty out of the box, so this whole module has to be a no-op on a deployment
 * that has set none of them. A rollout switch whose default changed behaviour
 * would be discovered in production by whoever deployed it.
 *
 * Its own file from its sibling `guest-rollout.levers.test.ts` because
 * `config/index.ts` FREEZES at module load — a flag's on-state and its off-state
 * cannot share a process. Vitest isolates module registries per file, so this
 * file's `config` is a different frozen object from that one's.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { CommerceActor } from '../../commerce-actor.js';
import type { EligibilitySellerGroup } from '../fulfilment-eligibility.js';

const GUEST_WEB: CommerceActor = {
  kind: 'guest',
  guestSessionId: 'gs-rollout',
  transport: 'cookie',
};
const GUEST_NATIVE: CommerceActor = {
  kind: 'guest',
  guestSessionId: 'gs-rollout-native',
  transport: 'header',
};
const OXY: CommerceActor = { kind: 'oxy', oxyUserId: 'buyer-rollout' };

const GROUPS: EligibilitySellerGroup[] = [
  { sellerKey: 'store:abc', sellerType: 'store', shippingMethod: 'standard' },
  { sellerKey: 'store:def', sellerType: 'store', shippingMethod: 'express' },
];

let rollout: typeof import('../guest-rollout.js');
let config: typeof import('../../../config/index.js').config;

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'rollout-test-pii-key';
  process.env.GUEST_EMAIL_HASH_KEY = 'rollout-test-email-hash-key';
  // Stated rather than inherited: a sibling file sets each of these, and env
  // leaks across files in one worker where a frozen config does not.
  delete process.env.GUEST_CHECKOUT_BLOCKED_PLATFORMS;
  delete process.env.GUEST_CHECKOUT_BLOCKED_MARKETS;
  delete process.env.GUEST_CHECKOUT_BLOCKED_SELLER_KEYS;
  delete process.env.GUEST_CHECKOUT_BLOCKED_FULFILMENT_METHODS;
  delete process.env.GUEST_SELLER_ACTIVATION_REQUIRED;

  ({ config } = await import('../../../config/index.js'));
  rollout = await import('../guest-rollout.js');
});

describe('the levers are empty by default', () => {
  it('configures no block list and does not require activation', () => {
    const configured = config.guest.checkoutRollout;
    expect(configured.blockedPlatforms).toEqual([]);
    expect(configured.blockedMarkets).toEqual([]);
    expect(configured.blockedSellerKeys).toEqual([]);
    expect(configured.blockedFulfilmentMethods).toEqual([]);
    expect(configured.sellerActivationRequired).toBe(false);
  });

  it('admits a guest checkout on either platform, in any market', async () => {
    for (const actor of [GUEST_WEB, GUEST_NATIVE]) {
      for (const destinationCountry of ['ES', 'FR', 'US']) {
        await expect(
          rollout.assertGuestCheckoutRolloutAllowed({ actor, destinationCountry, groups: GROUPS }),
        ).resolves.toBeUndefined();
      }
    }
  });
});

describe('the platform is derived from the credential carriage, not from a claim', () => {
  it('maps the cookie transport to web and the header transport to native', () => {
    expect(rollout.guestCheckoutPlatform(GUEST_WEB)).toBe('web');
    expect(rollout.guestCheckoutPlatform(GUEST_NATIVE)).toBe('native');
  });
});

describe('the #85 gate is not consulted while its flag is off', () => {
  /**
   * #85 closed the seam, so `readGuestSellerActivation` can now answer
   * `activated` — and it reaches eleven tables to do it. This case pins the
   * property that survived: with `GUEST_SELLER_ACTIVATION_REQUIRED` off, which
   * is the default ADR 0006 G14 chose, the gate returns before the activation
   * read is attempted, so a deployment that has not opted in pays nothing for
   * the gate existing.
   *
   * It is asserted by BEHAVIOUR rather than by a spy: this file's whole point
   * is that nothing is configured, and there is no database in this process at
   * all — so a call that DID reach the derivation would reject, and the
   * `.resolves` below is what catches it.
   */
  it('completes without touching the derivation', async () => {
    await expect(
      rollout.assertGuestCheckoutRolloutAllowed({
        actor: GUEST_WEB,
        destinationCountry: 'ES',
        groups: GROUPS,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('the gate is guest-only', () => {
  it('does not run for an Oxy buyer', async () => {
    // Vacuously true with no lever set, which is why the LEVERS file asserts
    // the same thing with every switch thrown — this case exists so a future
    // change that made the gate actor-blind fails in both files.
    await expect(
      rollout.assertGuestCheckoutRolloutAllowed({
        actor: OXY,
        destinationCountry: 'ES',
        groups: GROUPS,
      }),
    ).resolves.toBeUndefined();
  });
});
