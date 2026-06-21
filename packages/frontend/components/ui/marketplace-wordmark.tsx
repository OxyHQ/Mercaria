import { Text as RNText } from "react-native";
import { useColorScheme } from "@/lib/useColorScheme";

export interface MarketplaceWordmarkProps {
  width?: number;
  height?: number;
  color?: string;
}

/**
 * Marketplace brand wordmark.
 *
 * Rendered as styled text in the app's brand font (Inter) rather than a
 * hand-traced SVG so it stays crisp at any size and inherits theme colors.
 * `width` controls the font size (the wordmark is ~6:1 wide as tall, so the
 * type scale is derived from the requested width to keep callers' sizing
 * expectations roughly intact).
 */
export function MarketplaceWordmark({ width = 96, height, color }: MarketplaceWordmarkProps) {
  const { colors } = useColorScheme();
  const fill = color ?? colors.foreground;

  // Approximate the wordmark height from the requested width (logo aspect ~6:1)
  // and use it as the font size; callers that pass `height` get it directly.
  const fontSize = height ?? Math.round(width / 6);

  return (
    <RNText
      accessibilityRole="header"
      style={{
        fontFamily: "Inter",
        fontWeight: "700",
        fontSize,
        lineHeight: Math.round(fontSize * 1.1),
        letterSpacing: -fontSize * 0.03,
        color: fill,
      }}
    >
      Marketplace
    </RNText>
  );
}
