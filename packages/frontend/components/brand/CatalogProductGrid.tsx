import { View } from "react-native";
import { useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import type { CatalogProductBrowsePage } from "@mercaria/shared-types";
import { Button, CanonicalProductCard, Skeleton, Text } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

/**
 * The product grid a brand or a family page renders (#72 product-browse rules).
 *
 * ONE grid for both pages — same card, same empty states, same "load more" —
 * because a brand page and a family page differ only in which products they
 * select. Two grids would be two places for the empty states to drift.
 *
 * ## Three empty states, and they say different things
 *
 * A page with no products at all, a page whose OFFER half was withdrawn, and a
 * page whose filters excluded everything are three different facts, and a
 * shopper's next action differs for each: wait, retry later, widen the filters.
 * Collapsing them into "nothing here" is exactly the confusion #72 brand rule
 * 10 asks the page to avoid.
 */

/** Loading-grid placeholder count — one screenful, so the layout does not jump. */
const SKELETON_TILE_COUNT = 8;

export interface CatalogProductGridProps {
  pages: readonly CatalogProductBrowsePage[] | undefined;
  isLoading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  /** Whether any filter is applied — what makes an empty grid explicable. */
  filtered: boolean;
}

export function CatalogProductGrid({
  pages,
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  filtered,
}: CatalogProductGridProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { oxyServices } = useOxy();

  const products = (pages ?? []).flatMap((page) => page.products);
  // The page-level state, taken from the FIRST page: every page of one browse
  // is computed under the same lever, so a later page cannot disagree.
  const offersIncluded = pages?.[0]?.offerContext !== "withdrawn";

  if (isLoading) {
    return (
      <View className="flex-row flex-wrap gap-4">
        {Array.from({ length: SKELETON_TILE_COUNT }).map((_, index) => (
          <Skeleton key={index} className="h-56 w-40 rounded-[20px]" />
        ))}
      </View>
    );
  }

  if (products.length === 0) {
    return (
      <Text className="text-sm text-muted-foreground">
        {filtered
          ? t("brands.grid.emptyFiltered")
          : offersIncluded
            ? t("brands.grid.empty")
            : t("brands.grid.emptyPricesWithdrawn")}
      </Text>
    );
  }

  return (
    <View className="flex flex-col gap-4">
      <View className="flex-row flex-wrap gap-4">
        {products.map((product) => (
          <View key={product.canonicalProductId} className="w-40">
            <CanonicalProductCard
              product={product}
              offersIncluded={offersIncluded}
              resolveImage={(fileId) => {
                const url = oxyServices.getFileDownloadUrl(fileId, "thumb");
                return url && url.startsWith("http") ? url : undefined;
              }}
              onPress={(canonicalProductId) =>
                router.push(`/products/${canonicalProductId}`)
              }
            />
          </View>
        ))}
      </View>
      {hasNextPage ? (
        <Button variant="outline" onPress={onLoadMore} disabled={isFetchingNextPage}>
          <Text>
            {isFetchingNextPage ? t("brands.grid.loadingMore") : t("brands.grid.showMore")}
          </Text>
        </Button>
      ) : null}
    </View>
  );
}
