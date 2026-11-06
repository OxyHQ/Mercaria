/**
 * The FairCoin handoff (ADR 0019 D3, D4): what the FairCoin rail is asked for,
 * what the buyer's client is handed, and the refusals the buyer must SEE.
 *
 * Driven against a mocked adapter for the reason `checkout-handoff.test.ts`
 * is: every property is decided in `openCheckoutPayment` from its inputs.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@oxy.so/db';
import type { OrderRecord } from '../../../db/orders/orderRepository.js';

const GROUP = uuidv7();
const PAYMENT_ID = uuidv7();
const STORE_A = uuidv7();
const STORE_B = uuidv7();

const openCheckoutSession = vi.fn();
const findSellerAccount = vi.fn();

vi.mock('../guest-correlation.js', () => ({
  findGuestCheckoutIdForGroup: () => Promise.resolve(undefined),
}));
vi.mock('../payment.service.js', () => ({
  ensurePayment: () =>
    Promise.resolve({
      id: PAYMENT_ID,
      checkoutGroupId: GROUP,
      providerObjectId: null,
      providerCheckoutSessionId: null,
      createdAt: new Date(),
    }),
}));
vi.mock('../registry.js', () => ({
  resolvePaymentProvider: (provider: string) => ({
    id: provider,
    createPayment: () => Promise.reject(new Error('a checkout opens a session, not an intent')),
    openCheckoutSession: (...args: unknown[]) => openCheckoutSession(...args),
    readCheckoutSession: () => Promise.reject(new Error('nothing to resume')),
    expireCheckoutSession: () => Promise.resolve(),
  }),
}));
// Both exports the opener reads. Written out rather than spread from the
// original, which Bun's `vi.mock` cannot supply (the suite also runs under Bun).
vi.mock('../provider-account.service.js', () => ({
  findSellerAccount: (...args: unknown[]) => findSellerAccount(...args),
  parseSellerKey: (key: string) => {
    const [type, id] = key.split(':');
    return type === 'store' || type === 'user' ? { ownerType: type, ownerId: id ?? '' } : undefined;
  },
}));
vi.mock('../../../db/payments/paymentRepository.js', () => ({
  attachPaymentCheckoutSession: () => Promise.resolve(undefined),
  findNativePaymentByCheckoutGroupId: () => Promise.resolve(undefined),
}));
vi.mock('../../../db/fees/orderFeeSnapshotRepository.js', () => ({
  listOrderFeeSnapshots: () => Promise.resolve(new Map()),
}));
vi.mock('../../../db/postgres.js', () => ({ getDb: () => ({}) }));
vi.mock('../../supervised-shopping/purchase.service.js', () => ({
  permitSupervisedPayment: async () => true,
}));

let service: typeof import('../checkout-payment.service.js');

/** One store order per id, in FAIR (10⁻⁸ ⊜ base units). */
function fairOrders(...stores: string[]): OrderRecord[] {
  return stores.map(
    (storeId) =>
      ({
        id: uuidv7(),
        sellerType: 'store',
        storeId,
        sellerOxyUserId: null,
        orderNumber: `MRC-${storeId.slice(0, 4)}`,
        totalsGrandTotalPresentmentAmount: 250_000_000,
        totalsGrandTotalPresentmentCurrency: 'FAIR',
      }) as unknown as OrderRecord,
  );
}

const ACTIVE_SELLER = {
  providerAccountId: 'ca_seller_a',
  faircoinState: 'active',
  faircoinNetwork: 'testnet',
};

beforeAll(async () => {
  process.env.PEABLE_ENABLED = 'true';
  process.env.PEABLE_BASE_URL = 'https://api.peable.test';
  process.env.PEABLE_WEBHOOK_SECRET = 'pwhsec_faircoin_not_a_real_one';
  service = await import('../checkout-payment.service.js');
});

beforeEach(() => {
  openCheckoutSession.mockReset().mockResolvedValue({
    sessionId: 'cs_fair',
    clientSecret: 'cs_fair_secret',
    status: 'open',
    payment: null,
  });
  findSellerAccount.mockReset().mockResolvedValue(ACTIVE_SELLER);
});

describe('a FAIR checkout is ONE FairCoin-only session paying each seller (ADR 0021)', () => {
  it("opens one session whose line names the seller's account, in FAIR", async () => {
    const handoff = await service.openCheckoutPayment({
      rail: 'card', // what an unnamed rail resolves to before the cart; the orders decide
      checkoutGroupId: GROUP,
      orders: fairOrders(STORE_A),
    });

    expect(openCheckoutSession).toHaveBeenCalledTimes(1);
    expect(openCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: PAYMENT_ID,
        currency: 'FAIR',
        idempotencyKey: `cs:${PAYMENT_ID}`,
        lines: [
          expect.objectContaining({ amountMinor: 250_000_000, providerAccountId: 'ca_seller_a' }),
        ],
      }),
    );
    expect(findSellerAccount).toHaveBeenCalledWith({ ownerType: 'store', ownerId: STORE_A });
    // The payer's capability over the session; no card surfaces, no key.
    expect(handoff).toEqual({
      paymentId: PAYMENT_ID,
      provider: 'peable_faircoin',
      checkoutSessionId: 'cs_fair',
      clientSecret: 'cs_fair_secret',
      amount: { amount: 250_000_000, currency: 'FAIR' },
      methods: [],
    });
  });

  it('opens ONE session for a group of two sellers, a line each — one multi-output payment', async () => {
    findSellerAccount.mockImplementation(async (owner: { ownerId: string }) => ({
      ...ACTIVE_SELLER,
      providerAccountId: `ca_${owner.ownerId}`,
    }));
    await service.openCheckoutPayment({
      rail: 'faircoin',
      checkoutGroupId: GROUP,
      orders: fairOrders(STORE_A, STORE_B),
    });
    expect(openCheckoutSession).toHaveBeenCalledTimes(1);
    const [call] = openCheckoutSession.mock.calls;
    expect(
      ((call?.[0] ?? { lines: [] }) as { lines: { providerAccountId: string }[] }).lines.map(
        (l) => l.providerAccountId,
      ),
    ).toEqual([`ca_${STORE_A}`, `ca_${STORE_B}`]);
  });

  it('refuses a seller who has not confirmed, before any session exists at the rail', async () => {
    findSellerAccount.mockResolvedValue({ ...ACTIVE_SELLER, faircoinState: 'pending' });
    await expect(
      service.openCheckoutPayment({
        rail: 'faircoin',
        checkoutGroupId: GROUP,
        orders: fairOrders(STORE_A),
      }),
    ).rejects.toThrow(/cannot be paid in FairCoin yet/);
    expect(openCheckoutSession).not.toHaveBeenCalled();
  });
});

describe('the rail follows the currency (ADR 0019 D1)', () => {
  it('an unnamed rail on a FAIR cart becomes FairCoin; a named one never moves', () => {
    expect(service.selectCheckoutRail('card', undefined, 'FAIR')).toBe('faircoin');
    expect(service.selectCheckoutRail('card', undefined, 'USD')).toBe('card');
    expect(service.selectCheckoutRail('card', 'card', 'FAIR')).toBe('card');
    expect(service.selectCheckoutRail('none', undefined, 'FAIR')).toBe('none');
  });

  it('takes FairCoin on a FAIR or card-currency order (ADR 0020), and names FAIR on a card refusal', () => {
    expect(() => service.assertCheckoutCurrencyEligible('faircoin', 'USD')).not.toThrow();
    expect(() => service.assertCheckoutCurrencyEligible('faircoin', 'FAIR')).not.toThrow();
    expect(() => service.assertCheckoutCurrencyEligible('faircoin', 'EUR')).toThrow(
      /FairCoin payments are made for orders in FAIR or USD/,
    );
    expect(() => service.assertCheckoutCurrencyEligible('card', 'EUR')).toThrow(
      /or to FAIR to pay with FairCoin/,
    );
  });
});
