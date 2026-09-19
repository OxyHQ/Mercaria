import type { ReactNode } from "react";
import { View } from "react-native";
import { cn } from "../../lib/cn";

export interface FeedGridProps<T> {
  /** Items laid out left-to-right, wrapping onto new rows. */
  items: T[] | undefined;
  /** Stable React key for each item. */
  keyExtractor: (item: T) => string;
  /** Renders a single item; the slot around it is sized by `slotClassName`. */
  renderItem: (item: T) => ReactNode;
  /**
   * Tailwind classes that set each slot's responsive width and its own
   * horizontal gutter, e.g. `"px-space-4 md:px-space-8 w-1/2 md:w-1/3"`. Per
   * card family and read from the token appendix — the grid holds no opinion
   * about how wide a slot is.
   */
  slotClassName: string;
  /**
   * Row gap between wrapped rows, e.g. `"gap-y-space-8 md:gap-y-space-16"`
   * (the default shelf rhythm). Caller-supplied because it differs per family,
   * same reasoning as `slotClassName`.
   */
  rowGapClassName: string;
}

/**
 * The wrapping grid — the reference's `ListSection`. Everything else in
 * `@mercaria/ui` is a horizontal carousel; this is the only component that
 * wraps items onto multiple rows.
 *
 * Each slot carries its own `px-space-*` gutter and the row cancels it with a
 * matching negative margin, so the row's outer edge lines up with the page
 * gutter instead of sitting one slot-padding further in.
 *
 * Mirrors `Carousel`'s two defences for the same reasons that component states
 * them: `items` can arrive `undefined` from a partial/in-transition feed
 * payload, and a backend can return the same listing twice across overlapping
 * feed sections, which would otherwise crash React's duplicate-key check.
 */
export function FeedGrid<T>({
  items,
  keyExtractor,
  renderItem,
  slotClassName,
  rowGapClassName,
}: FeedGridProps<T>) {
  const seenKeys = new Set<string>();
  const safeItems = (items ?? []).filter((item) => {
    const key = keyExtractor(item);
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  return (
    // The reference writes this row as `flex flex-wrap` — a bare `flex` sets
    // row direction in CSS's flexbox default, but React Native's default
    // `flexDirection` is `column`. Every flex-wrap row already in this repo
    // spells `flex-row flex-wrap` for exactly that reason (e.g.
    // `SearchInterpretation.tsx`, `VariantSwatches.tsx`); omitting it here
    // would stack every slot in a single column instead of wrapping.
    <View className={cn("flex-row flex-wrap -mx-space-4 md:-mx-space-8", rowGapClassName)}>
      {safeItems.map((item) => (
        <View key={keyExtractor(item)} className={slotClassName}>
          {renderItem(item)}
        </View>
      ))}
    </View>
  );
}
