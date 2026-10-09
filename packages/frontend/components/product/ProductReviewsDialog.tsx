import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View, type TextInput } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { Dialog } from "@oxy.so/bloom/dialog";
import { Button } from "@oxy.so/bloom/button";
import { Search } from "@oxy.so/bloom/search";
import { REVIEW_SEARCH_MAX_LENGTH } from "@mercaria/shared-types";
import { ReviewCard, ReviewSummaryCard, Text, useFormatters } from "@mercaria/ui";
import {
  useInfiniteProductReviews,
  REVIEW_SCOPE_HEADING_KEYS,
} from "@/lib/hooks/use-reviews";
import { useTranslation } from "@/lib/i18n";

/** Mounted only when opened, so selection and search reset for each product. */
export function ProductReviewsDialog({
  listingId,
  canonicalProductId,
  scope,
  initialReviewId,
  onClose,
}: {
  listingId: string;
  canonicalProductId?: string;
  scope: "product" | "p2p_listing";
  /** A card from the first-page preview to reveal when the sheet opens. */
  initialReviewId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [searchText, setSearchText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const searchInput = useRef<TextInput>(null);
  const { formatReviewCount } = useFormatters();
  const scroll = useRef<ScrollView>(null);
  const positioned = useRef(false);
  const [reviewLayout, setReviewLayout] = useState<{ y: number; height: number }>();
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const reducedMotion = useReducedMotion();
  const query = useInfiniteProductReviews(
    scope,
    scope === "product" ? canonicalProductId ?? "" : listingId,
    searchQuery,
  );
  const title = t(REVIEW_SCOPE_HEADING_KEYS[scope]);
  const firstPage = query.data?.pages[0];
  const pagination = firstPage?.pagination;
  const summary = firstPage?.ratingSummary;
  const reviews = query.data?.pages.flatMap((page) => page.data) ?? [];
  // Offset pagination may overlap if a new review is published mid-scroll.
  const uniqueReviews = [...new Map(reviews.map((review) => [review.id, review])).values()];
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = query;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetching && !isFetchNextPageError) void fetchNextPage({ cancelRefetch: false });
  }, [hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);
  useEffect(() => {
    if (contentHeight > 0 && viewportHeight > 0 && contentHeight <= viewportHeight) loadMore();
  }, [contentHeight, viewportHeight, loadMore]);
  const submitSearch = (text: string) => {
    setSearchQuery(text.trim());
    positioned.current = true;
    scroll.current?.scrollTo({ y: 0, animated: false });
  };
  useEffect(() => {
    if (!reviewLayout || !viewportHeight || !contentHeight || positioned.current) return;
    // Wait for the measured content and viewport on both native and web.
    // Only position the initial selection; pagination and user scrolling keep
    // their own position afterwards.
    const frame = requestAnimationFrame(() => {
      // Shop reveals a selected review in the centre of its scroll viewport.
      const y = Math.max(0, reviewLayout.y + reviewLayout.height / 2 - viewportHeight / 2);
      scroll.current?.scrollTo({ y, animated: !reducedMotion });
      positioned.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [reviewLayout, viewportHeight, contentHeight, reducedMotion]);
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
      scrollable={false}
      contentPadding={0}
    >
      <ScrollView
        ref={scroll}
        testID="product-reviews-scroll"
        className="min-h-0 flex-1"
        onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
        onContentSizeChange={(_, height) => setContentHeight(height)}
        scrollEventThrottle={100}
        onScroll={({ nativeEvent }) => {
          if (nativeEvent.contentSize.height - nativeEvent.contentOffset.y - nativeEvent.layoutMeasurement.height < 240) loadMore();
        }}
      >
        <View className="gap-space-8 p-space-20">
          {summary ? (
            <View className="mb-space-16">
              <ReviewSummaryCard
                embedded
                showHeading={false}
                scopeLabel={title}
                average={summary.rating}
                total={summary.reviewCount}
                distribution={summary.distribution}
                verifiedOnly={summary.verifiedOnly}
                unverified={firstPage?.aggregate?.unverified}
                reviews={[]}
                isLoading={false}
              />
            </View>
          ) : null}
          <View className="mb-space-8">
            <Search
              ref={searchInput}
              label={t("reviews.search.placeholder")}
              value={searchText}
              onChangeText={setSearchText}
              maxLength={REVIEW_SEARCH_MAX_LENGTH}
              onSubmitEditing={() => {
                submitSearch(searchText);
                searchInput.current?.blur();
              }}
              onClearText={() => {
                setSearchText("");
                submitSearch("");
                searchInput.current?.focus();
              }}
              onKeyPress={(event) => {
                if (event.nativeEvent.key === "Escape") {
                  event.stopPropagation();
                  event.preventDefault();
                }
              }}
            />
          </View>
          {searchQuery && pagination && !query.isLoading ? (
            <Text accessibilityLiveRegion="polite" className="text-shop-bodySmall text-text">
              {t("reviews.search.results", { results: formatReviewCount(pagination.total) })}
            </Text>
          ) : null}
          {query.isLoading ? (
            <Text className="text-shop-bodySmall text-text-tertiary">
              {t("common.loading")}
            </Text>
          ) : null}
          {query.isError && !query.isFetchNextPageError ? (
            <Button onPress={() => void query.refetch()}>
              {t("common.tryAgain")}
            </Button>
          ) : null}
          {!query.isLoading && !query.isError && uniqueReviews.length === 0 ? (
            <Text className="text-shop-bodySmall text-text-tertiary">
              {t(searchQuery ? "reviews.search.noResults" : "store.reviews.none")}
            </Text>
          ) : null}
          {uniqueReviews.map((review) => (
            <View key={review.id} onLayout={review.id === initialReviewId
              ? (event) => {
                  const { y, height } = event.nativeEvent.layout;
                  setReviewLayout({ y, height });
                }
              : undefined}>
              <ReviewCard review={review} scopeLabel={title} expanded />
            </View>
          ))}
          {query.isFetchingNextPage ? (
            <Text accessibilityLiveRegion="polite" className="text-center text-shop-caption text-text-tertiary">
              {t("common.loading")}
            </Text>
          ) : null}
          {query.isFetchNextPageError ? (
            <Button onPress={() => void query.fetchNextPage()}>
              {t("common.tryAgain")}
            </Button>
          ) : null}
        </View>
      </ScrollView>
    </Dialog>
  );
}
