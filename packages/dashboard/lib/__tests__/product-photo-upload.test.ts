import { beforeEach, expect, it, vi } from 'vitest';
import {
  uploadProductPhoto,
  validProductPhoto,
  PRODUCT_PHOTO_MAX_BYTES,
  uploadProductMedia,
  validProductMedia,
  PRODUCT_VIDEO_MAX_BYTES,
} from '../product-photo-upload';
import apiClient from '../api/client';
vi.mock('../api/client', () => ({ default: { post: vi.fn() } }));
beforeEach(() => vi.mocked(apiClient.post).mockReset());
it('accepts bounded image bytes and rejects unsupported/invalid sizes', () => {
  expect(validProductPhoto('image/png', 1)).toBe(true);
  expect(validProductPhoto('image/jpeg', PRODUCT_PHOTO_MAX_BYTES)).toBe(true);
  for (const size of [0, -1, NaN, Infinity, 1.2, PRODUCT_PHOTO_MAX_BYTES + 1])
    expect(validProductPhoto('image/png', size)).toBe(false);
  expect(validProductPhoto('image/svg+xml', 100)).toBe(false);
});
it('sends bytes and MIME through the existing client without a client-controlled owner', async () => {
  vi.mocked(apiClient.post).mockResolvedValue({
    data: { success: true, data: { fileId: 'oxy-photo-id' } },
  });
  const bytes = new Blob(['image bytes'], { type: 'image/png' });
  const signal = new AbortController().signal;
  expect(await uploadProductPhoto('store-one', bytes, vi.fn(), signal)).toBe('oxy-photo-id');
  expect(apiClient.post).toHaveBeenCalledWith(
    '/admin/stores/store-one/products/media',
    bytes,
    expect.objectContaining({ signal, headers: { 'Content-Type': 'image/png' } }),
  );
});
it('does not convert failed uploads or malformed metadata into success', async () => {
  const bytes = new Blob(['image bytes'], { type: 'image/png' });
  const signal = new AbortController().signal;
  vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('network failure'));
  await expect(uploadProductPhoto('store-one', bytes, vi.fn(), signal)).rejects.toThrow(
    'network failure',
  );
  for (const fileId of ['https://external.test/photo.jpg', '', undefined]) {
    vi.mocked(apiClient.post).mockResolvedValueOnce({ data: { success: true, data: { fileId } } });
    await expect(uploadProductPhoto('store-one', bytes, vi.fn(), signal)).rejects.toThrow(
      'Invalid uploaded',
    );
  }
});

it('validates image and MP4 limits independently and checks returned media kind', async () => {
  expect(validProductMedia('video/mp4', PRODUCT_VIDEO_MAX_BYTES)).toBe(true);
  expect(validProductMedia('image/png', PRODUCT_PHOTO_MAX_BYTES + 1)).toBe(false);
  expect(validProductMedia('video/mp4', PRODUCT_VIDEO_MAX_BYTES + 1)).toBe(false);
  expect(validProductMedia('video/webm', 50)).toBe(false);
  const bytes = new Blob(['isolated bytes'], { type: 'video/mp4' });
  const signal = new AbortController().signal;
  vi.mocked(apiClient.post).mockResolvedValueOnce({
    data: { success: true, data: { fileId: 'video-id', kind: 'image' } },
  });
  await expect(uploadProductMedia('store-one', bytes, vi.fn(), signal)).rejects.toThrow(/metadata/);
  vi.mocked(apiClient.post).mockResolvedValueOnce({
    data: { success: true, data: { fileId: 'video-id', kind: 'video' } },
  });
  expect(await uploadProductMedia('store-one', bytes, vi.fn(), signal)).toEqual({
    fileId: 'video-id',
    kind: 'video',
    position: 0,
  });
});
