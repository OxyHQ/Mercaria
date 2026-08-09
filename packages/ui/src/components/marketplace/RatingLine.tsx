import { Pressable, View } from "react-native";
import { Text } from "../ui/text";
import { formatReviewCount } from "../../lib/format";
import { ReviewStars } from "./ReviewStars";

/** Star edge length (px) for the title rating row. */
const RATING_STAR_SIZE = 16;

export interface RatingLineProps {
  /** Average rating (0–5) rendered as partially filled stars. */
  rating: number;
  /** Number of reviews — formatted and shown as an underlined link label. */
  count: number;
  /** Optional tap handler (e.g. scroll to / open the reviews section). */
  onPress?: () => void;
  /**
   * What this rating is about (#76 UI rule 6). Rendered as visible copy AND
   * folded into the accessible label, so a page carrying a product rating and a
   * seller rating never shows two identical "4.2 ★" rows a reader has to guess
   * between.
   */
  scopeLabel?: string;
}

/**
 * The title rating row: 5 stars + an underlined "N ratings" link. Presentational
 * only — the caller decides whether to render it (typically hidden when there
 * are no reviews) and what `onPress` does.
 */
export function RatingLine({ rating, count, onPress, scopeLabel }: RatingLineProps) {
  const label = `${formatReviewCount(count)} ratings`;
  const accessibleLabel = scopeLabel ? `${scopeLabel}: ${label}` : label;

  const row = (
    <>
      <ReviewStars
        rating={rating}
        count={count}
        size={RATING_STAR_SIZE}
        {...(scopeLabel ? { scopeLabel } : {})}
      />
      <Text className="text-bodyTitleSmall text-text underline">{label}</Text>
      {scopeLabel ? (
        <Text className="text-captionMedium text-text-tertiary">{scopeLabel}</Text>
      ) : null}
    </>
  );

  if (onPress) {
    return (
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={accessibleLabel}
        onPress={onPress}
        className="flex-row items-center gap-space-8"
      >
        {row}
      </Pressable>
    );
  }

  return <View className="flex-row items-center gap-space-8">{row}</View>;
}
