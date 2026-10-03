import { beforeEach, describe, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({ raw: '', enabled: true, live: false, account: vi.fn(), merchant: vi.fn(), constructed: vi.fn() }));
vi.mock('../../../../config/index.js', () => ({ config: { payments: { stripe: { get enabled() { return seam.enabled; }, get livemode() { return seam.live; } }, peable: { publicKey: 'fixture', secret: 'fixture', baseUrl: 'http://unused', oxyApiUrl: 'http://unused' } }, merchantBilling: { enabled: false, get peableCohortJson() { return seam.raw; } } } }));
vi.mock('../../../payments/stripe/client.js', () => ({ getStripeClient: () => ({ accounts: { retrieve: seam.account }, subscriptions: { retrieve: vi.fn() } }) }));
vi.mock('@peable.to/sdk', async original => ({ ...(await original<object>()), Peable: class { merchants = { retrieve: seam.merchant }; constructor() { seam.constructed(); } } }));
import { registerMerchantBillingProvider } from '../../register.js';
import { getBillingProvider, resetBillingProviders } from '../../provider.js';
const cohort = { merchantId: 'merchant', applicationId: 'app', environment: 'development', platformAccountId: 'acct_fixture', livemode: false, storeIds: ['01900000-0000-7000-8000-000000000001'] };
beforeEach(() => {
  resetBillingProviders(); seam.raw = ''; seam.enabled = true; seam.live = false;
  seam.account.mockReset().mockResolvedValue({ id: 'acct_fixture' });
  seam.merchant.mockReset().mockResolvedValue({ id: 'merchant', oxyAppId: 'app', environment: 'development' });
  seam.constructed.mockClear();
});
describe('billing cohort registration', () => {
  it('retains default legacy without querying or constructing Peable', async () => {
    await registerMerchantBillingProvider(); expect(getBillingProvider('stripe')).toBeDefined();
    expect(seam.account).not.toHaveBeenCalled(); expect(seam.constructed).not.toHaveBeenCalled();
  });
  it('rejects malformed configuration without leaving a legacy fallback', async () => {
    seam.raw = '{ SECRET_CANARY'; await expect(registerMerchantBillingProvider()).rejects.toThrow('Invalid merchant billing cohort configuration.');
    expect(getBillingProvider('stripe')).toBeUndefined(); expect(seam.account).not.toHaveBeenCalled();
  });
  for (const mismatch of ['account', 'mode', 'namespace']) {
    it(`rejects ${mismatch} before installing any provider`, async () => {
      seam.raw = JSON.stringify(cohort);
      if (mismatch === 'account') seam.account.mockResolvedValue({ id: 'acct_foreign' });
      if (mismatch === 'mode') seam.live = true;
      if (mismatch === 'namespace') seam.merchant.mockResolvedValue({ id: 'other', oxyAppId: 'app', environment: 'development' });
      await expect(registerMerchantBillingProvider()).rejects.toThrow();
      expect(getBillingProvider('stripe')).toBeUndefined();
    });
  }
  it('retains cohort routing while the new-action flag is off', async () => {
    seam.raw = JSON.stringify(cohort); await registerMerchantBillingProvider();
    expect(getBillingProvider('stripe')!.requiresExplicitIntent!(cohort.storeIds[0]!)).toBe(true);
    expect(getBillingProvider('stripe')!.requiresExplicitIntent!('another-store')).toBe(false);
    expect(seam.account).toHaveBeenCalledWith(null);
    expect(seam.merchant).toHaveBeenCalledTimes(1);
  });
});
