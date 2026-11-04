import { beforeEach, expect, it, vi } from 'vitest';
import { OxyApiError } from '@oxy.so/core';
const state = vi.hoisted(() => ({ enabled: true, get: vi.fn(), withUser: vi.fn() }));
// The one `oxyClient`'s user client: every read is made AS the store caller.
vi.mock('../../../middleware/auth.js', () => ({
  oxyClient: {
    withUser: async (bearer: string, fn: (user: unknown) => Promise<unknown>) => {
      state.withUser(bearer);
      return fn({ assets: { get: state.get } });
    },
  },
}));
vi.mock('../../../config/index.js', () => ({
  config: {
    catalog: {
      maxImagesPerListing: 12,
      get videoWritesEnabled() {
        return state.enabled;
      },
    },
  },
}));
import { prepareCatalogMedia } from '../verify.js';
const metadata = (fileId: string, overrides: Record<string, unknown> = {}) => ({
  file: {
    id: fileId,
    ownerUserId: 'store-account',
    visibility: 'public',
    status: 'active',
    mime: 'image/png',
    size: 12,
    ...overrides,
  },
});
beforeEach(() => {
  state.enabled = true;
  state.get.mockReset().mockImplementation(async (id) => metadata(id));
  state.withUser.mockReset();
});
it('uses the operator bearer but requires ownership by the persisted store, preserving order', async () => {
  state.get.mockImplementation(async (id) =>
    metadata(id, id === 'clip' ? { mime: 'video/mp4' } : {}),
  );
  expect(await prepareCatalogMedia('store-account', 'operator-bearer', ['clip', 'photo'])).toEqual([
    { kind: 'video', fileId: 'clip', position: 0 },
    { kind: 'image', fileId: 'photo', position: 1 },
  ]);
  expect(state.withUser).toHaveBeenCalledExactlyOnceWith('operator-bearer');
});
it.each([
  { ownerUserId: 'operator-account' },
  { visibility: undefined },
  { visibility: 'private' },
  { status: 'deleted' },
  { id: 'different' },
])('fails closed on invalid metadata %j', async (override) => {
  state.get.mockResolvedValue(metadata('photo', override));
  await expect(prepareCatalogMedia('store-account', 'bearer', ['photo'])).rejects.toMatchObject({
    httpStatus: 403,
  });
});
it('keeps legacy image writes photographic and refuses new videos while the rollout flag is off', async () => {
  state.get.mockResolvedValue(metadata('clip', { mime: 'video/mp4' }));
  await expect(
    prepareCatalogMedia('store-account', 'bearer', ['clip'], true),
  ).rejects.toMatchObject({ httpStatus: 400 });
  state.enabled = false;
  await expect(prepareCatalogMedia('store-account', 'bearer', ['clip'])).rejects.toMatchObject({
    httpStatus: 503,
  });
});
it.each([[['https://external.test/a.mp4']], [['same', 'same']]])(
  'rejects invalid IDs without contacting Oxy',
  async (ids) => {
    await expect(prepareCatalogMedia('store-account', 'bearer', ids)).rejects.toMatchObject({
      httpStatus: 400,
    });
    expect(state.get).not.toHaveBeenCalled();
  },
);
it('distinguishes retryable transport failure from denied access', async () => {
  state.get.mockRejectedValueOnce(
    new OxyApiError('private debug details', { status: 503, code: 'TEST' }),
  );
  await expect(prepareCatalogMedia('store-account', 'bearer', ['photo'])).rejects.toMatchObject({
    httpStatus: 503,
  });
  state.get.mockRejectedValueOnce(
    new OxyApiError('private debug details', { status: 403, code: 'TEST' }),
  );
  await expect(prepareCatalogMedia('store-account', 'bearer', ['photo'])).rejects.toMatchObject({
    httpStatus: 403,
  });
});

it('preserves already-authorized canonical references but cannot add someone else’s files', async () => {
  state.get.mockImplementation(async (id) => metadata(id, { ownerUserId: 'canonical-operator' }));
  expect(
    await prepareCatalogMedia(
      'store-account',
      'bearer',
      ['existing'],
      false,
      new Set(['existing']),
    ),
  ).toEqual([{ fileId: 'existing', kind: 'image', position: 0 }]);
  await expect(
    prepareCatalogMedia('store-account', 'bearer', ['new'], false, new Set(['existing'])),
  ).rejects.toMatchObject({ httpStatus: 403 });
});
