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
import { PaymentProviderError } from '../provider.js';

const GROUP = uuidv7();
const PAYMENT_ID = uuidv7();
const STORE_A = uuidv7();
const STORE_B = uuidv7();

const createPayment = vi.fn();
const findSellerAccount = vi.fn();

vi.mock('../guest-correlation.js', () => ({
  findGuestCheckoutIdForGroup: () => Promise.resolve(undefined),
}));
vi.mock('../payment.service.js', () => ({
  ensurePayment: () =>
    Promise.resolve({ id: PAYMENT_ID, checkoutGroupId: GROUP, providerObjectId: null }),
}));
vi.mock('../registry.js', () => ({
  resolvePaymentProvider: (provider: string) => ({
    id: provider,
    createPayment: (...args: unknown[]) => createPayment(...args),
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
  attachPaymentProviderObject: () => Promise.resolve(undefined),
  findNativePaymentByCheckoutGroupId: () => Promise.resolve(undefined),
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

const INSTRUCTION = {
  address: 'tFairSellerAddress',
  network: 'testnet',
  amount: { amount: 250_000_000, currency: 'FAIR' },
  uri: 'faircoin:tFairSellerAddress?amount=2.5',
} as const;

beforeAll(async () => {
  process.env.PEABLE_ENABLED = 'true';
  process.env.PEABLE_BASE_URL = 'https://api.peable.test';
  process.env.PEABLE_WEBHOOK_SECRET = 'pwhsec_faircoin_not_a_real_one';
  service = await import('../checkout-payment.service.js');
});

beforeEach(() => {
  createPayment.mockReset().mockResolvedValue({
    providerObjectId: 'pi_fair',
    status: 'requires_action',
    clientAction: { kind: 'client_secret', value: 'pi_fair_secret' },
    faircoin: INSTRUCTION,
  });
  findSellerAccount.mockReset().mockResolvedValue(ACTIVE_SELLER);
});

describe('a FAIR checkout pays the seller in FairCoin (ADR 0019 D3)', () => {
  it("creates an on-behalf payment for the ONE seller's account, in FAIR, expiring with the reservation", async () => {
    const handoff = await service.openCheckoutPayment({
      rail: 'card', // what an unnamed rail resolves to before the cart; the orders decide
      checkoutGroupId: GROUP,
      orders: fairOrders(STORE_A),
    });

    expect(createPayment).toHaveBeenCalledTimes(1);
    expect(createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: PAYMENT_ID,
        amount: { amount: 250_000_000, currency: 'FAIR' },
        idempotencyKey: `pi:${PAYMENT_ID}`,
        onBehalfOf: { providerAccountId: 'ca_seller_a', network: 'testnet' },
        expiresInSeconds: 900,
      }),
    );
    expect(findSellerAccount).toHaveBeenCalledWith({ ownerType: 'store', ownerId: STORE_A });
    // The payer's instruction and capability; no card surfaces, no key.
    expect(handoff).toEqual({
      paymentId: PAYMENT_ID,
      provider: 'peable_faircoin',
      rail: 'faircoin',
      faircoin: INSTRUCTION,
      providerPaymentId: 'pi_fair',
      clientSecret: 'pi_fair_secret',
      amount: { amount: 250_000_000, currency: 'FAIR' },
      methods: [],
    });
  });

  it('refuses a group of two sellers: one FairCoin payment pays one wallet', async () => {
    await expect(
      service.openCheckoutPayment({
        rail: 'faircoin',
        checkoutGroupId: GROUP,
        orders: fairOrders(STORE_A, STORE_B),
      }),
    ).rejects.toThrow(/one seller/);
    expect(createPayment).not.toHaveBeenCalled();
  });

  it('refuses a seller who has not confirmed, before any payment exists at the rail', async () => {
    findSellerAccount.mockResolvedValue({ ...ACTIVE_SELLER, faircoinState: 'pending' });
    await expect(
      service.openCheckoutPayment({
        rail: 'faircoin',
        checkoutGroupId: GROUP,
        orders: fairOrders(STORE_A),
      }),
    ).rejects.toThrow(/cannot be paid in FairCoin yet/);
    expect(createPayment).not.toHaveBeenCalled();
  });

  it.each([
    ['faircoin_network_closed', 'faircoin_network_closed'],
    ['faircoin_wallet_missing', 'faircoin_wallet_missing'],
    ['account_not_ready', 'seller_not_confirmed'],
  ])("turns Peable's %s into a classified refusal naming %s", async (code, reason) => {
    createPayment.mockRejectedValue(
      new PaymentProviderError({
        provider: 'peable_faircoin',
        stage: 'createPayment',
        message: 'refused',
        retryable: false,
        code,
      }),
    );
    await expect(
      service.openCheckoutPayment({
        rail: 'faircoin',
        checkoutGroupId: GROUP,
        orders: fairOrders(STORE_A),
      }),
    ).rejects.toMatchObject({
      reason: 'faircoin_unavailable',
      details: { reason: 'faircoin_unavailable', unavailableReason: reason },
    });
  });
});

describe('the rail follows the currency (ADR 0019 D1)', () => {
  it('an unnamed rail on a FAIR cart becomes FairCoin; a named one never moves', () => {
    expect(service.selectCheckoutRail('card', undefined, 'FAIR')).toBe('faircoin');
    expect(service.selectCheckoutRail('card', undefined, 'USD')).toBe('card');
    expect(service.selectCheckoutRail('card', 'card', 'FAIR')).toBe('card');
    expect(service.selectCheckoutRail('none', undefined, 'FAIR')).toBe('none');
  });

  it('refuses FairCoin in a fiat currency, and names FAIR on a card refusal', () => {
    expect(() => service.assertCheckoutCurrencyEligible('faircoin', 'USD')).toThrow(
      /FairCoin payments are made in FAIR/,
    );
    expect(() => service.assertCheckoutCurrencyEligible('faircoin', 'FAIR')).not.toThrow();
    expect(() => service.assertCheckoutCurrencyEligible('card', 'EUR')).toThrow(
      /or to FAIR to pay with FairCoin/,
    );
  });
});
