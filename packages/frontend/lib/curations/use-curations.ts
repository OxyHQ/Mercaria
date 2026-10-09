import type { ProductSummary } from "@mercaria/shared-types";
import { useFeed } from "@/lib/hooks/use-feed";

/** Local editorial fixtures while the publishing source is not connected. */
const PREVIEW_EDITIONS = __DEV__
  ? [
      { slug: "everyday-finds", titleKey: "curations.everyday", offset: 0 },
      { slug: "fresh-perspectives", titleKey: "curations.fresh", offset: 3 },
      { slug: "little-pleasures", titleKey: "curations.pleasures", offset: 6 },
    ]
  : [];

export interface Curation {
  slug: string;
  titleKey: string;
  imageUrl?: string;
  products: ProductSummary[];
}

export function useCurations() {
  const feed = useFeed();
  const products = (feed.data?.sections ?? [])
    .flatMap((section) => (section.kind === "products" ? section.products : []))
    .filter(
      (product, index, all) =>
        all.findIndex((item) => item.id === product.id) === index,
    );
  const stores = (feed.data?.sections ?? []).flatMap((section) =>
    section.kind === "merchants" ? section.merchants : [],
  );
  const curations: Curation[] = products.length
    ? PREVIEW_EDITIONS.map((edition, index) => {
        const selection = [
          ...products.slice(edition.offset),
          ...products.slice(0, edition.offset),
        ];
        return {
          ...edition,
          imageUrl: stores[index]?.coverImageUrl ?? selection[0]?.imageUrl,
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
