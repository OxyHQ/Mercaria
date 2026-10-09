import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Rating } from "@oxy.so/bloom/rating";
import { Text } from "../ui/text";
import { useRatingDisplay, type RatingDisplay } from "../../lib/rating-display";
import { useColorScheme } from "../../lib/useColorScheme";

/** The collapsed PDP review caption uses the same aggregate as its expanded summary. */
export function ReviewAccordionAccessory({ expanded, rating, reviews, subject }: {
  expanded: boolean;
  rating: number;
  reviews: number;
  subject: string;
}) {
  const display = useRatingDisplay()({ rating, reviews, subject });
  if (reviews <= 0) return null;
  // A different value/locale measures its own intrinsic width. Opening and
  // closing preserve that width so the heading and chevron never move.
  return <MeasuredAccessory key={display.accessibilityLabel} expanded={expanded} display={display} />;
}

function MeasuredAccessory({ expanded, display }: { expanded: boolean; display: RatingDisplay }) {
  const { isDarkColorScheme } = useColorScheme();
  const [width, setWidth] = useState(0);
  const reveal = useSharedValue(expanded ? 0 : 1);
  useEffect(() => {
    reveal.value = withTiming(expanded ? 0 : 1, {
      duration: 250,
      easing: Easing.linear,
      reduceMotion: ReduceMotion.System,
    });
  }, [expanded, reveal]);
  const mask = useAnimatedStyle(() => ({
    opacity: reveal.value,
    ...(width > 0 ? { width: width * reveal.value } : {}),
  }), [width]);

  return (
    <View
      testID="reviews-collapsed-summary"
      className="ms-space-8 shrink-0 items-end"
      style={width > 0 ? { width } : undefined}
      pointerEvents="none"
      accessible={!expanded}
      accessibilityLabel={display.accessibilityLabel}
      aria-hidden={expanded}
      accessibilityElementsHidden={expanded}
      importantForAccessibility={expanded ? "no-hide-descendants" : "auto"}
    >
      {/* Clipping a fixed-width row from its logical end mirrors Shop's
          clip-path reveal on native too, without moving or scaling the text. */}
      <Animated.View testID="reviews-collapsed-summary-mask" className="items-end overflow-hidden" style={mask}>
        <View
          aria-hidden
          className="flex-row items-center gap-space-4"
          style={width > 0 ? { width } : undefined}
          onLayout={({ nativeEvent }) => {
            if (!width && nativeEvent.layout.width > 0) setWidth(nativeEvent.layout.width);
          }}
        >
          <Text numberOfLines={1} className="text-shop-bodySmall text-black/75 dark:text-white/75">{display.value}</Text>
          <Rating value={5} showValue={false} starSize={16} color={isDarkColorScheme ? "#ffffffbf" : "#000000bf"} />
          <Text numberOfLines={1} className="text-shop-bodySmall text-black/75 dark:text-white/75">({display.count})</Text>
        </View>
      </Animated.View>
    </View>
  );
}
