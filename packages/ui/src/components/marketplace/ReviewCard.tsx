import { View } from "react-native";
import { Image } from "expo-image";
import type { Review } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { ReviewStars } from "./ReviewStars";

/** Star edge length (px) inside a review card. */
const REVIEW_STAR_SIZE = 14;
/**
 * Fallback author label when the Oxy profile does not resolve.
 *
 * Deliberately NOT "Verified buyer": that claimed a verification the card had no
 * way to know about, and after #76 a review's verification is a real field. It
 * is also deliberately not derived from anything — no initials, no email local
 * part, no generated handle (#76 UI rule 7). "Mercaria buyer" says exactly what
 * is known: somebody with an Oxy account wrote this, and their profile did not
 * load.
 */
const FALLBACK_AUTHOR = "Mercaria buyer";

/** What each verification state says on a card. */
const VERIFICATION_LABEL: Readonly<Record<string, string>> = Object.freeze({
  verified_purchase: "Verified purchase",
  unverified: "Unverified",
});

export interface ReviewCardProps {
  /** The review to render. */
  review: Review;
  /** What this review's rating is about (#76 UI rule 6), for the star label. */
  scopeLabel?: string;
}

/**
 * A single review card in the horizontal review carousel: the star rating, an
 * optional title + body, and the author avatar + name + date footer. Renders
 * the canonical `name.displayName` author identity directly (no recomputation).
 */
export function ReviewCard({ review, scopeLabel }: ReviewCardProps) {
  const date = new Date(review.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const author = review.author?.displayName ?? FALLBACK_AUTHOR;

  return (
    <View className="min-h-[140px] w-[280px] shrink-0 gap-space-8 rounded-radius-20 border-[0.5px] border-border-image bg-bg-fill p-space-16">
      <ReviewStars
        rating={review.rating}
        count={1}
        size={REVIEW_STAR_SIZE}
        {...(scopeLabel ? { scopeLabel } : {})}
      />
      {/*
        The verification state comes off the REVIEW, not off whether the author
        profile happened to resolve. An unverified review is labelled as such
        and counted separately in the aggregate (#76 verification rule 5) — the
        two must agree, and reading the same field is how.
      */}
      <Text className="text-caption text-text-tertiary">
        {VERIFICATION_LABEL[review.verification] ?? VERIFICATION_LABEL.unverified}
      </Text>
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
