import { View } from "react-native";
import { Text } from "../ui/text";
import { Carousel } from "./Carousel";
import { ProductCard } from "./ProductCard";
import type { ProductSummary } from "../../lib/format";

/** Fixed, responsive product-card slot width (Shop sizes cards by class, not
 *  by layout math): 154px on phones, 192px from md up. The inter-card gap is
 *  owned by the Carousel's content container (gap-2 web:sm:gap-4). */
const PRODUCT_SLOT_CLASS = "w-[154px] md:w-[192px]";

export interface ProductCarouselProps {
  items: ProductSummary[];
  /** Optional inline heading rendered above the row. */
  title?: string;
  onPressItem?: (id: string) => void;
  onToggleSaveItem?: (id: string, nextSaved: boolean) => void;
}

/**
 * A horizontally scrollable row of product cards. Card width is fixed by
 * Tailwind classes (no JS measuring); the scroll + web-arrow behavior lives
 * entirely in the generic `Carousel`.
 */
export function ProductCarousel({
  items,
  title,
  onPressItem,
  onToggleSaveItem,
}: ProductCarouselProps) {
  return (
    <View>
      {title ? (
        <Text className="px-4 pb-3 text-lg font-semibold text-foreground md:px-5 md:text-[22px] md:font-bold md:leading-7">
          {title}
        </Text>
      ) : null}

      <Carousel
        items={items}
        keyExtractor={(product) => product.id}
        slotClassName={PRODUCT_SLOT_CLASS}
        renderItem={(product) => (
          <ProductCard
            product={product}
            onPress={onPressItem}
            onToggleSave={onToggleSaveItem}
          />
        )}
      />
    </View>
  );
}
