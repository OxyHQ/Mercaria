/**
 * A seller read is made AS the signed-in viewer (`oxyClient.withUser`, an
 * isolated client bound to their bearer) and as the shared client only for a
 * signed-out viewer — so whatever Oxy withholds from this person, Mercaria
 * withholds too. Both reads fail soft: an outage hides nothing extra.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  withUser: vi.fn(),
  sharedGet: vi.fn(),
  userGet: vi.fn(),
  viewerGraph: vi.fn(),
}));
vi.mock('../../../middleware/auth.js', () => ({
  oxyClient: {
    users: { get: sdk.sharedGet },
    withUser: async (bearer: string, fn: (user: unknown) => Promise<unknown>) => {
      sdk.withUser(bearer);
      return fn({ users: { get: sdk.userGet }, follows: { viewerGraph: sdk.viewerGraph } });
    },
  },
}));
vi.mock('../../../lib/logger.js', () => ({
  log: { general: { warn: vi.fn() } },
}));

const { readSellerOxyUser, viewerHasBlocked } = await import('../viewer-oxy-client.js');

const VIEWER = { oxyUserId: 'viewer', accessToken: 'viewer-bearer' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readSellerOxyUser', () => {
  it('reads as the viewer when one is signed in, never through the shared client', async () => {
    sdk.userGet.mockResolvedValue({ id: 'seller' });
    expect(await readSellerOxyUser('seller', VIEWER)).toEqual({ id: 'seller' });
    expect(sdk.withUser).toHaveBeenCalledExactlyOnceWith('viewer-bearer');
    expect(sdk.userGet).toHaveBeenCalledExactlyOnceWith('seller');
    expect(sdk.sharedGet).not.toHaveBeenCalled();
  });

  it('reads through the shared client for a signed-out viewer', async () => {
    sdk.sharedGet.mockResolvedValue({ id: 'seller' });
    expect(await readSellerOxyUser('seller', null)).toEqual({ id: 'seller' });
    expect(sdk.withUser).not.toHaveBeenCalled();
  });

  it('answers absent, not an error, when Oxy will not say', async () => {
    sdk.userGet.mockRejectedValue(Object.assign(new Error('Bad Gateway'), { status: 502 }));
    expect(await readSellerOxyUser('seller', VIEWER)).toBeNull();
  });
});

describe('viewerHasBlocked', () => {
  it('asks the viewer graph as the viewer', async () => {
    sdk.viewerGraph.mockResolvedValue({ blockedIds: ['seller'] });
    expect(await viewerHasBlocked(VIEWER, 'seller')).toBe(true);
    expect(sdk.withUser).toHaveBeenCalledExactlyOnceWith('viewer-bearer');
  });

  it('asks nothing for a signed-out viewer or the seller themself', async () => {
    expect(await viewerHasBlocked(null, 'seller')).toBe(false);
    expect(await viewerHasBlocked({ ...VIEWER, oxyUserId: 'seller' }, 'seller')).toBe(false);
    expect(sdk.withUser).not.toHaveBeenCalled();
  });

  it('fails open on an outage', async () => {
    sdk.viewerGraph.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect(await viewerHasBlocked(VIEWER, 'seller')).toBe(false);
  });
});
