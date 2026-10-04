import { afterEach, expect, it, vi } from 'vitest';
const cohort = { merchantId: 'merchant-fixture', applicationId: 'app-fixture', environment: 'development', platformAccountId: 'acct_fixture', livemode: false, storeIds: ['6a39a7d5b5809e55ba556ad0'] };
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
async function read(actions: boolean, extra: Record<string, string> = {}) {
  vi.resetModules();
  for (const [name, value] of Object.entries({ STRIPE_ENABLED: 'false', STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', MERCHANT_BILLING_PEABLE_COHORT: JSON.stringify(cohort), PEABLE_APP_PUBLIC_KEY: 'fixture-public', PEABLE_APP_SECRET: 'fixture-secret', MERCHANT_BILLING_ENABLED: String(actions), ...extra })) vi.stubEnv(name, value);
  return (await import('../index.js')).config;
}
it('enables the existing action flag through only the explicit billing cohort', async () => {
  const config = await read(true); expect(config.merchantBilling.enabled).toBe(true); expect(config.payments.stripe.enabled).toBe(false); expect(config.payments.peable.enabled).toBe(false);
});
it('keeps new actions off independently of durable cohort maintenance', async () => {
  expect((await read(false)).merchantBilling.enabled).toBe(false);
});
for (const name of ['PEABLE_APP_PUBLIC_KEY', 'PEABLE_APP_SECRET', 'STRIPE_WEBHOOK_SECRET', 'MERCHANT_BILLING_PEABLE_COHORT']) it(`fails closed without ${name}`, async () => {
  expect((await read(true, { [name]: '' })).merchantBilling.enabled).toBe(false);
});
it('rejects a key for the other mode without enabling actions', async () => {
  expect((await read(true, { STRIPE_SECRET_KEY: 'sk_live_fixture' })).merchantBilling.enabled).toBe(false);
});
it('rejects malformed namespace rather than enabling a fallback', async () => {
  await expect(read(true, { MERCHANT_BILLING_PEABLE_COHORT: '{secret-canary' })).rejects.toThrow('Invalid merchant billing cohort configuration.');
});

it('rejects malformed cohort even when new actions are off', async () => {
  await expect(read(false, { MERCHANT_BILLING_PEABLE_COHORT: '{canary' })).rejects.toThrow('Invalid merchant billing cohort configuration.');
});
