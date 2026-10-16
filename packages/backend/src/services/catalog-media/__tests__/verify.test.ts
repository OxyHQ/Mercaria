import { beforeEach, expect, it, vi } from 'vitest';
import { OxyApiError } from '@oxy.so/core';
const state = vi.hoisted(() => ({ get: vi.fn(), setAccessToken: vi.fn() }));
vi.mock('@oxy.so/core', async (original) => ({
  ...(await original<typeof import('@oxy.so/core')>()),
  OxyServices: class {
    assets = { get: state.get };
    session = { setAccessToken: state.setAccessToken };
  },
}));
vi.mock('../../../config/index.js', () => ({
  config: {
    catalog: {
      maxImagesPerListing: 12,
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
  state.get.mockReset().mockImplementation(async (id) => metadata(id));
  state.setAccessToken.mockReset();
});
it('uses the operator bearer but requires ownership by the persisted store, preserving order', async () => {
  state.get.mockImplementation(async (id) =>
    metadata(id, id === 'clip' ? { mime: 'video/mp4' } : {}),
  );
  expect(await prepareCatalogMedia('store-account', 'operator-bearer', ['clip', 'photo'])).toEqual([
    { kind: 'video', fileId: 'clip', position: 0 },
    { kind: 'image', fileId: 'photo', position: 1 },
  ]);
  expect(state.setAccessToken).toHaveBeenCalledExactlyOnceWith('operator-bearer');
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
it('keeps legacy image writes photographic', async () => {
  state.get.mockResolvedValue(metadata('clip', { mime: 'video/mp4' }));
  await expect(
    prepareCatalogMedia('store-account', 'bearer', ['clip'], true),
  ).rejects.toMatchObject({ httpStatus: 400 });
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
