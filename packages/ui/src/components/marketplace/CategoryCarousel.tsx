import { View } from "react-native";
import { Carousel } from "./Carousel";
import { CategoryCard } from "./CategoryCard";
import type { Category, CategoryTile } from "@mercaria/shared-types";

/** Fixed category-card slot width via Tailwind class (no JS measuring). The
 *  inter-card gap is owned by the Carousel's content container. */
const CATEGORY_SLOT_CLASS = "w-[330px]";

export interface CategoryCarouselProps {
  categories: Category[];
  onPressCategory?: (id: string, slug: string) => void;
  onPressTile?: (categoryId: string, tile: CategoryTile) => void;
}

/**
 * A "shop by category" section: a horizontally scrollable row of `CategoryCard`s.
 * This section has no global heading — each card brings its own header. Reuses
 * the generic `Carousel`, so the scroll + web-arrow logic is shared, not
 * duplicated. Returns `null` when there are no categories or they are
 * unavailable, so the section leaves no gap behind — safe to render always.
 */
export function CategoryCarousel({
  categories,
  onPressCategory,
  onPressTile,
}: CategoryCarouselProps) {
  if (!categories || categories.length === 0) return null;

  return (
    <View className="mb-6">
      <Carousel
        items={categories}
        keyExtractor={(category) => category.id}
        slotClassName={CATEGORY_SLOT_CLASS}
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
