import type { ProductSummary } from '@mercaria/shared-types';
import { useFeed } from '@/lib/hooks/use-feed';

/** Local editorial fixtures while the publishing source is not connected. */
const PREVIEW_EDITIONS = __DEV__
  ? [
      {
        slug: 'courtney-grow',
        titleKey: 'curations.referenceTitle',
        offset: 0,
      },
      { slug: 'everyday-finds', titleKey: 'curations.everyday', offset: 0 },
      { slug: 'fresh-perspectives', titleKey: 'curations.fresh', offset: 3 },
      { slug: 'little-pleasures', titleKey: 'curations.pleasures', offset: 6 },
    ]
  : [];

export interface Curation {
  slug: string;
  titleKey: string;
  imageUrl?: string;
  mobileImageUrl?: string;
  referenceId?: string;
  galleryImages?: string[];
  products: ProductSummary[];
}

// Reference artwork is confined to the explicitly labelled development preview.
const REFERENCE_ASSETS =
  'https://shopify-assets.shopifycdn.com/shopifycloud/shop-client/production/cf9d9d7016b8f725038552fc89127b79b7b014d7/assets/';

export function useCurations() {
  const feed = useFeed();
  const products = (feed.data?.sections ?? [])
    .flatMap((section) => (section.kind === 'products' ? section.products : []))
    .filter((product, index, all) => all.findIndex((item) => item.id === product.id) === index);
  const stores = (feed.data?.sections ?? []).flatMap((section) =>
    section.kind === 'merchants' ? section.merchants : [],
  );
  const curations: Curation[] = products.length
    ? PREVIEW_EDITIONS.map((edition, index) => {
        const selection = [...products.slice(edition.offset), ...products.slice(0, edition.offset)];
        return {
          ...edition,
          imageUrl:
            edition.slug === 'courtney-grow'
              ? `${REFERENCE_ASSETS}hero-desktop-1140-BT8eayNN.webp`
              : (stores[index - 1]?.coverImageUrl ?? selection[0]?.imageUrl),
          ...(edition.slug === 'courtney-grow'
            ? {
                referenceId: '01a0e9b7-5414-7e69-a529-85a3f6c3dc47',
                mobileImageUrl: `${REFERENCE_ASSETS}hero-mobile-768-D0gIgmbU.webp`,
                galleryImages: [
                  'look-1-565-BIMPr21y.webp',
                  'look-2-565-BK3EKNIv.webp',
                  'look-3-565-YaMlqT5s.webp',
                ].map((file) => REFERENCE_ASSETS + file),
              }
            : {}),
          products: selection,
        };
      })
    : [];
  return {
    curations,
    isLoading: feed.isLoading,
    isError: feed.isError,
    refetch: feed.refetch,
  };
}
