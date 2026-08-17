import { Text as RNText } from "react-native";
import { useColorScheme } from "@mercaria/ui";

import { useTranslation } from "@/lib/i18n";

export interface MercariaWordmarkProps {
  width?: number;
  height?: number;
  color?: string;
}

/**
 * Mercaria brand wordmark.
 *
 * Rendered as styled text in the app's brand font (Inter) rather than a
 * hand-traced SVG so it stays crisp at any size and inherits theme colors.
 * `width` controls the font size (the wordmark is ~6:1 wide as tall, so the
 * type scale is derived from the requested width to keep callers' sizing
 * expectations roughly intact).
 *
 * The name resolves through `t('brand.wordmark')` even though every bundle
 * currently spells it "Mercaria". A brand name is exactly the case where a key
 * earns its keep: some scripts transliterate a wordmark and some do not, and
 * putting it in the bundle is what moves that decision to where a translator
 * can see it and make it, instead of leaving it unaskable in JSX.
 */
export function MercariaWordmark({ width = 96, height, color }: MercariaWordmarkProps) {
  const { t } = useTranslation();
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
      {t("brand.wordmark")}
    </RNText>
  );
}
