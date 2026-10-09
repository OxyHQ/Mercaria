import { View } from "react-native";
import { Button } from "@oxy.so/bloom/button";
import { Carousel, CarouselItem } from "@oxy.so/bloom/carousel";
import type { Review } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import {
  REVIEW_DEFAULT_SCOPE_KEY,
  REVIEW_EMPTY_KEY,
  REVIEW_READ_MORE_KEY,
  REVIEW_UNVERIFIED_KEY,
  REVIEW_VERIFIED_RATINGS_KEY,
} from "../../lib/marketplace-labels";
import { Rating, RatingBar } from "@oxy.so/bloom/rating";
import { useInView } from "@oxy.so/bloom/viewport";
import { useFormatters } from "../../lib/use-formatters";
import { useRatingDisplay } from "../../lib/rating-display";
import { ReviewCard } from "./ReviewCard";
import { REVIEW_PREVIEW_ARROW_BUTTON_PROPS, useShelfCarouselProps } from "../../lib/shelf-carousel";
import { useColorScheme } from "../../lib/useColorScheme";

/** Star buckets, high → low, for the rating-distribution bars. */
const RATING_BUCKETS = [5, 4, 3, 2, 1] as const;
/** Width (px) of a distribution row's star label, so every bar starts aligned. */
const BUCKET_LABEL_WIDTH = 10;

/**
 * Count of reviews per star bucket, keyed 5..1. Computed by the screen and
 * passed in so the summary never recomputes or re-fetches.
 */
export type RatingDistribution = Record<number, number>;

export interface ReviewSummaryCardProps {
  /** Average rating (0–5) across all reviews. */
  average: number;
  /** Use inside a labelled PDP accordion, without another card border. */
  embedded?: boolean;
  onReadMore?: () => void;
  onReviewPress?: (reviewId: string) => void;
  /** Total number of reviews (drives the empty state + the bar denominators). */
  total: number;
  /** Count per star bucket (5..1) for the distribution bars. */
  distribution?: RatingDistribution;
  /** Legacy listing reviews do not claim purchase verification. */
  verifiedOnly?: boolean;
  /** The reviews to render in the horizontal carousel. */
  reviews: Review[];
  /** Whether the reviews query is still loading (suppresses the empty state). */
  isLoading: boolean;
  /**
   * The heading — what these reviews are ABOUT (#76 UI rule 6). Defaults to the
   * pre-#76 wording so an un-migrated surface keeps rendering, but every call
   * site in this repo names its scope: "Product reviews", "Seller service",
   * "Item condition and description".
   */
  scopeLabel?: string;
  /** Hide a repeated heading when an enclosing sheet already names the scope. */
  showHeading?: boolean;
  /**
   * Reviews with no purchase behind them, counted SEPARATELY (#76 verification
   * rule 5). Shown as its own line rather than folded into `total`, because the
   * whole point of the split is that the two do not carry the same weight — and
   * a card that summed them would put that decision back in the renderer.
   */
  unverified?: { rating: number; count: number };
}

/**
 * The reviews card: a large average figure, a 5→1 column of Bloom `RatingBar`s,
 * and a horizontal carousel of `ReviewCard`s. Shows an empty state when there are no
 * reviews and loading has finished. Fully presentational — the average, total,
 * and distribution are computed by the screen and passed in.
 */
export function ReviewSummaryCard({
  average,
  total,
  distribution,
  reviews,
  isLoading,
  scopeLabel,
  showHeading = true,
  unverified,
  verifiedOnly = true,
  embedded = false,
  onReadMore,
  onReviewPress,
}: ReviewSummaryCardProps) {
  const { formatRating, formatReviewCount } = useFormatters();
  const ratingDisplay = useRatingDisplay();
  const t = useSharedUiTranslation();
  const shelf = useShelfCarouselProps();
  const { isDarkColorScheme } = useColorScheme();
  const histogramVisibility = useInView({ threshold: 1, once: true });
  // Shop's PDP summary previews three reviews; the sheet owns the full list.
  const previews = reviews.slice(0, 3);
  // The default was the English literal `"Reviews"` in the parameter list,
  // which no bundle could reach. Resolved here instead, so a caller that
  // passes nothing gets the viewer's language rather than ours.
  const scopeText = scopeLabel ?? t(REVIEW_DEFAULT_SCOPE_KEY);
  const distributionTotal = Object.values(distribution ?? {}).reduce((sum, count) => sum + count, 0);
  // The verified aggregate does not count unverified reviews. A zero here
  // must not hide those reviews or pretend their average is a verified one.
  const hasReviews = total > 0 || (unverified?.count ?? 0) > 0 || reviews.length > 0;
  return (
    <View
      className={
        embedded
          ? "gap-space-16"
          : "gap-space-16 rounded-radius-28 border border-border-secondary bg-bg-fill p-space-20"
      }
    >
      {showHeading ? <Text className="text-shop-subtitle text-text">{scopeText}</Text> : null}

      {!hasReviews && !isLoading ? (
        <Text className="text-shop-bodySmall text-text-tertiary">
          {t(REVIEW_EMPTY_KEY, { subject: scopeText })}
        </Text>
      ) : (
        <>
          {/*
            Summary: the big average + distribution bars. The figure carries the
            scoped sentence ("Product reviews. Average rating: 4.2. Reviews: 18.")
            for assistive technology. Decorative stars don't repeat it.
          */}
          {total > 0 ? <View className="flex-row gap-space-24">
            <View className="items-start gap-space-2">
              <Text
                testID="review-rating-average"
                accessible
                accessibilityRole="text"
                accessibilityLabel={
                  ratingDisplay({
                    rating: average,
                    reviews: total,
                    subject: scopeText,
                  }).accessibilityLabel
                }
                className="mb-space-2 text-shop-header text-text"
              >
                {formatRating(average)}
              </Text>
              <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Rating
                  {...ratingDisplay({ rating: average, variant: "stars", subject: scopeText })}
                  variant="stars"
                  showValue={false}
                  starSize={20}
                  color={isDarkColorScheme ? "#ffffff" : "#000000"}
                  testID="review-summary-stars"
                />
              </View>
              <Text className="text-shop-caption text-text">
                {t(
                  verifiedOnly
                    ? REVIEW_VERIFIED_RATINGS_KEY
                    : "ui.review.ratings",
                  { ratings: formatReviewCount(total) },
                )}
              </Text>
            </View>
            {distribution ? (
              <View {...histogramVisibility.targetProps} className="flex-1 justify-center gap-space-2" testID="review-rating-distribution">
                {RATING_BUCKETS.map((bucket) => {
                  const count = distribution[bucket] ?? 0;
                  return (
                    <RatingBar
                      key={bucket}
                      label={String(bucket)}
                      labelWidth={BUCKET_LABEL_WIDTH}
                      testID={`rating-distribution-${bucket}`}
                      className="gap-space-8"
                      labelClassName={`text-center text-shop-badgeBold ${isDarkColorScheme ? "text-white" : "text-black"}`}
                      trackClassName={`h-space-8 rounded-radius-8 ${isDarkColorScheme ? "bg-[#ffffff0f]" : "bg-[#183b4e0f]"}`}
                      fillClassName={`rounded-radius-8 ${isDarkColorScheme ? "bg-white" : "bg-[#121212]"}`}
                      value={distributionTotal > 0 ? count / distributionTotal : 0}
                      max={1}
                      reveal={{ visible: histogramVisibility.inView, duration: 1000, delay: 300, easing: [0.4, 0, 0.2, 1], once: true }}
                    />
                  );
                })}
              </View>
            ) : null}
          </View> : null}

          {unverified && unverified.count > 0 ? (
            <Text className="text-shop-caption text-text-tertiary">
              {t(REVIEW_UNVERIFIED_KEY, {
                ratings: formatReviewCount(unverified.count),
                rating: formatRating(unverified.rating),
              })}
            </Text>
          ) : null}

          {/* Review cards carousel. */}
          {reviews.length > 0 ? (
            <Carousel
              {...shelf}
              gap={12}
              inset={0}
              accessibilityLabel={scopeText}
              arrowsPlacement="overlay"
              arrowsVisibility="hover"
              arrowButtonProps={REVIEW_PREVIEW_ARROW_BUTTON_PROPS}
              showArrows={shelf.showArrows && previews.length > 1}
              testID="review-preview-carousel"
            >
              {previews.map((review) => (
                <CarouselItem key={review.id} width={previews.length === 1 ? undefined : 280}>
                  <ReviewCard
                    review={review}
                    scopeLabel={scopeText}
                    onPress={onReviewPress ? () => onReviewPress(review.id) : undefined}
                  />
                </CarouselItem>
              ))}
            </Carousel>
          ) : null}

          {onReadMore && hasReviews ? (
            <Button
              material="flat"
              onPress={onReadMore}
              accessibilityLabel={t(REVIEW_READ_MORE_KEY)}
              className={`h-auto min-h-[44px] w-full items-center rounded-radius-max border-0 p-space-12 active:scale-[0.99] motion-reduce:active:scale-100 ${isDarkColorScheme
                ? "bg-[#2a2a2a] hover:bg-[#404040]"
                : "bg-[#f2f4f5] hover:bg-[#e1e4e5]"}`}
            >
              <Text className={`text-shop-buttonLarge ${isDarkColorScheme ? "text-white" : "text-black"}`}>
                {t(REVIEW_READ_MORE_KEY)}
              </Text>
            </Button>
          ) : null}
        </>
      )}
    </View>
  );
}
