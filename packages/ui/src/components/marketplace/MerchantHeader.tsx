import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { MoreHorizontal, Star } from "lucide-react-native";
import { Text } from "../ui/text";
import { formatReviewCount } from "../../lib/format";
import { IncentiveHalo } from "./IncentiveHalo";

/** Fixed gold star fill (mirrors ReviewStars / MerchantCard constant). */
const STAR_COLOR = "#FFB800";
/** Logo edge length (px) for the `large` (mobile sticky bar) variant. */
const LARGE_LOGO_SIZE = 44;
/** Logo edge length (px) for the `compact` (desktop buy column) variant. */
const COMPACT_LOGO_SIZE = 32;
/** Star glyph size (px) inside the rating row. */
const HEADER_STAR_SIZE = 13;
/** Overflow (…) icon size (px). */
const OVERFLOW_ICON_SIZE = 20;

export interface MerchantHeaderProps {
  /** Merchant/seller display name. */
  name: string;
  /** Resolvable logo/avatar URL, when present. */
  logoUrl?: string;
  /** Aggregate rating (0–5), when the merchant has reviews. */
  rating?: number;
  /** Number of reviews contributing to `rating`. */
  reviewCount?: number;
  /** Tap the identity (logo + name) — typically navigates to the store. */
  onPress: () => void;
  /**
   * Visual variant:
   * - `large` — bigger halo logo, name + rating, and an outlined "Visit store"
   *   button on the right (the mobile sticky merchant bar).
   * - `compact` — smaller halo logo, name + rating, and a trailing overflow
   *   (…) button (the desktop buy-column header).
   */
  size?: "large" | "compact";
}

/** Compact "★ 4.4 (310.6K)" rating row used inside the header. */
function HeaderRating({ rating, reviewCount }: { rating: number; reviewCount?: number }) {
  return (
    <View className="flex-row items-center gap-space-4">
      <Star size={HEADER_STAR_SIZE} color={STAR_COLOR} fill={STAR_COLOR} />
      <Text className="text-captionBold text-text">
        {`${rating}${reviewCount !== undefined ? ` (${formatReviewCount(reviewCount)})` : ""}`}
      </Text>
    </View>
  );
}

/** Halo-wrapped merchant logo at a fixed edge length. */
function HeaderLogo({ logoUrl, size }: { logoUrl?: string; size: number }) {
  return (
    <IncentiveHalo>
      <View
        className="overflow-hidden rounded-radius-max bg-bg-fill-secondary"
        style={{ height: size, width: size }}
      >
        {logoUrl ? (
          <Image
            source={{ uri: logoUrl }}
            contentFit="cover"
            style={{ height: size, width: size }}
          />
        ) : null}
      </View>
    </IncentiveHalo>
  );
}

/**
 * Merchant identity header used on the PDP buy column. Renders an incentive-halo
 * logo + name + optional rating, with a trailing action that depends on `size`:
 * the `large` variant ends in an outlined "Visit store" link; the `compact`
 * variant ends in an overflow (…) button. Purely presentational — the caller
 * owns navigation via `onPress`.
 */
export function MerchantHeader({
  name,
  logoUrl,
  rating,
  reviewCount,
  onPress,
  size = "compact",
}: MerchantHeaderProps) {
  const isLarge = size === "large";

  return (
    <View className="flex-row items-center gap-space-8">
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Visit ${name}`}
        onPress={onPress}
        className="flex-1 flex-row items-center gap-space-8"
      >
        <HeaderLogo logoUrl={logoUrl} size={isLarge ? LARGE_LOGO_SIZE : COMPACT_LOGO_SIZE} />
        <View className="flex-1">
          <Text
            numberOfLines={1}
            className={
              isLarge
                ? "text-bodyTitleLarge text-text"
                : "text-bodyTitleSmall text-text"
            }
          >
            {name}
          </Text>
          {rating !== undefined ? (
            <HeaderRating rating={rating} reviewCount={reviewCount} />
          ) : null}
        </View>
      </Pressable>

      {isLarge ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Visit ${name}`}
          onPress={onPress}
          className="rounded-radius-max border-[1.5px] border-border-secondary px-space-16 py-space-8"
        >
          <Text className="text-buttonMedium text-text">Visit store</Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="More options"
          hitSlop={8}
          className="rounded-radius-max p-space-6"
        >
          <MoreHorizontal size={OVERFLOW_ICON_SIZE} className="text-text-tertiary" />
        </Pressable>
      )}
    </View>
  );
}
