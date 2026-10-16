import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Listing, ListingImage } from '@mercaria/shared-types';
import { useReplaceVariantImages } from '../use-products';
import { queryKeys } from '../../queryKeys';

// Capture production mutation options; all cache operations below are real.
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useMutation: vi.fn(() => ({})),
  useQueryClient: vi.fn(),
}));
vi.mock('../../api/products', () => ({}));
const clients: QueryClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.clearAllMocks();
});

it.each([false, true])(
  'a saved image selection defeats pending older reads (clear=%s)',
  async (clear) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const gallery = [
      { fileId: 'gallery-file', position: 0 },
      { fileId: 'selected-file', position: 1 },
    ];
    const images: ListingImage[] = clear ? [] : [{ fileId: 'selected-file', position: 0 }];
    const product = {
      id: 'product',
      images: gallery,
      variants: [
        { id: 'variant', images: { source: 'listing_fallback', images: gallery } },
        { id: 'other', images: { source: 'listing_fallback', images: gallery } },
      ],
    } as unknown as Listing;
    const imageKey = queryKeys.products.images('store-a', 'product', 'variant');
    const detailKey = queryKeys.products.detail('store-a', 'product');
    const otherStoreKey = queryKeys.products.images('store-b', 'product', 'variant');
    client.setQueryData(imageKey, gallery);
    client.setQueryData(detailKey, product);
    client.setQueryData(otherStoreKey, gallery);
    let releaseImages!: (images: ListingImage[]) => void;
    let releaseProduct!: (product: Listing) => void;
    const oldImageRead = client
      .fetchQuery({
        queryKey: imageKey,
        queryFn: () =>
          new Promise<ListingImage[]>((resolve) => {
            releaseImages = resolve;
          }),
      })
      .catch(() => undefined);
    const oldProductRead = client
      .fetchQuery({
        queryKey: detailKey,
        queryFn: () =>
          new Promise<Listing>((resolve) => {
            releaseProduct = resolve;
          }),
      })
      .catch(() => undefined);
    expect(client.isFetching()).toBe(2);
    vi.mocked(useQueryClient).mockReturnValue(client);
    useReplaceVariantImages('store-a', 'product', 'variant');
    const options = vi.mocked(useMutation).mock.calls.at(-1)![0] as {
      onSuccess: (images: ListingImage[]) => Promise<void>;
    };
    await options.onSuccess(images);
    releaseImages(gallery);
    releaseProduct(product);
    await Promise.all([oldImageRead, oldProductRead]);
    expect(client.getQueryData(imageKey)).toEqual(images);
    const saved = client.getQueryData<Listing>(detailKey)!;
    expect(saved.variants[0].images).toEqual(
      clear ? { source: 'listing_fallback', images: gallery } : { source: 'variant', images },
    );
    expect(saved.variants[1]).toEqual(product.variants[1]);
    expect(client.getQueryData(otherStoreKey)).toEqual(gallery);
  },
);
