/**
 * `GUEST_INLINE_DESTINATION_ENABLED=false` — the #105 incident lever, in its
 * own file (#105 migration rule 8).
 *
 * Its own file for the reason `guest-session.disabled.integration.test.ts` and
 * `cart-guest.disabled.integration.test.ts` are: `config/index.ts` FREEZES at
 * module load, so a flag's off-state cannot be tested in the same process as
 * its on-state. Env is set before any import; vitest isolates module registries
 * per file, so this file's `config` is a different frozen object from its
 * sibling's.
 *
 * What is asserted is the INTERACTION as much as the refusal: the lever is
 * independent of `GUEST_CART_ENABLED` (which stays on here) and of the Oxy
 * path entirely.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommerceActor } from '../../commerce-actor.js';

const findAddress = vi.fn();
vi.mock('../../../db/buyers/addressRepository.js', () => ({
  findAddress: (...args: unknown[]) => findAddress(...args),
}));

const OXY: CommerceActor = { kind: 'oxy', oxyUserId: 'buyer-flag' };
const GUEST: CommerceActor = { kind: 'guest', guestSessionId: 'gs-flag', transport: 'cookie' };

const INLINE = {
  recipientName: 'Jane Doe',
  line1: 'Carrer de Colon 1',
  city: 'Valencia',
  postalCode: '46004',
  country: 'ES',
};

let resolveCheckoutContract: typeof import('../destination.js').resolveCheckoutContract;
let config: typeof import('../../../config/index.js').config;

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'flag-test-pii-key';
  process.env.GUEST_EMAIL_HASH_KEY = 'flag-test-email-hash-key';
  // The cart lever stays ON. That is the point of the file: the two levers are
  // independent, so a guest who still owns a cart is refused at CHECKOUT rather
  // than losing their basket.
  process.env.GUEST_CART_ENABLED = 'true';
  process.env.GUEST_INLINE_DESTINATION_ENABLED = 'false';

  ({ config } = await import('../../../config/index.js'));
  ({ resolveCheckoutContract } = await import('../destination.js'));
});

describe('with the inline-destination lever off', () => {
  it('reads the flags as three independent levers', () => {
    expect(config.guest.enabled).toBe(true);
    expect(config.guest.cartEnabled).toBe(true);
    expect(config.guest.inlineDestinationEnabled).toBe(false);
  });

  it('refuses a guest inline destination with a sentence a buyer can act on', async () => {
    await expect(
      resolveCheckoutContract(GUEST, {
        destination: { type: 'inline_shipping_address', address: INLINE },
        contact: { email: 'jane@example.com' },
      }),
    ).rejects.toThrow(/temporarily unavailable/);
  });

  it('refuses a guest pickup destination on the same lever', async () => {
    await expect(
      resolveCheckoutContract(GUEST, {
        destination: {
          type: 'pickup',
          locationId: 'loc-1',
          pickupContact: { email: 'jane@example.com' },
        },
        contact: { email: 'jane@example.com' },
      }),
    ).rejects.toThrow(/temporarily unavailable/);
  });

  it('leaves the Oxy path completely untouched', async () => {
    const result = await resolveCheckoutContract(OXY, {
      destination: { type: 'inline_shipping_address', address: INLINE },
    });
    expect(result.fulfilment.kind).toBe('shipping');
  });
});
