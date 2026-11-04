import type React from 'react';
import type { LucideIcon } from 'lucide-react-native';
import type { ColorValue, StyleProp } from 'react-native';
import {
  sizes,
  type BloomIconComponent,
  type IconStyle,
  type Props as BloomSvgIconProps,
} from '@oxy.so/bloom/icons';

/**
 * Lucide glyphs in Bloom's navigation chrome.
 *
 * Bloom paints an icon it is handed by passing `width` and `fill` (the Remix
 * convention); a lucide icon reads `size` and `color` instead, so handed over
 * as-is it would render at its default size in its default colour and never
 * follow the selected / hover tint. These two adapters translate once, here,
 * rather than in every app's sidebar and bottom bar.
 */

const SIDEBAR_ICON_CACHE = new Map<LucideIcon, BloomIconComponent>();

/**
 * A lucide icon as a Bloom icon COMPONENT (`Sidebar` items, primary actions).
 *
 * Cached per icon so the component identity is stable across renders — a fresh
 * function every render would remount the glyph inside every sidebar row.
 */
export function toBloomIcon(Icon: LucideIcon): BloomIconComponent {
  const cached = SIDEBAR_ICON_CACHE.get(Icon);
  if (cached) return cached;
  const Adapted: BloomIconComponent = ({ width, fill }) => <Icon size={width} color={fill} />;
  Adapted.displayName = `BloomIcon(${Icon.displayName ?? 'Lucide'})`;
  SIDEBAR_ICON_CACHE.set(Icon, Adapted);
  return Adapted;
}

export interface LucideGlyphProps {
  icon: LucideIcon;
  /** Injected by Bloom's tab/bottom bar: the layer's tint. */
  fill?: string;
  size?: number;
}

/**
 * A lucide icon as a Bloom tab-bar glyph ELEMENT (`BottomBar` items).
 *
 * The bar clones the element it is given with a `fill` prop for each crossfade
 * layer; this reads it back as lucide's `color`.
 */
export function LucideGlyph({ icon: Icon, fill, size = 22 }: LucideGlyphProps) {
  return <Icon size={size} color={fill} />;
}

/**
 * The `color` a style prop resolves to, last entry winning as in
 * `StyleSheet.flatten`. Not `StyleSheet.flatten` itself: under React Native
 * 0.88's strict types its parameter is RN's internal animated style type, which
 * rejects the `ViewStyle` Expo's react-native-web typings widen (a numeric
 * `transitionDuration`), so `IconStyle` no longer type-checks against it.
 */
function isStyleList(
  style: IconStyle | readonly StyleProp<IconStyle>[],
): style is readonly StyleProp<IconStyle>[] {
  return Array.isArray(style);
}

function styleColor(style: StyleProp<IconStyle>): ColorValue | undefined {
  if (!style || typeof style !== 'object') return undefined;
  if (isStyleList(style)) {
    for (let index = style.length - 1; index >= 0; index -= 1) {
      const color = styleColor(style[index]);
      if (color !== undefined) return color;
    }
    return undefined;
  }
  return style.color;
}

const FIELD_ICON_CACHE = new Map<LucideIcon, React.ComponentType<BloomSvgIconProps>>();

/**
 * A lucide icon as a Bloom FIELD adornment (`TextFieldIcon`).
 *
 * `TextFieldIcon` does not use the `width`/`fill` convention `toBloomIcon`
 * translates: it hands its glyph a size KEYWORD (`size="md"`) and the state
 * colour (rest / invalid / disabled) as `style.color`. Lucide reads neither, so
 * this reads both back into lucide's `size` and `color`. Cached per icon for the
 * same stable-identity reason as `toBloomIcon`.
 */
export function toBloomFieldIcon(Icon: LucideIcon): React.ComponentType<BloomSvgIconProps> {
  const cached = FIELD_ICON_CACHE.get(Icon);
  if (cached) return cached;
  const Adapted = ({ size, style }: BloomSvgIconProps) => {
    const color = styleColor(style);
    return (
      <Icon
        size={sizes[size ?? 'md']}
        color={typeof color === 'string' ? color : undefined}
        pointerEvents="none"
      />
    );
  };
  Adapted.displayName = `BloomFieldIcon(${Icon.displayName ?? 'Lucide'})`;
  FIELD_ICON_CACHE.set(Icon, Adapted);
  return Adapted;
}
