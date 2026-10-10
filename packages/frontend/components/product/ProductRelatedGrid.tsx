import { useWindowDimensions, View } from "react-native";
import { FeedGrid, ProductCard, SectionHeader, Text } from "@mercaria/ui";
import { Button } from "@oxy.so/bloom/button";
import type { Listing } from "@mercaria/shared-types";
import { useDiscoverySignalPage } from "@/lib/hooks/use-discovery-feed";
import { useTranslation } from "@/lib/i18n";
import { renderListingLink } from "@/lib/catalog/product-links";

/** Category discovery uses the backend's card projection, ratings and Oxy media. */
export function ProductRelatedGrid({ listing }: { listing: Listing }) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const query = useDiscoverySignalPage(
    { kind: "category", handle: listing.category },
    listing.category ? "new" : undefined,
  );
  const products = (query.data ?? []).flatMap(page => page.products)
    .filter(item => item.id !== listing.id);
  if (!listing.category || query.isPending || (!query.isError && products.length === 0 && !query.hasNextPage)) return null;
  return (
    <View testID="product-related-grid" className="px-space-16 py-space-24 md:px-0">
      <View className="mb-space-16 md:mb-space-24">
        <SectionHeader title={t("product.youMightAlsoLike")} inset={false} />
      </View>
      <FeedGrid
        items={products}
        keyExtractor={item => item.id}
        slotClassName=""
        rowGapClassName=""
        autoColumns={{ minWidth: width < 768 ? width : 220, gap: width < 768 ? 16 : 32, minimumColumns: width < 768 ? 2 : 1 }}
        renderItem={product => <ProductCard product={product} renderLink={renderListingLink} />}
      />
      {query.isError ? (
        <View className="items-center gap-space-12 py-space-16">
          <Text accessibilityRole="alert" className="text-shop-body text-text-tertiary">{t("discovery.signal.loadError")}</Text>
          <Button appearance="outline" tone="neutral" loading={query.isFetching} onPress={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())}>
            {t("common.tryAgain")}
          </Button>
        </View>
      ) : query.hasNextPage ? (
        <View className="items-center py-space-24">
          <Button appearance="outline" tone="neutral" loading={query.isFetchingNextPage} accessibilityLabel={t("discovery.signal.loadMoreLabel")} onPress={() => void query.fetchNextPage()}>
            {t("discovery.signal.loadMore")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
