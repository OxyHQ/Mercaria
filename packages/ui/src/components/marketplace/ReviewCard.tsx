import type { ReactNode } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import type { Review } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { Rating } from "@oxy.so/bloom/rating";
import { Button } from "@oxy.so/bloom/button";
import { useRatingDisplay } from "../../lib/rating-display";
import { useSharedUiLocale, useSharedUiTranslation } from "../../i18n/ui-translation";
import { formatDate } from "../../lib/date";
import { useColorScheme } from "../../lib/useColorScheme";

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
const FALLBACK_AUTHOR_KEY = "ui.review.fallbackAuthor";

/** What each verification state says on a card. */
const VERIFICATION_LABEL_KEYS: Readonly<Record<string, string>> = {
  verified_purchase: "ui.review.verifiedPurchase",
  unverified: "ui.review.unverifiedPurchase",
};

export interface ReviewCardProps {
  /** The review to render. */
  review: Review;
  /** Expanded review list: full text and container width. */
  expanded?: boolean;
  /** Open this preview in the complete review list. Expanded cards are static. */
  onPress?: () => void;
  /** What this review's rating is about (#76 UI rule 6), for the star label. */
  scopeLabel?: string;
  /** Actions on a full review; previews remain a single accessible button. */
  footerActions?: ReactNode;
}

/**
 * A single review card in the horizontal review carousel: the star rating, an
 * optional title + body, and the author avatar + name + date footer. Renders
 * the canonical `name.displayName` author identity directly (no recomputation).
 */
export function ReviewCard({
  review,
  scopeLabel,
  expanded = false,
  onPress,
  footerActions,
}: ReviewCardProps) {
  const locale = useSharedUiLocale();
  const t = useSharedUiTranslation();
  const date = formatDate(review.createdAt, locale);
  const author = review.author?.displayName ?? t(FALLBACK_AUTHOR_KEY);
  const ratingDisplay = useRatingDisplay();
  const { isDarkColorScheme } = useColorScheme();

  const content = (
    <View className="flex-1 gap-space-8">
      <Rating
        {...ratingDisplay({
          rating: review.rating,
          variant: "stars",
          ...(scopeLabel ? { subject: scopeLabel } : {}),
        })}
        size="small"
        variant="stars"
        showValue={false}
        starSize={expanded ? 20 : 12}
        color={isDarkColorScheme ? "#ffffff" : "#000000"}
      />
      {/*
        The verification state comes off the REVIEW, not off whether the author
        profile happened to resolve. An unverified review is labelled as such
        and counted separately in the aggregate (#76 verification rule 5) — the
        two must agree, and reading the same field is how.
      */}
      <Text className="text-shop-caption text-text-tertiary">
        {t(VERIFICATION_LABEL_KEYS[review.verification] ??
          VERIFICATION_LABEL_KEYS.unverified)}
      </Text>
      {review.title ? (
        <Text
          className={expanded ? "text-shop-bodyTitleLarge text-text" : "text-shop-captionMedium text-text"}
        >
          {review.title}
        </Text>
      ) : null}
      {expanded && review.purchasedVariantTitle ? (
        <Text testID="review-purchased-variant" className="text-shop-caption text-text-tertiary">
          {review.purchasedVariantTitle}
        </Text>
      ) : null}
      {review.body ? (
        <Text
          numberOfLines={expanded ? undefined : 4}
          className={expanded ? "text-shop-bodySmall text-text" : "text-shop-caption text-text"}
        >
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
        {/* The footer is "author · date", so an unformattable timestamp drops
            the date and its separator rather than rendering `null` beside a
            name. `formatDate` returns null only for a value that is not a date
            at all. */}
        <Text
          numberOfLines={1}
          className="flex-1 text-shop-caption text-text-tertiary"
        >
          {date === null ? author : `${author} · ${date}`}
        </Text>
        {expanded ? footerActions : null}
      </View>
    </View>
  );
  const className = `h-auto min-h-[140px] w-full shrink-0 rounded-radius-20 border-[0.5px] p-space-16 ${expanded
    ? `bg-transparent shadow-shop-s ${isDarkColorScheme ? "border-white/10" : "border-[#183b4e0f]"}`
    : isDarkColorScheme ? "border-white/20 bg-[#121212]" : "border-black/10 bg-white"}`;
  return onPress && !expanded ? (
    <Button
      material="flat"
      testID={`review-${review.id}`}
      className={`${className} items-stretch justify-start`}
      accessibilityLabel={`${t("ui.review.open", { author })}${review.title ? `: ${review.title}` : ""}`}
      onPress={onPress}
    >
      {content}
    </Button>
  ) : (
    <View testID={`review-${review.id}`} className={className}>{content}</View>
  );
}
