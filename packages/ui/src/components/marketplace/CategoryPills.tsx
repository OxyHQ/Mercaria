import { View, Pressable, ScrollView } from "react-native";
import { Image } from "expo-image";
import { Text } from "../ui/text";
import type { CategoryPill } from "@mercaria/shared-types";

/** Horizontal gap (px) between adjacent chips. */
const CHIP_GAP = 8;
/** Horizontal padding (px) of the scroll content. */
const CONTENT_PADDING = 16;

export interface CategoryPillsProps {
  pills: CategoryPill[];
  /** Optional navigation handler (the `/categories/<id>` route does not exist yet). */
  onPressPill?: (id: string, slug: string) => void;
}

/**
 * A single horizontal, scrollable row of category "chip" pills (a small round
 * image + the category name, in a rounded-full bordered chip), shown at the very
 * top of the home feed. Chips size to their content, so a plain horizontal
 * `ScrollView` is used rather than the fixed-width `Carousel`. Fully theme/token
 * based.
 */
export function CategoryPills({ pills, onPressPill }: CategoryPillsProps) {
  return (
    <View className="mb-6">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: CONTENT_PADDING, gap: CHIP_GAP }}
      >
        {(pills ?? []).map((pill) => (
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
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={pill.name}
      onPress={() => onPressPill?.(pill.id, pill.slug)}
      className="h-11 flex-row items-center gap-2 rounded-full bg-secondary py-2 pl-1.5 pr-3"
    >
      {/* Round 32px category image with a 1px border ring. */}
      <View className="relative h-8 w-8 overflow-hidden rounded-full bg-secondary">
        <Image
          source={{ uri: pill.imageUrl }}
          contentFit="cover"
          className="h-8 w-8 rounded-full"
        />
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
