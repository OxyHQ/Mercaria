/**
 * What the rail is told, and what the buyer's client is handed (#107, ADR 0006
 * G7/G10/G14).
 *
 * Three properties, and the reason they are asserted here rather than only in
 * the realdb suite is that each is a decision made in ONE pure-ish function
 * whose inputs a mocked provider can drive exhaustively:
 *
 *  - the PaymentIntent's metadata carries exactly ADR 0006 G7's keys, gains
 *    `guestCheckoutId` on a guest-origin group and nothing else on an Oxy one;
 *  - the handoff's payment SURFACES come from the server and take no buyer as
 *    an input;
 *  - the return URL is composed by the server from a configured origin and
 *    carries one opaque id.
 *
 * The realdb sibling proves the guest id is the REAL row's, which needs a real
 * `guest_checkouts` insert. This file proves what is composed from it.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import { PAYMENT_METADATA_KEYS } from '@mercaria/shared-types';
import type { OrderRecord } from '../../../db/orders/orderRepository.js';

const GROUP = uuidv7();
const PAYMENT_ID = uuidv7();
const GUEST_CHECKOUT_ID = uuidv7();
const ORDER_A = uuidv7();
const ORDER_B = uuidv7();

/** What `findGuestCheckoutIdForGroup` answers for this case. */
const guestCheckoutId = vi.fn<() => Promise<string | undefined>>();
const createPayment = vi.fn();

vi.mock('../guest-correlation.js', () => ({
  findGuestCheckoutIdForGroup: () => guestCheckoutId(),
}));
vi.mock('../payment.service.js', () => ({
  ensurePayment: () =>
    Promise.resolve({ id: PAYMENT_ID, checkoutGroupId: GROUP, providerObjectId: null }),
}));
vi.mock('../registry.js', () => ({
  resolvePaymentProvider: () => ({
    id: 'stripe',
    createPayment: (...args: unknown[]) => createPayment(...args),
  }),
}));
vi.mock('../../../db/payments/paymentRepository.js', () => ({
  attachPaymentProviderObject: () => Promise.resolve(undefined),
  findNativePaymentByCheckoutGroupId: () => Promise.resolve(undefined),
}));
vi.mock('../../../db/postgres.js', () => ({ getDb: () => ({}) }));

let service: typeof import('../checkout-payment.service.js');

/** Two seller orders in one group, the multi-seller shape ADR 0001 D4 funds. */
function orders(): OrderRecord[] {
  const of = (id: string, amount: number) =>
    ({
      id,
      totalsGrandTotalPresentmentAmount: amount,
      totalsGrandTotalPresentmentCurrency: 'EUR',
    }) as unknown as OrderRecord;
  return [of(ORDER_A, 4_000), of(ORDER_B, 1_000)];
}

/** The metadata the one `createPayment` call carried. */
function capturedMetadata(): Record<string, string> {
  const [call] = createPayment.mock.calls;
  return (call?.[0] as { metadata: Record<string, string> }).metadata;
}

beforeAll(async () => {
  process.env.STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_handoff_not_a_real_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_handoff_platform_not_a_real_one';
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_handoff_connect_not_a_real_one';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_handoff_not_a_real_key';
  process.env.STRIPE_CHECKOUT_RETURN_URL = 'https://mercaria.co/checkout/return';
  // Explicit, not inherited: a sibling file narrowing this would silently
  // change what this file's surface assertions mean.
  delete process.env.STRIPE_PAYMENT_SURFACE_METHODS;

  service = await import('../checkout-payment.service.js');
});

beforeEach(() => {
  createPayment.mockReset();
  createPayment.mockResolvedValue({
    providerObjectId: 'pi_handoff',
    status: 'created',
    clientAction: { kind: 'client_secret', value: 'pi_handoff_secret' },
  });
  guestCheckoutId.mockReset();
});

describe('the PaymentIntent metadata (ADR 0006 G7)', () => {
  it('carries the guest correlation on a guest-origin group', async () => {
    guestCheckoutId.mockResolvedValue(GUEST_CHECKOUT_ID);

    await service.openCheckoutPayment({ rail: 'stripe', checkoutGroupId: GROUP, orders: orders() });

    expect(capturedMetadata()).toEqual({
      paymentId: PAYMENT_ID,
      checkoutGroupId: GROUP,
      guestCheckoutId: GUEST_CHECKOUT_ID,
      orderCount: '2',
      // SORTED, so a converging replay composes a byte-identical request and
      // the reused idempotency key stays valid.
      orderIds: [ORDER_A, ORDER_B].sort().join(','),
    });
  });

  it('omits the guest key entirely on an Oxy-origin group', async () => {
    guestCheckoutId.mockResolvedValue(undefined);

    await service.openCheckoutPayment({
      rail: 'stripe',
      checkoutGroupId: GROUP,
      buyerOxyUserId: 'buyer-handoff',
      orders: orders(),
    });

    const metadata = capturedMetadata();
    expect(metadata).not.toHaveProperty('guestCheckoutId');
    // And the buyer is NOT substituted for it. The metadata has no buyer field
    // for either actor kind, which is what makes "provider grouping never feeds
    // Mercaria identity" true of the write side as well as the read side.
    expect(Object.values(metadata)).not.toContain('buyer-handoff');
  });

  it('never carries a key outside ADR 0006 G7 s allow-list', async () => {
    guestCheckoutId.mockResolvedValue(GUEST_CHECKOUT_ID);
    await service.openCheckoutPayment({ rail: 'stripe', checkoutGroupId: GROUP, orders: orders() });

    for (const key of Object.keys(capturedMetadata())) {
      expect(PAYMENT_METADATA_KEYS as readonly string[], key).toContain(key);
    }
  });

  it('refuses a record carrying a forbidden key, by allow-list AND by substring', () => {
    // The gate the composition above runs through, driven directly. Both
    // detectors are exercised: `stripeCustomerId` is simply not on the
    // allow-list, and `sessionToken` would also trip the substring scan — which
    // is the one a future author extending the allow-list would still meet.
    expect(() =>
      service.assertPaymentMetadataKeys({ paymentId: 'p', stripeCustomerId: 'cus_x' }),
    ).toThrow(/stripeCustomerId/);
    expect(() => service.assertPaymentMetadataKeys({ sessionToken: 'mgs_x' })).toThrow(
      /sessionToken/,
    );
    expect(() => service.assertPaymentMetadataKeys({ buyerEmail: 'a@b.c' })).toThrow(/buyerEmail/);
    expect(() => service.assertPaymentMetadataKeys({ guestSessionId: 'gs' })).toThrow(
      /guestSessionId/,
    );
    // …and the legitimate record passes, so the gate is not vacuously strict.
    expect(() =>
      service.assertPaymentMetadataKeys({
        paymentId: 'p',
        checkoutGroupId: 'g',
        guestCheckoutId: 'gc',
        orderCount: '1',
        orderIds: 'o',
      }),
    ).not.toThrow();
  });
});

describe('the handoff (ADR 0006 G10/G14)', () => {
  it('names the server-authoritative surfaces and a server-composed return url', async () => {
    guestCheckoutId.mockResolvedValue(GUEST_CHECKOUT_ID);

    const handoff = await service.openCheckoutPayment({
      rail: 'stripe',
      checkoutGroupId: GROUP,
      orders: orders(),
    });

    expect(handoff?.methods).toEqual(['card', 'apple_pay', 'google_pay', 'link']);
    expect(handoff?.returnUrl).toBe(
      `https://mercaria.co/checkout/return?checkoutGroupId=${GROUP}`,
    );
  });

  it('gives a guest and an Oxy buyer the SAME surfaces (ADR 0006 B11)', async () => {
    guestCheckoutId.mockResolvedValue(GUEST_CHECKOUT_ID);
    const guest = await service.openCheckoutPayment({
      rail: 'stripe',
      checkoutGroupId: GROUP,
      orders: orders(),
    });

    guestCheckoutId.mockResolvedValue(undefined);
    const oxy = await service.openCheckoutPayment({
      rail: 'stripe',
      checkoutGroupId: GROUP,
      buyerOxyUserId: 'buyer-handoff',
      orders: orders(),
    });

    expect(guest?.methods).toEqual(oxy?.methods);
    // The stronger form of the same claim: the function that answers it takes
    // no arguments at all, so buyer origin is not merely unused — it is
    // unrepresentable as an input.
    expect(service.checkoutPaymentSurfaces.length).toBe(0);
  });

  it('carries ONE opaque id in the return url and no credential', () => {
    const url = new URL(service.checkoutReturnUrl(GROUP) ?? '');
    expect([...url.searchParams.keys()]).toEqual(['checkoutGroupId']);
    expect(url.searchParams.get('checkoutGroupId')).toBe(GROUP);
    expect(url.origin).toBe('https://mercaria.co');
  });
});
