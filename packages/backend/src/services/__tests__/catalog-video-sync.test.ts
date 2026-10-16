import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ enabled: true, importUserMedia: vi.fn() }));
vi.mock('../../config/index.js', () => ({
  config: {
    catalog: {
      get videoWritesEnabled() {
        return state.enabled;
      },
    },
  },
}));
vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoreById: async () => ({ oxyAccountId: 'persisted-owner' }),
}));
vi.mock('../../capabilities/oxy-service-client.js', () => ({
  oxyServiceClient: () => ({
    assets: { importUserMedia: (...args: unknown[]) => state.importUserMedia(...args) },
  }),
}));
import { synchronizeStoreMedia } from '../catalog-media/sync.js';
import { matchesProductVideo, PRODUCT_VIDEO_MAX_BYTES } from '../catalog-media/policy.js';
const mp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');

/** Oxy's answer to an import by URL: what it MEASURED, which is what decides the kind. */
function imported(file: Record<string, unknown>) {
  return {
    file: { id: 'oxy-video', visibility: 'public', status: 'active', ...file },
    outcome: 'downloaded',
    deduplicated: false,
  };
}

beforeEach(() => {
  state.enabled = true;
  state.importUserMedia
    .mockReset()
    .mockImplementation(async () => imported({ mime: 'video/mp4', size: mp4.length }));
});
it('imports a video under the persisted store owner and returns typed IDs only', async () => {
  const result = await synchronizeStoreMedia('store', [
    { kind: 'video', reference: 'https://supplier.test/clip.mp4' },
  ]);
  expect(result).toEqual([{ kind: 'video', fileId: 'oxy-video', position: 0 }]);
  expect(state.importUserMedia.mock.calls[0][0]).toBe('persisted-owner');
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
  expect(state.importUserMedia).not.toHaveBeenCalled();
});
it('does not treat a video as an image or an image as a video', async () => {
  // Declared an image; Oxy measured a video.
  await expect(
    synchronizeStoreMedia('store', [{ kind: 'image', reference: 'https://supplier.test/a.mp4' }]),
  ).rejects.toThrow(/image/);
  // Declared a video; Oxy measured an image.
  state.importUserMedia.mockResolvedValueOnce(imported({ mime: 'image/png', size: 10 }));
  await expect(
    synchronizeStoreMedia('store', [{ kind: 'video', reference: 'https://supplier.test/a.mp4' }]),
  ).rejects.toThrow(/MP4/);
});
it('rejects an oversized video and a failed import without publishing a gallery', async () => {
  state.importUserMedia.mockResolvedValueOnce(
    imported({ mime: 'video/mp4', size: PRODUCT_VIDEO_MAX_BYTES + 1 }),
  );
  await expect(
    synchronizeStoreMedia('store', [{ kind: 'video', reference: 'https://supplier.test/a.mp4' }]),
  ).rejects.toThrow(/MP4/);
  state.importUserMedia.mockRejectedValueOnce(
    Object.assign(new Error('HTTP 415'), { status: 415 }),
  );
  await expect(
    synchronizeStoreMedia('store', [
      { kind: 'image', reference: 'https://supplier.test/a.png' },
      { kind: 'video', reference: 'https://supplier.test/a.mp4' },
    ]),
  ).rejects.toThrow(/Oxy/);
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
