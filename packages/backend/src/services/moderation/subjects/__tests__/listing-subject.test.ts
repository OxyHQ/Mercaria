/**
 * A listing's gallery reaches a jury as `image` attachments pinned by the
 * digest Oxy holds (`oxyClient.assets.metadataByIds`, one call), never a
 * Mercaria URL. A file Oxy no longer has is declared by id with the reason; a
 * metadata read that fails throws, so the delivery retries instead of sending
 * a snapshot without the images that were reported.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const LISTING_ID = '01900000-0000-7000-8000-000000000001';

const sdk = vi.hoisted(() => ({
  metadataByIds: vi.fn(),
  findListingById: vi.fn(),
  findListingChildren: vi.fn(),
}));
vi.mock('../../../../middleware/auth.js', () => ({
  oxyClient: { assets: { metadataByIds: sdk.metadataByIds } },
}));
vi.mock('../../../../db/catalog/listingRepository.js', () => ({
  findListingById: sdk.findListingById,
  findListingChildren: sdk.findListingChildren,
}));
vi.mock('../../../../db/stores/storeRepository.js', () => ({ findStoreById: vi.fn() }));
vi.mock('../../../../config/index.js', () => ({
  config: { web: { origin: 'https://mercaria.test' } },
}));

const { createListingSubjectProvider } = await import('../listing-subject.js');

const asset = (id: string) => ({
  id,
  sha256: `${id}-digest`,
  mime: 'image/jpeg',
  size: 1234,
  status: 'active',
  width: 800,
  height: 600,
});

beforeEach(() => {
  vi.clearAllMocks();
  sdk.findListingById.mockResolvedValue({
    id: LISTING_ID,
    title: 'Vintage lamp',
    description: 'Works',
    ownerType: 'user',
    oxyUserId: 'seller',
    storeId: null,
    condition: 'used_good',
    priceRangeMinAmount: null,
    priceRangeMaxAmount: null,
    priceRangeMinCurrency: null,
    vendor: null,
    productType: null,
    categorySlugs: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  sdk.findListingChildren.mockResolvedValue({
    images: new Map([
      [
        LISTING_ID,
        [
          { fileId: 'second', position: 1 },
          { fileId: 'first', position: 0 },
          { fileId: 'deleted', position: 2 },
        ],
      ],
    ]),
  });
});

describe('the listing snapshot', () => {
  it('attaches the gallery in buyer order, pinned by Oxy digests, from one metadata call', async () => {
    sdk.metadataByIds.mockResolvedValue([asset('second'), asset('first')]);
    const snapshot = await createListingSubjectProvider().snapshot(LISTING_ID);

    expect(sdk.metadataByIds).toHaveBeenCalledExactlyOnceWith(['first', 'second', 'deleted']);
    expect(snapshot?.attachments).toEqual([
      {
        type: 'image',
        asset: {
          fileId: 'first',
          mimeType: 'image/jpeg',
          sha256: 'first-digest',
          sizeBytes: 1234,
          width: 800,
          height: 600,
        },
      },
      {
        type: 'image',
        asset: {
          fileId: 'second',
          mimeType: 'image/jpeg',
          sha256: 'second-digest',
          sizeBytes: 1234,
          width: 800,
          height: 600,
        },
      },
    ]);
    // A file Oxy does not have is declared, never given an invented digest.
    expect(snapshot?.context).toContainEqual({
      role: 'evidence',
      type: 'metadata',
      data: {
        unavailableImageCount: 1,
        oxyFileIds: 'deleted',
        evidenceUnavailableReason: 'asset_not_found',
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('mercaria.test/media');
  });

  it('throws when Oxy cannot be asked, so the delivery is retried', async () => {
    sdk.metadataByIds.mockRejectedValue(new Error('chunk failed'));
    await expect(createListingSubjectProvider().snapshot(LISTING_ID)).rejects.toThrow(
      'chunk failed',
    );
  });
});
