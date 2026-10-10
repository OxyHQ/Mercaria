import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({
  raw: '',
  enabled: true,
  live: false,
  publicKey: 'fixture',
  secret: 'fixture',
  account: vi.fn(),
  merchant: vi.fn(),
  constructed: vi.fn(),
  registered: vi.fn(),
}));
vi.mock('../../../../lib/logger.js', () => ({ log: { general: { info: seam.registered } } }));
vi.mock('../../../../config/index.js', () => ({
  config: {
    payments: {
      stripe: {
        get enabled() {
          return seam.enabled;
        },
        get livemode() {
          return seam.live;
        },
      },
      peable: {
        get publicKey() {
          return seam.publicKey;
        },
        get secret() {
          return seam.secret;
        },
        baseUrl: 'http://unused',
        oxyApiUrl: 'http://unused',
      },
    },
    merchantBilling: {
      enabled: false,
      get peableCohortJson() {
        return seam.raw;
      },
    },
  },
}));
vi.mock('../../../payments/stripe/client.js', () => ({
  getStripeClient: () => {
    if (!seam.enabled) throw new Error('STRIPE_ENABLED is off');
    return { accounts: { retrieve: seam.account }, subscriptions: { retrieve: vi.fn() } };
  },
}));
vi.mock('../../stripe/cohort-reader.js', () => ({
  createBillingCohortStripeReader: () => ({
    platformAccountId: async () => (await seam.account(null)).id,
    subscription: vi.fn(),
  }),
}));
vi.mock('@peable.to/sdk', async (original) => ({
  ...(await original<object>()),
  Peable: class {
    merchants = { retrieve: seam.merchant };
    constructor() {
      seam.constructed();
    }
  },
}));
import { registerMerchantBillingProvider } from '../../register.js';
import { billingCohortSchema } from '../adapter.js';
import { getBillingProvider, resetBillingProviders } from '../../provider.js';
const cohort = {
  merchantId: 'merchant',
  applicationId: 'app',
  environment: 'development',
  platformAccountId: 'acct_fixture',
  livemode: false,
  storeIds: ['01900000-0000-7000-8000-000000000001'],
};
// Public handles from root's accepted production merchant/store/account readbacks.
// The authority responses and credential pair below remain synthetic local seams.
const acceptedCohort = {
  merchantId: 'merch_bd106296a0fef49a861ee6b7',
  applicationId: '6a37d0cc5d4b5f15482a9340',
  environment: 'production',
  platformAccountId: 'acct_1TnXkUQWiCE02OnU',
  livemode: true,
  storeIds: ['6a39a7d5b5809e55ba556ad0', '6a77367c30650db22f728092'],
};
function configureAcceptedCohort(): void {
  seam.enabled = false;
  seam.live = true;
  seam.raw = JSON.stringify(acceptedCohort);
  seam.account.mockResolvedValue({ id: acceptedCohort.platformAccountId });
  seam.merchant.mockResolvedValue({
    id: acceptedCohort.merchantId,
    oxyAppId: acceptedCohort.applicationId,
    environment: acceptedCohort.environment,
  });
}
beforeEach(() => {
  resetBillingProviders();
  seam.raw = '';
  seam.enabled = true;
  seam.live = false;
  seam.publicKey = 'fixture';
  seam.secret = 'fixture';
  seam.account.mockReset().mockResolvedValue({ id: 'acct_fixture' });
  seam.merchant
    .mockReset()
    .mockResolvedValue({ id: 'merchant', oxyAppId: 'app', environment: 'development' });
  seam.constructed.mockClear();
  seam.registered.mockClear();
});
describe('billing cohort registration', () => {
  it('registers the accepted two historical stores with the exact production namespace while general Stripe remains off', async () => {
    configureAcceptedCohort();
    await registerMerchantBillingProvider();
    const provider = getBillingProvider('stripe')!;
    expect(provider.livemode).toBe(true);
    expect(seam.registered).toHaveBeenCalledExactlyOnceWith(
      {
        cohortSha256: createHash('sha256')
          .update(JSON.stringify(billingCohortSchema.parse(acceptedCohort)))
          .digest('hex'),
        mode: 'live',
        environment: 'production',
        storeCount: 2,
      },
      'Merchant billing cohort registered',
    );
    for (const storeId of acceptedCohort.storeIds)
      expect(provider.requiresExplicitIntent!(storeId)).toBe(true);
    expect(provider.requiresExplicitIntent!('6a77367c30650db22f728093')).toBe(false);
    expect(seam.enabled).toBe(false);
    expect(seam.account).toHaveBeenCalledWith(null);
    expect(seam.merchant).toHaveBeenCalledTimes(1);
    await expect(
      provider.ensureCustomer({
        storeId: '6a77367c30650db22f728093',
        storeName: 'outside',
        idempotencyKey: 'owned-intent',
      }),
    ).rejects.toThrow('STRIPE_ENABLED is off');
  });
  it('attests the same parsed cohort hash for reordered raw JSON fields', async () => {
    configureAcceptedCohort();
    seam.raw = JSON.stringify(Object.fromEntries(Object.entries(acceptedCohort).reverse()));
    await registerMerchantBillingProvider();
    expect(seam.registered).toHaveBeenCalledExactlyOnceWith(
      {
        cohortSha256: createHash('sha256')
          .update(JSON.stringify(billingCohortSchema.parse(acceptedCohort)))
          .digest('hex'),
        mode: 'live',
        environment: 'production',
        storeCount: 2,
      },
      'Merchant billing cohort registered',
    );
  });
  for (const field of [
    'merchantId',
    'applicationId',
    'environment',
    'platformAccountId',
    'livemode',
  ] as const) {
    it(`rejects a mismatched ${field} for the accepted cohort before registration`, async () => {
      configureAcceptedCohort();
      if (field === 'platformAccountId') seam.account.mockResolvedValue({ id: 'acct_foreign' });
      else if (field === 'livemode') seam.live = false;
      else
        seam.merchant.mockResolvedValue({
          id: acceptedCohort.merchantId,
          oxyAppId: acceptedCohort.applicationId,
          environment: acceptedCohort.environment,
          ...(field === 'merchantId'
            ? { id: 'foreign' }
            : field === 'applicationId'
              ? { oxyAppId: 'foreign' }
              : { environment: 'development' }),
        });
      await expect(registerMerchantBillingProvider()).rejects.toThrow(
        field === 'platformAccountId' || field === 'livemode'
          ? 'platform account or mode'
          : 'different namespace',
      );
      expect(getBillingProvider('stripe')).toBeUndefined();
      expect(seam.registered).not.toHaveBeenCalled();
    });
  }
  it('retains default legacy without querying or constructing Peable', async () => {
    await registerMerchantBillingProvider();
    expect(getBillingProvider('stripe')).toBeDefined();
    expect(seam.account).not.toHaveBeenCalled();
    expect(seam.constructed).not.toHaveBeenCalled();
    expect(seam.registered).not.toHaveBeenCalled();
  });
  it('rejects malformed configuration without leaving a legacy fallback', async () => {
    seam.raw = '{ SECRET_CANARY';
    await expect(registerMerchantBillingProvider()).rejects.toThrow(
      'Invalid merchant billing cohort configuration.',
    );
    expect(getBillingProvider('stripe')).toBeUndefined();
    expect(seam.account).not.toHaveBeenCalled();
  });
  for (const mismatch of ['account', 'mode', 'namespace']) {
    it(`rejects ${mismatch} before installing any provider`, async () => {
      seam.raw = JSON.stringify(cohort);
      if (mismatch === 'account') seam.account.mockResolvedValue({ id: 'acct_foreign' });
      if (mismatch === 'mode') seam.live = true;
      if (mismatch === 'namespace')
        seam.merchant.mockResolvedValue({
          id: 'other',
          oxyAppId: 'app',
          environment: 'development',
        });
      await expect(registerMerchantBillingProvider()).rejects.toThrow();
      expect(getBillingProvider('stripe')).toBeUndefined();
      expect(seam.registered).not.toHaveBeenCalled();
    });
  }
  it('retains cohort routing while the new-action flag is off', async () => {
    seam.raw = JSON.stringify(cohort);
    await registerMerchantBillingProvider();
    expect(getBillingProvider('stripe')!.requiresExplicitIntent!(cohort.storeIds[0]!)).toBe(true);
    expect(getBillingProvider('stripe')!.requiresExplicitIntent!('another-store')).toBe(false);
    expect(seam.account).toHaveBeenCalledWith(null);
    expect(seam.merchant).toHaveBeenCalledTimes(1);
  });
  it('registers an explicit verified cohort while the general Stripe rail is off', async () => {
    seam.enabled = false;
    seam.raw = JSON.stringify(cohort);
    await registerMerchantBillingProvider();
    expect(getBillingProvider('stripe')!.requiresExplicitIntent!(cohort.storeIds[0]!)).toBe(true);
    expect(seam.account).toHaveBeenCalledWith(null);
    expect(seam.merchant).toHaveBeenCalledTimes(1);
    expect(seam.enabled).toBe(false);
  });
  it('keeps an absent cohort and disabled general rail unregistered', async () => {
    seam.enabled = false;
    await registerMerchantBillingProvider();
    expect(getBillingProvider('stripe')).toBeUndefined();
    expect(seam.account).not.toHaveBeenCalled();
    expect(seam.constructed).not.toHaveBeenCalled();
    expect(seam.registered).not.toHaveBeenCalled();
  });
  it('fails closed on malformed cohort even with the general rail off', async () => {
    seam.enabled = false;
    seam.raw = '{ SECRET_CANARY';
    await expect(registerMerchantBillingProvider()).rejects.toThrow(
      'Invalid merchant billing cohort configuration.',
    );
    expect(getBillingProvider('stripe')).toBeUndefined();
    expect(seam.account).not.toHaveBeenCalled();
  });
  for (const missing of ['publicKey', 'secret'] as const) {
    it(`rejects missing ${missing} before provider or gateway reads`, async () => {
      seam.raw = JSON.stringify(cohort);
      seam[missing] = '';
      await expect(registerMerchantBillingProvider()).rejects.toThrow(
        'complete Peable application credential',
      );
      expect(seam.account).not.toHaveBeenCalled();
      expect(seam.merchant).not.toHaveBeenCalled();
      expect(getBillingProvider('stripe')).toBeUndefined();
      expect(seam.registered).not.toHaveBeenCalled();
    });
  }
  it('does not enable the out-of-cohort legacy mutator', async () => {
    seam.enabled = false;
    seam.raw = JSON.stringify(cohort);
    await registerMerchantBillingProvider();
    await expect(
      getBillingProvider('stripe')!.ensureCustomer({
        storeId: 'outside',
        storeName: 'outside',
        idempotencyKey: 'owned-intent',
      }),
    ).rejects.toThrow('STRIPE_ENABLED is off');
    expect(seam.merchant).toHaveBeenCalledTimes(1); // Registration only; no cohort fallback.
  });
});

describe('canonical store ID configuration boundary', () => {
  it('preserves historical ObjectIds and generated UUIDv7 IDs without rewriting them', () => {
    expect(
      billingCohortSchema.parse({
        ...acceptedCohort,
        storeIds: [...acceptedCohort.storeIds, cohort.storeIds[0]!],
      }).storeIds,
    ).toEqual([...acceptedCohort.storeIds, cohort.storeIds[0]!]);
  });
  for (const storeId of [
    '6a39a7d5b5809e55ba556ad',
    '6a39a7d5b5809e55ba556ad00',
    '6a39a7d5b5809e55ba556adz',
    ' 6a39a7d5b5809e55ba556ad0',
    '6a39a7d5b5809e55ba556ad0 ',
    '01900000-0000-4000-8000-000000000001',
    '',
    'arbitrary-store',
  ]) {
    it(`rejects malformed or unsupported store ID ${JSON.stringify(storeId)}`, () => {
      expect(
        billingCohortSchema.safeParse({ ...acceptedCohort, storeIds: [storeId] }).success,
      ).toBe(false);
    });
  }
  it('rejects empty cohorts, extra fields, and production/test mismatch', () => {
    expect(billingCohortSchema.safeParse({ ...acceptedCohort, storeIds: [] }).success).toBe(false);
    expect(billingCohortSchema.safeParse({ ...acceptedCohort, extra: true }).success).toBe(false);
    expect(billingCohortSchema.safeParse({ ...acceptedCohort, livemode: false }).success).toBe(
      false,
    );
  });
});
