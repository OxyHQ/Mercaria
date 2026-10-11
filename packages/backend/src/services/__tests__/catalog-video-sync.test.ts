import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ enabled: true, download: vi.fn(), upload: vi.fn() }));
vi.mock('../../config/index.js', () => ({
  config: {
    catalog: {
      get videoWritesEnabled() {
        return state.enabled;
      },
    },
  },
}));
vi.mock('@oxy.so/core/server', () => ({
  safeFetch: (...args: unknown[]) => state.download(...args),
}));
vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoreById: async () => ({ oxyAccountId: 'persisted-owner' }),
}));
vi.mock('../../capabilities/oxy-service-client.js', () => ({
  oxyServiceClient: () => ({
    baseURL: 'https://oxy.test',
    serviceToken: async () => 'isolated-token',
  }),
}));
import { synchronizeStoreMedia } from '../catalog-media/sync.js';
import { matchesProductVideo, PRODUCT_VIDEO_MAX_BYTES } from '../catalog-media/policy.js';
const mp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
beforeEach(() => {
  state.enabled = true;
  state.upload.mockReset();
  state.download.mockReset();
  state.download.mockImplementation(async () => ({
    status: 200,
    headers: { 'content-type': 'video/mp4' },
    response: Readable.from([mp4]),
  }));
  state.upload.mockImplementation(async () =>
    Response.json({
      data: {
        file: { id: 'oxy-video', visibility: 'public', mime: 'video/mp4', size: mp4.length },
      },
    }),
  );
  vi.stubGlobal('fetch', state.upload);
});
afterEach(() => vi.unstubAllGlobals());
it('imports verified MP4 bytes under the persisted store owner and returns typed IDs only', async () => {
  const result = await synchronizeStoreMedia('store', [
    { kind: 'video', reference: 'https://supplier.test/clip.mp4' },
  ]);
  expect(result).toEqual([{ kind: 'video', fileId: 'oxy-video', position: 0 }]);
  expect(state.upload.mock.calls[0][1].headers['x-owner-user-id']).toBe('persisted-owner');
  expect(Buffer.from(state.upload.mock.calls[0][1].body)).toEqual(mp4);
});
it('refuses disabled video imports and unverified existing video IDs before network operations', async () => {
  state.enabled = false;
  await expect(
    synchronizeStoreMedia('store', [{ kind: 'video', reference: 'https://supplier.test/a.mp4' }]),
  ).rejects.toThrow(/not enabled/);
  state.enabled = true;
  await expect(
    synchronizeStoreMedia('store', [{ kind: 'video', reference: 'unverified-id' }]),
  ).rejects.toThrow(/verification/);
  expect(state.download).not.toHaveBeenCalled();
  expect(state.upload).not.toHaveBeenCalled();
});
it('does not treat a video as an image or an image as a video', async () => {
  await expect(
    synchronizeStoreMedia('store', [{ kind: 'image', reference: 'https://supplier.test/a.mp4' }]),
  ).rejects.toThrow();
  state.download.mockImplementation(async () => ({
    status: 200,
    headers: { 'content-type': 'video/mp4' },
    response: Readable.from([Buffer.from('not mp4')]),
  }));
  await expect(
    synchronizeStoreMedia('store', [{ kind: 'video', reference: 'https://supplier.test/a.mp4' }]),
  ).rejects.toThrow(/MP4/);
  expect(state.upload).not.toHaveBeenCalled();
});
it('rejects Oxy metadata mismatch, failed imports and excessive sizes without publishing a gallery', async () => {
  state.upload.mockResolvedValueOnce(
    Response.json({
      data: {
        file: { id: 'oxy-photo', visibility: 'public', mime: 'image/png', size: mp4.length },
      },
    }),
  );
  await expect(
    synchronizeStoreMedia('store', [{ kind: 'video', reference: 'https://supplier.test/a.mp4' }]),
  ).rejects.toThrow(/metadata/);
  state.download.mockImplementation(async () => ({
    status: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(PRODUCT_VIDEO_MAX_BYTES + 1) },
    response: Readable.from([mp4]),
  }));
  await expect(
    synchronizeStoreMedia('store', [{ kind: 'video', reference: 'https://supplier.test/a.mp4' }]),
  ).rejects.toThrow(/size/);
});
it('MP4 validation excludes AVIF and truncated file type boxes', () => {
  expect(matchesProductVideo(mp4, 'video/mp4')).toBe(true);
  expect(
    matchesProductVideo(
      Buffer.from('00000018667479706176696600000000617669666d696631', 'hex'),
      'video/mp4',
    ),
  ).toBe(false);
  expect(matchesProductVideo(mp4.subarray(0, 16), 'video/mp4')).toBe(false);
});
