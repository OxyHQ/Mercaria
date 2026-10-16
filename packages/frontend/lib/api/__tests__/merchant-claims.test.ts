import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../client', () => ({ default: client }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
import {
  contestMerchantClaim,
  issueMerchantClaimChallenge,
  merchantClaimErrorStatus,
  openMerchantClaim,
  verifyMerchantClaim,
} from '../merchant-claims';
import { bindMerchantReferral } from '../referrals';

/** An axios-shaped rejection, which is all `axios.isAxiosError` looks at. */
function httpError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: { success: false } },
  });
}

describe('the claimant surface', () => {
  beforeEach(() => vi.resetAllMocks());

  it('opens a claim with exactly the fields the strict schema admits', async () => {
    client.post.mockResolvedValue({ data: { success: true, data: { id: 'c1' } } });
    await openMerchantClaim({ merchantId: 'm1', method: 'dns_txt', domain: 'shop.example' });
    expect(client.post).toHaveBeenCalledWith('/merchant-claims', {
      merchantId: 'm1',
      method: 'dns_txt',
      domain: 'shop.example',
    });
  });

  it('issues a challenge and presents the token back to verify it', async () => {
    client.post.mockResolvedValue({ data: { success: true, data: { token: 't' } } });
    await issueMerchantClaimChallenge('c/1');
    await verifyMerchantClaim({ claimId: 'c/1', token: 't' });
    expect(client.post).toHaveBeenNthCalledWith(1, '/merchant-claims/c%2F1/challenge');
    expect(client.post).toHaveBeenNthCalledWith(2, '/merchant-claims/c%2F1/verify', {
      token: 't',
    });
  });

  it('sends a contest to the route that precedes /:id', async () => {
    client.post.mockResolvedValue({ data: { success: true, data: { id: 'c2' } } });
    await contestMerchantClaim({ merchantId: 'm1', reason: 'x'.repeat(20) });
    expect(client.post).toHaveBeenCalledWith('/merchant-claims/contest', {
      merchantId: 'm1',
      reason: 'x'.repeat(20),
    });
  });

  it('reads the status a refusal carried, and nothing from an offline failure', () => {
    expect(merchantClaimErrorStatus(httpError(409))).toBe(409);
    expect(merchantClaimErrorStatus(new Error('offline'))).toBeUndefined();
  });
});

describe('the referral binding after a claim opens', () => {
  beforeEach(() => vi.resetAllMocks());

  it('posts the merchant and a coarse surface, and never consent', async () => {
    const result = { state: 'attributed', disclosureRequired: true };
    client.post.mockResolvedValue({ data: { success: true, data: result } });
    await expect(bindMerchantReferral({ merchantId: 'm1', surface: 'web' })).resolves.toEqual(
      result,
    );
    expect(client.post).toHaveBeenCalledWith('/referrals/merchant-binding', {
      merchantId: 'm1',
      surface: 'web',
    });
  });

  it('treats an unmounted edge, or any failure, as nothing bound — never a throw', async () => {
    client.post.mockRejectedValueOnce(httpError(404));
    await expect(bindMerchantReferral({ merchantId: 'm1', surface: 'web' })).resolves.toBeNull();
    client.post.mockRejectedValueOnce(httpError(500));
    await expect(bindMerchantReferral({ merchantId: 'm1', surface: 'web' })).resolves.toBeNull();
    client.post.mockRejectedValueOnce(new Error('offline'));
    await expect(bindMerchantReferral({ merchantId: 'm1', surface: 'web' })).resolves.toBeNull();
  });
});
