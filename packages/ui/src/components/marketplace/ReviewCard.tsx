import { View } from "react-native";
import { Image } from "expo-image";
import type { Review } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { ReviewStars } from "./ReviewStars";

/** Star edge length (px) inside a review card. */
const REVIEW_STAR_SIZE = 14;
/** Fallback author label when the Oxy profile doesn't resolve. */
const FALLBACK_AUTHOR = "Verified buyer";

export interface ReviewCardProps {
  /** The review to render. */
  review: Review;
}

/**
 * A single review card in the horizontal review carousel: the star rating, an
 * optional title + body, and the author avatar + name + date footer. Renders
 * the canonical `name.displayName` author identity directly (no recomputation).
 */
export function ReviewCard({ review }: ReviewCardProps) {
  const date = new Date(review.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const author = review.author?.displayName ?? FALLBACK_AUTHOR;

  return (
    <View className="min-h-[140px] w-[280px] shrink-0 gap-space-8 rounded-radius-20 border-[0.5px] border-border-image bg-bg-fill p-space-16">
      <ReviewStars rating={review.rating} count={1} size={REVIEW_STAR_SIZE} />
      {review.title ? (
        <Text numberOfLines={1} className="text-captionMedium text-text">
          {review.title}
        </Text>
      ) : null}
      {review.body ? (
        <Text numberOfLines={4} className="text-caption text-text">
          {review.body}
        </Text>
      ) : null}
      <View className="mt-auto flex-row items-center gap-space-8">
        <View className="size-space-24 overflow-hidden rounded-radius-max border border-border-image bg-bg-fill-secondary">
          {review.author?.avatar ? (
            <Image
              source={{ uri: review.author.avatar }}
              contentFit="cover"
              className="size-space-24 rounded-radius-max"
            />
          ) : null}
        </View>
        <Text numberOfLines={1} className="flex-1 text-caption text-text-tertiary">
          {`${author} · ${date}`}
        </Text>
      </View>
    </View>
  );
}
