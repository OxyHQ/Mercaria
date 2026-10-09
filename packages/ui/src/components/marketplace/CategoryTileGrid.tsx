import { useState, type ReactNode } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import type { CategoryTile } from "@mercaria/shared-types";
import { Text } from "../ui/text";

export interface CategoryShortcut {
  key: string;
  label: string;
  preview: ReactNode;
  onPress: () => void;
}

/** Published categories and optional browse destinations share the same grid. */
export function CategoryTileGrid({
  tiles,
  onPressTile,
  shortcuts = [],
  title,
}: {
  tiles: readonly CategoryTile[];
  onPressTile: (id: string, slug: string) => void;
  shortcuts?: readonly CategoryShortcut[];
  title?: string;
}) {
  const { width: viewport } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const columns = viewport >= 1024 ? 5 : viewport >= 640 ? 3 : 2;
  const gap = viewport >= 768 ? 16 : 12;
  const cardWidth =
    width > 0 ? (width - gap * (columns - 1)) / columns : undefined;
  if (!tiles.length && !shortcuts.length) return null;
  const renderTile = (
    key: string,
    label: string,
    onPress: () => void,
    preview: ReactNode,
  ) => (
    <Pressable
      key={key}
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        width: cardWidth,
        minHeight: cardWidth ? 68 + (cardWidth - 44) / 2 : undefined,
      }}
      className="group rounded-[20px] bg-black/[0.04] p-4 dark:bg-white/[0.06] web:transition-colors web:duration-150 web:hover:bg-black/[0.07] web:motion-reduce:transition-none"
    >
      <Text
        className="mb-3 text-base font-semibold text-foreground"
        numberOfLines={1}
      >
        {label}
      </Text>
      {preview}
    </Pressable>
  );
  return (
    <View className="mb-10 px-4 md:mb-16 lg:px-12">
      {title ? (
        <Text
          accessibilityRole="header"
          className="mb-4 text-[22px] font-bold leading-7 text-foreground"
        >
          {title}
        </Text>
      ) : null}
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        className="flex-row flex-wrap"
        style={{ gap }}
      >
        {tiles.map((tile) =>
          renderTile(
            tile.id,
            tile.name,
            () => onPressTile(tile.id, tile.slug),
            <View className="flex-row gap-3">
              {(tile.sampleImageUrls?.length
                ? tile.sampleImageUrls.slice(0, 2)
                : tile.imageUrl
                  ? [tile.imageUrl]
                  : []
              ).map((uri, index) => (
                <View
                  key={`${uri}-${index}`}
                  className="aspect-square flex-1 overflow-hidden rounded-xl bg-background"
                >
                  <Image
                    source={{ uri }}
                    contentFit="cover"
                    className="h-full w-full web:transition-transform web:duration-150 web:group-hover:scale-[1.03] web:motion-reduce:transition-none"
                  />
                </View>
              ))}
            </View>,
          ),
        )}
        {shortcuts.map((shortcut) =>
          renderTile(
            shortcut.key,
            shortcut.label,
            shortcut.onPress,
            shortcut.preview,
          ),
        )}
      </View>
    </View>
  );
}
