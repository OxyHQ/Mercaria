import { afterEach, expect, it, vi } from 'vitest';
const cohort = {
  merchantId: 'merchant-fixture',
  applicationId: 'app-fixture',
  environment: 'development',
  platformAccountId: 'acct_fixture',
  livemode: false,
  storeIds: ['6a39a7d5b5809e55ba556ad0'],
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
async function read(actions: boolean, extra: Record<string, string> = {}) {
  vi.resetModules();
  for (const [name, value] of Object.entries({
    STRIPE_ENABLED: 'false',
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    MERCHANT_BILLING_PEABLE_COHORT: JSON.stringify(cohort),
    // Workload metadata availability; these config tests do not mint a token.
    OXY_APPLICATION_KEY: '',
    OXY_APPLICATION_SECRET: '',
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/fixture',
    AWS_CONTAINER_CREDENTIALS_FULL_URI: '',
    MERCHANT_BILLING_ENABLED: String(actions),
    ...extra,
  }))
    vi.stubEnv(name, value);
  return (await import('../index.js')).config;
}
it('enables the existing action flag through only the explicit billing cohort', async () => {
  const config = await read(true);
  expect(config.merchantBilling.enabled).toBe(true);
  expect(config.payments.stripe.enabled).toBe(false);
  expect(config.payments.peable.enabled).toBe(false);
});
it('keeps new actions off independently of durable cohort maintenance', async () => {
  expect((await read(false)).merchantBilling.enabled).toBe(false);
});
// Billing configuration is checked here; workload credentials resolve when the request is sent.
for (const name of ['STRIPE_WEBHOOK_SECRET', 'MERCHANT_BILLING_PEABLE_COHORT'])
  it(`fails closed without ${name}`, async () => {
    expect((await read(true, { [name]: '' })).merchantBilling.enabled).toBe(false);
  });
it('allows workload-configured billing without a customer key pair', async () => {
  const config = await read(true, {
    OXY_APPLICATION_KEY: '',
    OXY_APPLICATION_SECRET: '',
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/fixture',
  });
  expect(config.merchantBilling.enabled).toBe(true);
  expect(config.payments.peable).not.toHaveProperty('publicKey');
  expect(config.payments.peable).not.toHaveProperty('secret');
});
it('does not infer workload readiness or configure customer keys from local environment flags', async () => {
  const config = await read(true, {
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '',
    OXY_APPLICATION_KEY: 'external-key',
    OXY_APPLICATION_SECRET: 'external-secret',
  });
  expect(config.merchantBilling.enabled).toBe(true);
  expect(config.payments.peable).not.toHaveProperty('publicKey');
  expect(config.payments.peable).not.toHaveProperty('secret');
});
it('rejects a key for the other mode without enabling actions', async () => {
  expect((await read(true, { STRIPE_SECRET_KEY: 'sk_live_fixture' })).merchantBilling.enabled).toBe(
    false,
  );
});
it('rejects malformed namespace rather than enabling a fallback', async () => {
  await expect(read(true, { MERCHANT_BILLING_PEABLE_COHORT: '{secret-canary' })).rejects.toThrow(
    'Invalid merchant billing cohort configuration.',
  );
});

it('rejects malformed cohort even when new actions are off', async () => {
  await expect(read(false, { MERCHANT_BILLING_PEABLE_COHORT: '{canary' })).rejects.toThrow(
    'Invalid merchant billing cohort configuration.',
  );
});

it('preserves broad Stripe actions for non-cohort stores when the general rail is enabled', async () => {
  const config = await read(true, {
    STRIPE_ENABLED: 'true',
    STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_fixture',
    MERCHANT_BILLING_PEABLE_COHORT: '',
    MERCHANT_BILLING_RETURN_URL: 'https://dashboard.mercaria.co/settings/plan',
  });
  const { registerBillingProvider } = await import('../../services/billing/provider.js');
  const { StripeBillingProvider } = await import('../../services/billing/stripe/stripe-billing.js');
  const { startMerchantPlanCheckout } = await import(
    '../../services/billing/subscription.service.js'
  );
  const postgres = await import('../../db/postgres.js');
  expect(config.payments.stripe.enabled).toBe(true);
  expect(config.merchantBilling.enabled).toBe(true);
  registerBillingProvider(new StripeBillingProvider());
  await postgres.connectPostgres();
  try {
    // An absent plan is rejected by the original plan lookup, not by cohort scope.
    await expect(
      startMerchantPlanCheckout({
        storeId: '6a77367c30650db22f728092',
        storeName: 'Owned non-cohort control',
        planId: '00000000-0000-4000-8000-000000000099',
        interval: 'monthly',
        currency: 'USD',
        actorOxyUserId: 'owned-control',
      }),
    ).rejects.toThrow('Plan not found');
  } finally {
    await postgres.closePostgres();
  }
});
