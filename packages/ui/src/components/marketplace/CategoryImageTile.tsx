import { View, Pressable } from "react-native";
import { Image } from "expo-image";
import { Text } from "../ui/text";
import type { CategoryTile } from "@mercaria/shared-types";

export interface CategoryImageTileProps {
  tile: CategoryTile;
  onPress?: (tile: CategoryTile) => void;
}

/**
 * A browse-category grid tile: a responsive-height cover image, a fixed dark
 * scrim, and a centered light label. Renders BOTH a small and a large label
 * and hides one per breakpoint (`md:hidden` / `hidden md:flex`) rather than
 * switching size with a JS media query — deliberate duplication, not
 * redundancy to clean up. One press target — the whole tile is the link.
 */
export function CategoryImageTile({ tile, onPress }: CategoryImageTileProps) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={tile.name}
      onPress={() => onPress?.(tile)}
      className="relative flex-1 overflow-hidden rounded-radius-16 h-[72px] md:h-[84px] lg:h-[100px] xl:h-[112px]"
    >
      <View className="group relative flex-1">
        {tile.imageUrl ? (
          <View
            pointerEvents="none"
            className="absolute inset-0 web:transition-transform web:group-hover:scale-105"
          >
            <Image source={{ uri: tile.imageUrl }} contentFit="cover" className="z-0 size-full" />
          </View>
        ) : (
          <View className="flex-1 bg-bg-fill-tertiary" />
        )}

        <View pointerEvents="none" className="absolute inset-0 bg-bg-overlay-fixed-dark-20" />

        <View
          pointerEvents="none"
          className="absolute inset-0 z-10 items-center justify-center p-space-8"
        >
          <Text
            numberOfLines={1}
            className="text-center font-bodyTitleSmall text-bodyTitleSmall text-text-fixed-light md:hidden"
          >
            {tile.name}
          </Text>
          <Text
            numberOfLines={1}
            className="hidden text-center font-bodyTitleLarge text-bodyTitleLarge text-text-fixed-light md:flex"
          >
            {tile.name}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
