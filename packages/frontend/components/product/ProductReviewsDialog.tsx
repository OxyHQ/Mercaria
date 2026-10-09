import { useState } from "react";
import { View } from "react-native";
import { Dialog } from "@oxy.so/bloom/dialog";
import { Button } from "@oxy.so/bloom/button";
import { ReviewCard, Text } from "@mercaria/ui";
import { useProductReviews } from "@/lib/hooks/use-product";
import {
  useProductScopeReviews,
  REVIEW_SCOPE_HEADING_KEYS,
} from "@/lib/hooks/use-reviews";
import { useTranslation } from "@/lib/i18n";

/** Mounted only when opened, so pagination resets for each scope/product. */
export function ProductReviewsDialog({
  listingId,
  canonicalProductId,
  scope,
  onClose,
}: {
  listingId: string;
  canonicalProductId?: string;
  scope: "product" | "p2p_listing";
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const product = useProductScopeReviews(
    scope === "product" ? canonicalProductId : undefined,
    page,
    12,
  );
  const listing = useProductReviews(
    scope === "p2p_listing" ? listingId : "",
    page,
    12,
  );
  const query = scope === "product" ? product : listing;
  const title = t(REVIEW_SCOPE_HEADING_KEYS[scope]);
  const pagination = query.data?.pagination;
  return (
    <Dialog
      open
      onClose={onClose}
      header={{ title, largeTitle: false }}
      placement={{ base: "bottom", md: "end" }}
      width={560}
      maxHeightRatio={0.94}
      label={title}
      testID="product-reviews-dialog"
    >
      <View className="gap-space-16">
        {query.isLoading ? (
          <Text className="text-shop-bodySmall text-text-tertiary">
            {t("common.loading")}
          </Text>
        ) : null}
        {query.isError ? (
          <Button onPress={() => void query.refetch()}>
            {t("common.tryAgain")}
          </Button>
        ) : null}
        {!query.isLoading && !query.isError && query.data?.data.length === 0 ? (
          <Text className="text-shop-bodySmall text-text-tertiary">
            {t("store.reviews.none")}
          </Text>
        ) : null}
        {query.data?.data.map((review) => (
          <ReviewCard
            key={review.id}
            review={review}
            scopeLabel={title}
            expanded
          />
        ))}
        {pagination && pagination.pages > 1 ? (
          <View className="gap-space-12">
            <Text className="text-center text-shop-caption text-text-tertiary">
              {t("common.pagination.pageOf", { page, pages: pagination.pages })}
            </Text>
            <View className="flex-row justify-between gap-space-8">
              <Button
                disabled={!pagination.hasPreviousPage || query.isFetching}
                onPress={() => setPage((value) => value - 1)}
              >
                {t("common.pagination.previous")}
              </Button>
              <Button
                disabled={!pagination.hasNextPage || query.isFetching}
                onPress={() => setPage((value) => value + 1)}
              >
                {t("common.pagination.next")}
              </Button>
            </View>
          </View>
        ) : null}
      </View>
    </Dialog>
  );
}
