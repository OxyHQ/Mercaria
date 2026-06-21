import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

/** Fixed gold fill for the rated portion of the stars (documented constant). */
const STAR_COLOR = "#FFB800";
/** Default star edge length in px. */
const DEFAULT_SIZE = 14;
/** Number of stars in the rating row. */
const STAR_COUNT = 5;
/** Gap between stars in px. */
const STAR_GAP = 1;
/** Canonical 5-point star path, traced inside a 24×24 viewBox. */
const STAR_PATH =
  "M12 2.5l2.92 5.92 6.53.95-4.72 4.6 1.11 6.51L12 17.42 6.16 20.5l1.11-6.51-4.72-4.6 6.53-.95L12 2.5z";

export interface ReviewStarsProps {
  /** Average rating, 0–5. Fractional values render a partially filled star. */
  rating: number;
  /** Number of reviews the rating is based on (used for accessibility only). */
  count?: number;
  /** Star edge length in px. */
  size?: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

interface StarProps {
  /** Fraction of this star to fill with gold, 0–1. */
  fill: number;
  size: number;
  emptyColor: string;
}

function Star({ fill, size, emptyColor }: StarProps) {
  const fraction = clamp01(fill);
  return (
    <View style={{ width: size, height: size }}>
      {/* Empty (muted) star sits underneath. */}
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d={STAR_PATH} fill={emptyColor} />
      </Svg>
      {/* Gold star clipped horizontally to the fill fraction. */}
      {fraction > 0 ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: size * fraction,
            height: size,
            overflow: "hidden",
          }}
          pointerEvents="none"
        >
          <Svg width={size} height={size} viewBox="0 0 24 24">
            <Path d={STAR_PATH} fill={STAR_COLOR} />
          </Svg>
        </View>
      ) : null}
    </View>
  );
}

/**
 * A 5-star average-rating row with deterministic partial fill. The rated
 * portion is gold (`#FFB800`); the remainder uses the theme muted color.
 */
export function ReviewStars({ rating, count, size = DEFAULT_SIZE }: ReviewStarsProps) {
  const { colors } = useColorScheme();

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Average rating: ${rating}, based on ${count ?? 0} reviews`}
      style={{ flexDirection: "row" }}
    >
      {Array.from({ length: STAR_COUNT }, (_, index) => (
        <View key={index} style={{ marginRight: index < STAR_COUNT - 1 ? STAR_GAP : 0 }}>
          <Star fill={rating - index} size={size} emptyColor={colors.border} />
        </View>
      ))}
    </View>
  );
}
