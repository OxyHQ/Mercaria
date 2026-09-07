import { View, Pressable } from "react-native";
import { Image } from "expo-image";
import { Text } from "../ui/text";
import type { CategoryTile } from "@mercaria/shared-types";

/**
 * Multi-stop pill shadow (web `boxShadow`) — the reference's
 * `feed-action-card-pill` elevation: a thin white inset highlight along the
 * top edge, a 1px dark hairline, and a soft drop shadow. Same technique
 * `IncentiveHalo` already uses.
 */
const PILL_SHADOW =
  "rgba(255,255,255,0.2) 0 1px 0 0 inset, rgba(0,0,0,0.12) 0 0 1px 0, rgba(0,0,0,0.12) 0 4px 8px 0";

export interface CategoryPillProps {
  tile: CategoryTile;
  onPress?: (tile: CategoryTile) => void;
}

/**
 * A single "browse category" pill: a round category image beside its name,
 * inside a rounded-full elevated chip. One press target — the whole pill is
 * the link.
 *
 * The reference names no root fill for this chip; `bg-bg-fill` is added here
 * so the multi-stop shadow (and its white inset highlight) reads against a
 * surface rather than the page background, matching every other elevated
 * card in this file.
 */
export function CategoryPill({ tile, onPress }: CategoryPillProps) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={tile.name}
      onPress={() => onPress?.(tile)}
      className="relative min-w-0 rounded-radius-max bg-bg-fill p-space-12 pb-space-4 ps-space-4 pt-space-4 font-buttonMedium text-buttonMedium web:active:scale-[0.99]"
      style={{ boxShadow: PILL_SHADOW }}
    >
      <View className="flex-row items-center gap-space-8">
        <View className="size-space-32 shrink-0 overflow-hidden rounded-full border-[0.5px] border-border-image">
          {tile.imageUrl ? (
            <Image source={{ uri: tile.imageUrl }} contentFit="cover" className="size-full" />
          ) : (
            <View className="size-full bg-bg-fill-tertiary" />
          )}
        </View>
        <Text numberOfLines={1} className="font-buttonMedium text-buttonMedium">
          {tile.name}
        </Text>
      </View>
    </Pressable>
  );
}
