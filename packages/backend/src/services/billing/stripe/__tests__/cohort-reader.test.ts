import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingCohort } from '../../peable/adapter.js';

const seam = vi.hoisted(() => ({
  key: 'sk_live_fixture',
  enabled: false,
  constructed: vi.fn(),
  fetch: vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 'acct_fixture' }), { status: 200 }),
  ),
}));
vi.mock('../../../../config/index.js', () => ({
  config: {
    payments: {
      stripe: {
        get secretKey() {
          return seam.key;
        },
        get enabled() {
          return seam.enabled;
        },
        get livemode() {
          return seam.key.startsWith('sk_live_');
        },
      },
    },
  },
}));
// Preserve the real published Stripe SDK request encoder, injecting only its
// documented fetch transport. No real provider requests or authority claimed.
vi.mock('stripe', async (original) => {
  const module = await original<typeof import('stripe')>();
  const Actual = module.default;
  return {
    ...module,
    default: class extends Actual {
      constructor(key: string, options?: ConstructorParameters<typeof Actual>[1]) {
        seam.constructed();
        super(key, { ...options, httpClient: Actual.createFetchHttpClient(seam.fetch) });
      }
    },
  };
});

import { createBillingCohortStripeReader } from '../cohort-reader.js';
import { getStripeClient, resetStripeClient } from '../../../payments/stripe/client.js';
import { StripeBillingProvider } from '../stripe-billing.js';

const cohort: BillingCohort = {
  merchantId: 'merchant',
  applicationId: 'app',
  environment: 'production',
  platformAccountId: 'acct_fixture',
  livemode: true,
  storeIds: ['01900000-0000-7000-8000-000000000001'],
};
beforeEach(() => {
  seam.key = 'sk_live_fixture';
  seam.enabled = false;
  seam.constructed.mockClear();
  seam.fetch.mockReset();
  seam.fetch.mockResolvedValue(
    new Response(JSON.stringify({ id: 'acct_fixture' }), { status: 200 }),
  );
  resetStripeClient();
});

describe('explicit cohort reader with the general Stripe rail disabled', () => {
  it('uses the real SDK for only the platform-account and exact-subscription GETs', async () => {
    const reader = createBillingCohortStripeReader(cohort);
    expect(Object.keys(reader).sort()).toEqual([
      'charge',
      'invoice',
      'platformAccountId',
      'subscription',
    ]);
    expect(await reader.platformAccountId()).toBe('acct_fixture');
    seam.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'sub_fixture' }), { status: 200 }),
    );
    expect((await reader.subscription('sub_fixture')).id).toBe('sub_fixture');
    expect(
      seam.fetch.mock.calls.map(([url, options]) => ({
        url: String(url),
        method: options?.method,
      })),
    ).toEqual([
      { url: 'https://api.stripe.com/v1/account', method: 'GET' },
      { url: 'https://api.stripe.com/v1/subscriptions/sub_fixture', method: 'GET' },
    ]);
    expect(seam.enabled).toBe(false);
  });
  for (const key of ['', 'sk_test_fixture', 'rk_live_fixture', 'not_a_key']) {
    it(`rejects invalid or mismatched key ${key || '(missing)'} before construction/fetch`, () => {
      seam.key = key;
      expect(() => createBillingCohortStripeReader(cohort)).toThrow('reader key or mode');
      expect(seam.constructed).not.toHaveBeenCalled();
      expect(seam.fetch).not.toHaveBeenCalled();
    });
  }
  it('supports an explicitly configured sandbox namespace without turning it live', async () => {
    seam.key = 'sk_test_fixture';
    const reader = createBillingCohortStripeReader({
      ...cohort,
      livemode: false,
      environment: 'development',
    });
    expect(await reader.platformAccountId()).toBe('acct_fixture');
    expect(seam.enabled).toBe(false);
  });
  it('rejects inconsistent environment before construction', () => {
    expect(() =>
      createBillingCohortStripeReader({ ...cohort, environment: 'development' }),
    ).toThrow('reader key or mode');
    expect(seam.constructed).not.toHaveBeenCalled();
  });
  it('rejects foreign/malformed subscription identifiers before SDK requests', async () => {
    const reader = createBillingCohortStripeReader(cohort);
    for (const id of ['acct_connected', '../subscriptions/sub_other', 'sub_']) {
      await expect(reader.subscription(id)).rejects.toThrow(
        'Invalid merchant billing subscription',
      );
    }
    expect(seam.fetch).not.toHaveBeenCalled();
  });
  it('keeps the general client and all direct legacy mutations disabled', async () => {
    expect(() => getStripeClient()).toThrow('STRIPE_ENABLED is off');
    const legacy = new StripeBillingProvider();
    await expect(
      legacy.ensureCustomer({
        storeId: 'outside',
        storeName: 'outside',
        idempotencyKey: 'existing-intent',
      }),
    ).rejects.toThrow('STRIPE_ENABLED is off');
    await expect(
      legacy.createCheckoutSession({
        providerCustomerId: 'cus_fixture',
        providerPriceId: 'price_fixture',
        storeId: 'outside',
        planId: 'plan',
        trialDays: 0,
        returnUrl: 'https://mercaria.co',
        idempotencyKey: 'existing-intent',
      }),
    ).rejects.toThrow('STRIPE_ENABLED is off');
    await expect(
      legacy.createPortalSession({
        providerCustomerId: 'cus_fixture',
        returnUrl: 'https://mercaria.co',
      }),
    ).rejects.toThrow('STRIPE_ENABLED is off');
    await expect(legacy.cancelAtPeriodEnd('sub_fixture')).rejects.toThrow('STRIPE_ENABLED is off');
    expect(seam.constructed).not.toHaveBeenCalled();
    expect(seam.fetch).not.toHaveBeenCalled();
  });
});
