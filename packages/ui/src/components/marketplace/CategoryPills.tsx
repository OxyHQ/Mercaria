import { useState } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { Image } from "expo-image";
import { Text } from "../ui/text";
import type { CategoryPill } from "@mercaria/shared-types";
import { ShopNavigationIcon } from "./ShopNavigationIcon";
import { useColorScheme } from "../../lib/useColorScheme";
import { categoryImageSource } from "../../lib/shop-category-images";

/** Horizontal gap (px) between adjacent chips. */
const CHIP_GAP = 8;
/** Horizontal padding (px) of the scroll content. */
const CONTENT_PADDING = 16;

export interface CategoryPillsProps {
  pills: CategoryPill[];
  /** Opens the published category by its slug, or id when no slug is available. */
  onPressPill?: (id: string, slug: string) => void;
}

/**
 * A single horizontal, scrollable row of category "chip" pills (a small round
 * image + the category name, in a rounded-full bordered chip), shown at the very
 * top of the home feed. Chips size to their content, so a plain horizontal
 * `ScrollView` is used rather than Bloom's snapping `Carousel`. Fully theme/token
 * based. Returns `null` when there are no pills or they are unavailable, so the
 * row leaves no gap behind — safe to render always.
 */
export function CategoryPills({ pills, onPressPill }: CategoryPillsProps) {
  if (!pills || pills.length === 0) return null;

  return (
    <View className="mb-6" testID="category-pills">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: CONTENT_PADDING, gap: CHIP_GAP, flexGrow: 1, justifyContent: "center" }}
      >
        {pills.map((pill) => (
          <CategoryPillChip key={pill.id} pill={pill} onPressPill={onPressPill} />
        ))}
      </ScrollView>
    </View>
  );
}

interface CategoryPillChipProps {
  pill: CategoryPill;
  onPressPill?: (id: string, slug: string) => void;
}

/**
 * One chip: a horizontal rounded-full pill (image left, label right) — a tag
 * with a small round avatar. The whole chip is one link; no nested interactives.
 */
function CategoryPillChip({ pill, onPressPill }: CategoryPillChipProps) {
  const { colors } = useColorScheme();
  const [failedUri, setFailedUri] = useState<string>();
  const imageUrl = pill.imageUrl?.trim();
  const showImage = Boolean(imageUrl && imageUrl !== failedUri);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={pill.name}
      onPress={() => onPressPill?.(pill.id, pill.slug)}
      className="h-11 flex-row items-center gap-2 rounded-full border border-border bg-card py-2 ps-1.5 pe-3 web:transition-colors web:duration-150 web:hover:bg-muted active:bg-muted web:motion-reduce:transition-none"
    >
      {/* Round 32px category image with a 1px border ring. */}
      <View className="relative h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-muted">
        {showImage && imageUrl ? (
          <Image
            testID="category-pill-image"
            source={categoryImageSource(imageUrl)}
            contentFit="cover"
            className="h-8 w-8 rounded-full"
            onError={() => setFailedUri(imageUrl)}
          />
        ) : (
          <View testID="category-pill-image-fallback">
            <ShopNavigationIcon name="explore" size={18} fill={colors.foreground} />
          </View>
        )}
        <View
          pointerEvents="none"
          className="absolute inset-0 rounded-full border border-border"
        />
      </View>
      <Text numberOfLines={1} className="text-sm font-medium text-foreground">
        {pill.name}
      </Text>
    </Pressable>
  );
}
