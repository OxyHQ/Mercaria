import { useCallback, useEffect, useRef, useState } from 'react';
import { View, useWindowDimensions, type ScrollView, type TextInput } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useReducedMotion } from 'react-native-reanimated';
import { Button } from '@oxy.so/bloom/button';
import { Search } from '@oxy.so/bloom/search';
import { REVIEW_SEARCH_MAX_LENGTH, type ReviewSortOrder } from '@mercaria/shared-types';
import {
  ReviewCard,
  ReviewSummaryCard,
  Text,
  MarketplaceSheet,
  useColorScheme,
  useFormatters,
} from '@mercaria/ui';
import {
  useInfiniteProductReviews,
  useReviewHelpfulness,
  REVIEW_SCOPE_HEADING_KEYS,
} from '@/lib/hooks/use-reviews';
import { ReviewFilters } from './ReviewFilters';
import { ReviewActionsMenu } from '@/components/reports/ReviewActionsMenu';
import { ReviewHelpfulButton } from '@/components/reviews/ReviewHelpfulButton';
import { useTranslation } from '@/lib/i18n';

/** Shop's filled-circle dismiss glyph, used by Bloom's owned clear button. */
function ReviewSearchClearIcon({
  width = 24,
  height = 24,
}: {
  width?: number;
  height?: number;
  fill?: string;
}) {
  const { isDarkColorScheme } = useColorScheme();
  return (
    <Svg
      width={width}
      height={height}
      viewBox="0 0 24 24"
      fill="none"
      opacity={0.6}
      accessible={false}
    >
      <Path
        fillRule="evenodd"
        clipRule="evenodd"
        fill={isDarkColorScheme ? '#ffffff' : '#121212'}
        d="M2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12ZM9.70711 8.29289C9.31658 7.90237 8.68342 7.90237 8.29289 8.29289C7.90237 8.68342 7.90237 9.31658 8.29289 9.70711L10.5858 12L8.29289 14.2929C7.90237 14.6834 7.90237 15.3166 8.29289 15.7071C8.68342 16.0976 9.31658 16.0976 9.70711 15.7071L12 13.4142L14.2929 15.7071C14.6834 16.0976 15.3166 16.0976 15.7071 15.7071C16.0976 15.3166 16.0976 14.6834 15.7071 14.2929L13.4142 12L15.7071 9.70711C16.0976 9.31658 16.0976 8.68342 15.7071 8.29289C15.3166 7.90237 14.6834 7.90237 14.2929 8.29289L12 10.5858L9.70711 8.29289Z"
      />
    </Svg>
  );
}

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
  scope: 'product' | 'p2p_listing';
  /** A card from the first-page preview to reveal when the sheet opens. */
  initialReviewId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // Shop changes the search inset at 976px, before Tailwind's default lg.
  const { width } = useWindowDimensions();
  const [searchText, setSearchText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<ReviewSortOrder>('newest');
  const [ratings, setRatings] = useState<number[]>([]);
  const searchInput = useRef<TextInput>(null);
  const { formatReviewCount } = useFormatters();
  const scroll = useRef<ScrollView>(null);
  const positioned = useRef(false);
  const [reviewLayout, setReviewLayout] = useState<{ y: number; height: number }>();
  const [bodyOffset, setBodyOffset] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const reducedMotion = useReducedMotion();
  const query = useInfiniteProductReviews(
    scope,
    scope === 'product' ? (canonicalProductId ?? '') : listingId,
    { query: searchQuery, sortBy, ratings },
  );
  const title = t(REVIEW_SCOPE_HEADING_KEYS[scope]);
  const firstPage = query.data?.pages[0];
  const pagination = firstPage?.pagination;
  const summary = firstPage?.ratingSummary;
  const reviews = query.data?.pages.flatMap((page) => page.data) ?? [];
  // Offset pagination may overlap if a new review is published mid-scroll.
  const uniqueReviews = [...new Map(reviews.map((review) => [review.id, review])).values()];
  const helpfulness = useReviewHelpfulness(uniqueReviews.map((review) => review.id));
  const votes = new Map(helpfulness.data?.map((vote) => [vote.reviewId, vote]));
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = query;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetching && !isFetchNextPageError)
      void fetchNextPage({ cancelRefetch: false });
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
      const y = Math.max(
        0,
        bodyOffset + reviewLayout.y + reviewLayout.height / 2 - viewportHeight / 2,
      );
      scroll.current?.scrollTo({ y, animated: !reducedMotion });
      positioned.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [reviewLayout, bodyOffset, viewportHeight, contentHeight, reducedMotion]);
  return (
    <MarketplaceSheet
      open
      onClose={onClose}
      title={title}
      headingGap={12}
      testID="product-reviews-dialog"
      scrollRef={scroll}
      scrollViewProps={{
        testID: 'product-reviews-scroll',
        onLayout: (event) => setViewportHeight(event.nativeEvent.layout.height),
        onContentSizeChange: (_, height) => setContentHeight(height),
        onScroll: ({ nativeEvent }) => {
          if (
            nativeEvent.contentSize.height -
              nativeEvent.contentOffset.y -
              nativeEvent.layoutMeasurement.height <
            240
          )
            loadMore();
        },
      }}
    >
      <View className="gap-space-8" onLayout={(event) => setBodyOffset(event.nativeEvent.layout.y)}>
        {summary ? (
          <View>
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
        <View className="mb-space-8 md:mb-0">
          <View className="pt-space-16 pb-[14px]">
            <Search
              ref={searchInput}
              iconSize={24}
              clearButtonProps={{ size: 24, glyphSize: 24, icon: ReviewSearchClearIcon }}
              role="searchbox"
              fieldClassName={`h-[44px] ${width >= 976 ? 'px-[18px]' : 'px-space-16'}`}
              style={{ fontSize: 14, lineHeight: 20 }}
              fieldChromeClassName="rounded-radius-28 border border-border-image bg-transparent"
              label={t('reviews.search.placeholder')}
              value={searchText}
              onChangeText={setSearchText}
              maxLength={REVIEW_SEARCH_MAX_LENGTH}
              onSubmitEditing={() => {
                submitSearch(searchText);
                searchInput.current?.blur();
              }}
              onClearText={() => {
                setSearchText('');
                submitSearch('');
                searchInput.current?.focus();
              }}
              onKeyPress={(event) => {
                if (event.nativeEvent.key === 'Escape') {
                  event.stopPropagation();
                  event.preventDefault();
                }
              }}
            />
          </View>
          <ReviewFilters
            sortBy={sortBy}
            ratings={ratings}
            onSortChange={(value) => {
              positioned.current = true;
              scroll.current?.scrollTo({ y: 0, animated: false });
              setSortBy(value);
            }}
            onRatingsChange={(value) => {
              positioned.current = true;
              scroll.current?.scrollTo({ y: 0, animated: false });
              setRatings(value);
            }}
          />
        </View>
        {(searchQuery || ratings.length > 0) && pagination && !query.isLoading ? (
          <Text accessibilityLiveRegion="polite" className="text-shop-bodySmall text-text">
            {t(searchQuery ? 'reviews.search.results' : 'reviews.filters.results', {
              results: formatReviewCount(pagination.total),
            })}
          </Text>
        ) : null}
        {query.isLoading ? (
          <Text className="text-shop-bodySmall text-text-tertiary">{t('common.loading')}</Text>
        ) : null}
        {query.isError && !query.isFetchNextPageError ? (
          <Button onPress={() => void query.refetch()}>{t('common.tryAgain')}</Button>
        ) : null}
        {!query.isLoading && !query.isError && uniqueReviews.length === 0 ? (
          <Text className="text-shop-bodySmall text-text-tertiary">
            {t(
              searchQuery
                ? 'reviews.search.noResults'
                : ratings.length > 0
                  ? 'reviews.filters.noResults'
                  : 'store.reviews.none',
            )}
          </Text>
        ) : null}
        {helpfulness.isError ? (
          <Button onPress={() => void helpfulness.refetch()}>{t('reviews.helpful.retry')}</Button>
        ) : null}
        {uniqueReviews.map((review) => (
          <View
            key={review.id}
            onLayout={
              review.id === initialReviewId
                ? (event) => {
                    const { y, height } = event.nativeEvent.layout;
                    setReviewLayout({ y, height });
                  }
                : undefined
            }
          >
            <ReviewCard
              review={review}
              scopeLabel={title}
              expanded
              footerActions={
                <View className="flex-row items-center gap-space-20">
                  <ReviewHelpfulButton review={review} vote={votes.get(review.id)} />
                  <ReviewActionsMenu review={review} />
                </View>
              }
            />
          </View>
        ))}
        {query.isFetchingNextPage ? (
          <Text
            accessibilityLiveRegion="polite"
            className="text-center text-shop-caption text-text-tertiary"
          >
            {t('common.loading')}
          </Text>
        ) : null}
        {query.isFetchNextPageError ? (
          <Button onPress={() => void query.fetchNextPage()}>{t('common.tryAgain')}</Button>
        ) : null}
      </View>
    </MarketplaceSheet>
  );
}
