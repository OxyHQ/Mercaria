import { View } from "react-native";
import { Carousel } from "./Carousel";
import { CategoryCard } from "./CategoryCard";
import type { Category, CategoryTile } from "@mercaria/shared-types";

/** Fixed slot width (px) for each category card in the carousel. */
const CATEGORY_CARD_WIDTH = 330;

export interface CategoryCarouselProps {
  categories: Category[];
  onPressCategory?: (id: string, slug: string) => void;
  onPressTile?: (categoryId: string, tile: CategoryTile) => void;
}

/**
 * A "shop by category" section: a horizontally scrollable row of `CategoryCard`s.
 * This section has no global heading — each card brings its own header. Reuses
 * the generic `Carousel`, so the scroll + web-arrow logic is shared, not
 * duplicated.
 */
export function CategoryCarousel({
  categories,
  onPressCategory,
  onPressTile,
}: CategoryCarouselProps) {
  return (
    <View className="mb-6">
      <Carousel
        items={categories ?? []}
        keyExtractor={(category) => category.id}
        itemWidth={CATEGORY_CARD_WIDTH}
        renderItem={(category) => (
          <CategoryCard
            category={category}
            onPressCategory={onPressCategory}
            onPressTile={onPressTile}
          />
        )}
      />
    </View>
  );
}
