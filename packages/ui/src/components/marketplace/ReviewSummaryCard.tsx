import { Pressable, ScrollView, View } from "react-native";
import type { Review } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { formatReviewCount } from "../../lib/format";
import { ReviewStars } from "./ReviewStars";
import { ReviewCard } from "./ReviewCard";

/** Star buckets, high → low, for the rating-distribution bars. */
const RATING_BUCKETS = [5, 4, 3, 2, 1] as const;
/** Star edge length (px) next to the big average figure. */
const SUMMARY_STAR_SIZE = 14;
/** Full percentage used for the distribution-bar width math. */
const FULL_PERCENT = 100;

/**
 * Count of reviews per star bucket, keyed 5..1. Computed by the screen and
 * passed in so the summary never recomputes or re-fetches.
 */
export type RatingDistribution = Record<number, number>;

export interface ReviewSummaryCardProps {
  /** Average rating (0–5) across all reviews. */
  average: number;
  /** Total number of reviews (drives the empty state + the bar denominators). */
  total: number;
  /** Count per star bucket (5..1) for the distribution bars. */
  distribution: RatingDistribution;
  /** The reviews to render in the horizontal carousel. */
  reviews: Review[];
  /** Whether the reviews query is still loading (suppresses the empty state). */
  isLoading: boolean;
}

/**
 * The reviews card: a large average + stars, a 5→1 distribution-bar column, and
 * a horizontal carousel of `ReviewCard`s. Shows an empty state when there are no
 * reviews and loading has finished. Fully presentational — the average, total,
 * and distribution are computed by the screen and passed in.
 */
export function ReviewSummaryCard({
  average,
  total,
  distribution,
  reviews,
  isLoading,
}: ReviewSummaryCardProps) {
  return (
    <View className="gap-space-16 rounded-radius-28 border border-border-secondary bg-bg-fill p-space-20">
      <Text className="text-subtitle text-text">Reviews</Text>

      {total === 0 && !isLoading ? (
        <Text className="text-bodySmall text-text-tertiary">
          No reviews yet. Be the first to review this product.
        </Text>
      ) : (
        <>
          {/* Summary: big average + stars + distribution bars. */}
          <View className="flex-row gap-space-24">
            <View className="items-start">
              <Text className="text-headerBold text-text">{average.toFixed(1)}</Text>
              <ReviewStars rating={average} count={total} size={SUMMARY_STAR_SIZE} />
              <Text className="mt-space-4 text-caption text-text-tertiary">
                {`${formatReviewCount(total)} ratings`}
              </Text>
            </View>
            <View className="flex-1 justify-center gap-space-4">
              {RATING_BUCKETS.map((bucket) => {
                const count = distribution[bucket] ?? 0;
                const pct = total > 0 ? (count / total) * FULL_PERCENT : 0;
                return (
                  <View key={bucket} className="flex-row items-center gap-space-8">
                    <Text className="w-space-10 text-badgeBold text-text">{bucket}</Text>
                    <View className="h-2 flex-1 rounded-radius-8 bg-overlay-inverse-06">
                      <View
                        className="h-2 rounded-radius-8 bg-bg-fill-inverse"
                        style={{ width: `${pct}%` }}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          </View>

          {/* Review cards carousel. */}
          {reviews.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 12, paddingVertical: 4 }}
            >
              {reviews.map((review) => (
                <ReviewCard key={review.id} review={review} />
              ))}
            </ScrollView>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Read more reviews"
            className="w-full items-center rounded-radius-max bg-bg-fill-secondary p-space-12"
          >
            <Text className="text-buttonLarge text-text">Read more reviews</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
