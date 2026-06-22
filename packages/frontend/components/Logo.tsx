import { type ReactElement } from "react";
import Svg, { Path } from "react-native-svg";
import { type ViewStyle } from "react-native";
import { useColorScheme } from "@mercaria/ui";

const LOGO_PATH =
  "M100.78-60.78v-673.35h170.74q0-86.39 60.76-147.44 60.76-61.04 147.72-61.04 86.96 0 147.72 61.04 60.76 61.05 60.76 147.44h170.74v673.35H100.78Zm526.94-379.63q60.76-60.76 60.76-147.72h-106q0 43.22-29.63 72.85-29.63 29.63-72.85 29.63t-72.85-29.63q-29.63-29.63-29.63-72.85h-106q0 86.96 60.76 147.72 60.76 60.76 147.72 60.76 86.96 0 147.72-60.76Zm-250.2-293.72h204.96q0-43.22-29.63-72.85-29.63-29.63-72.85-29.63t-72.85 29.63q-29.63 29.63-29.63 72.85Z";

export interface LogoProps {
  /** Override the mark color. Defaults to the theme foreground. */
  color?: string;
  /** Square size in px. */
  size?: number;
  style?: ViewStyle;
  className?: string;
}

/**
 * Mercaria brand logo mark — a storefront / shopping-bag glyph.
 *
 * Renders the inlined SVG path (no metro svg transformer dependency) and, by
 * default, follows the active Bloom theme's foreground color. Pair it with
 * `<MercariaWordmark/>` for the full lockup.
 */
export function Logo({ color, size = 28, style, className }: LogoProps): ReactElement {
  const { colors } = useColorScheme();
  const fill = color ?? colors.foreground;
  return (
    <Svg viewBox="0 -960 960 960" width={size} height={size} style={style} className={className}>
      <Path d={LOGO_PATH} fill={fill} />
    </Svg>
  );
}
