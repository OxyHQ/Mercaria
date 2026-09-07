import { View, Pressable } from "react-native";
import { Image } from "expo-image";
import { Text } from "../ui/text";
import { categoryPaletteColor } from "../../lib/category-palette";
import type { CategoryTile } from "@mercaria/shared-types";

/** Exactly two sample-image slots, per the reference's `feed-action-card-tile-with-samples`. */
const SAMPLE_SLOTS = [0, 1] as const;

export interface CategorySampleTileProps {
  tile: CategoryTile;
  samples: readonly string[];
  onPress?: (tile: CategoryTile) => void;
}

/**
 * A "browse categories" tile: two square sample-image thumbnails sitting on a
 * flat per-category background colour ({@link categoryPaletteColor}), with the
 * category name pinned above them. One press target — the whole tile is the
 * link.
 *
 * `samples[0]`/`samples[1]` each branch on absence, same as every other image
 * in this file, even though the prop is typed as a plain string array: a
 * caller can still hand back fewer than two, and a missing sample draws the
 * placeholder rather than an empty `<Image>`.
 */
export function CategorySampleTile({ tile, samples, onPress }: CategorySampleTileProps) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={tile.name}
      onPress={() => onPress?.(tile)}
      className="group relative overflow-hidden flex-col gap-space-16 rounded-radius-24 p-space-16"
      style={{ backgroundColor: categoryPaletteColor(tile.id) }}
    >
      {/* Hover wash (web only) — decorative, sits above the flat colour and
          below the label/samples below (both `relative` so they win the
          stacking order against this `absolute` layer on web). */}
      <View className="web:absolute web:inset-0 web:bg-overlay-fixed-dark-10 web:opacity-0 web:transition-opacity web:group-hover:opacity-100" />

      <Text
        numberOfLines={1}
        className="relative text-left text-bodyTitleLarge font-bodyTitleLarge text-text-inverse"
      >
        {tile.name}
      </Text>

      <View className="relative flex-row gap-space-12">
        {SAMPLE_SLOTS.map((slot) => {
          const sampleUrl = samples[slot];
          return (
            <View
              key={slot}
              className="aspect-square flex-1 overflow-hidden rounded-radius-16 border-[0.5px] border-border-secondary"
            >
              {sampleUrl ? (
                <Image
                  source={{ uri: sampleUrl }}
                  contentFit="cover"
                  className="size-full web:transition-transform web:group-hover:scale-105 web:motion-reduce:transition-none web:motion-reduce:group-hover:scale-100"
                />
              ) : (
                <View className="size-full bg-bg-fill-tertiary" />
              )}
            </View>
          );
        })}
      </View>
    </Pressable>
  );
}
