/** Isolated Oxy transport tests. These prove author/visibility validation and
 * failure handling, never that these fixture IDs exist in live Oxy storage. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OxyApiError } from '@oxy.so/core';
import { REVIEW_IMAGE_MAX_BYTES, REVIEW_VIDEO_MAX_BYTES } from '@mercaria/shared-types';

const { get, link, setAccessToken, clients } = vi.hoisted(() => ({
  get: vi.fn(),
  link: vi.fn(),
  setAccessToken: vi.fn(),
  clients: vi.fn(),
}));
vi.mock('@oxy.so/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core')>()),
  OxyServices: class {
    assets = { get, link };
    session = { setAccessToken };
    constructor(options: unknown) {
      clients(options);
    }
  },
}));
import { prepareReviewMedia } from '../review-media.service.js';

const author = {
  accountId: 'review-author',
  actorAccountId: 'review-author',
  delegated: false,
  accessToken: 'test-only-bearer',
};
const metadata = (id: string, overrides: Record<string, unknown> = {}) => ({
  assetId: id,
  file: {
    id,
    ownerUserId: author.accountId,
    status: 'active',
    visibility: 'public',
    mime: 'image/jpeg',
    size: 100,
    ...overrides,
  },
});

beforeEach(() => {
  vi.resetAllMocks();
  get.mockImplementation(async (id) => metadata(id));
  link.mockResolvedValue({});
});

describe('review attachment ownership and persistence', () => {
  it('makes no Oxy requests for text-only reviews', async () => {
    expect(await prepareReviewMedia(author, 'native_transaction')).toEqual([]);
    expect(clients).not.toHaveBeenCalled();
  });

  it('uses the author bearer and metadata kind, preserves order, and makes no link from the session', async () => {
    get.mockImplementation(async (id) => metadata(id, id === 'clip' ? { mime: 'video/mp4' } : {}));
    expect(await prepareReviewMedia(author, 'product', ['photo', 'clip'])).toEqual([
      { fileId: 'photo', kind: 'image' },
      { fileId: 'clip', kind: 'video' },
    ]);
    expect(clients).toHaveBeenCalledTimes(1);
    expect(setAccessToken).toHaveBeenCalledExactlyOnceWith(author.accessToken);
    // The use is registered by the reference outbox after the review commits
    // (`review_media` rows, Oxy ADR 0043 D4) with Mercaria's service token —
    // never from the author's session, and never before the write.
    expect(link).not.toHaveBeenCalled();
  });

  it.each([
    ['native_transaction', ['photo']],
    ['product', ['https://supplier.example/photo.jpg']],
    ['product', ['same', 'same']],
    ['product', Array.from({ length: 11 }, (_, i) => `file-${i}`)],
  ] as const)('rejects invalid scope/IDs before reading any files (%s)', async (scope, ids) => {
    await expect(prepareReviewMedia(author, scope, ids)).rejects.toMatchObject({ httpStatus: 400 });
    expect(get).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
  });

  it.each([
    { ownerUserId: 'someone-else' },
    { visibility: 'private' },
    { status: 'trash' },
    { status: 'deleted' },
    { id: 'different-file' },
  ])('rejects unavailable metadata without linking any earlier file: %j', async (invalid) => {
    get.mockImplementation(async (id) => metadata(id, id === 'second' ? invalid : {}));
    await expect(prepareReviewMedia(author, 'product', ['first', 'second'])).rejects.toMatchObject({
      httpStatus: 403,
    });
    expect(link).not.toHaveBeenCalled();
  });

  it.each([
    { mime: 'image/svg+xml' },
    { mime: 'application/pdf' },
    { size: 0 },
    { size: -1 },
    { size: 1.5 },
    { size: Number.MAX_SAFE_INTEGER + 1 },
    { size: REVIEW_IMAGE_MAX_BYTES + 1 },
    { mime: 'video/mp4', size: REVIEW_VIDEO_MAX_BYTES + 1 },
  ])('rejects unsupported or oversized uploads: %j', async (invalid) => {
    get.mockResolvedValue(metadata('photo', invalid));
    await expect(prepareReviewMedia(author, 'product', ['photo'])).rejects.toMatchObject({
      httpStatus: 400,
    });
    expect(link).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 429, 500])(
    'maps Oxy metadata failure %s without exposing provider details',
    async (status) => {
      get.mockRejectedValue(
        new OxyApiError('private upstream diagnostic', { status, code: 'TEST' }),
      );
      await expect(prepareReviewMedia(author, 'product', ['photo'])).rejects.toMatchObject({
        httpStatus: status < 429 ? 403 : 503,
      });
      expect(link).not.toHaveBeenCalled();
    },
  );
});
