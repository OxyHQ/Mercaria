import React from "react";
import type { LucideIcon } from "lucide-react-native";
import type { BloomIconComponent } from "@oxy.so/bloom/icons";

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
  Adapted.displayName = `BloomIcon(${Icon.displayName ?? "Lucide"})`;
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
