import { useWindowDimensions, View } from "react-native";
import { Carousel, CarouselItem } from "@oxy.so/bloom/carousel";
import { Text } from "../ui/text";
import { ProductCard } from "./ProductCard";
import type { ProductSummary } from "../../lib/format";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import { CAROUSEL_PRODUCTS_KEY } from "../../lib/marketplace-labels";
import { uniqueByKey, useShelfCarouselProps } from "../../lib/shelf-carousel";

/** Product-card slot width (px) on phones. */
const PRODUCT_SLOT_WIDTH = 154;
/** Product-card slot width (px) from `md` up. */
const PRODUCT_SLOT_WIDTH_MD = 192;
/** Tailwind's `md` breakpoint, where the slot widens. */
const MD_BREAKPOINT = 768;

export interface ProductCarouselProps {
  items: ProductSummary[];
  /** Optional inline heading rendered above the row. */
  title?: string;
  onPressItem?: (id: string) => void;
  onToggleSaveItem?: (id: string, nextSaved: boolean) => void;
}

/**
 * A horizontally scrollable row of product cards on Bloom's `Carousel`: 154px
 * slots on phones, 192px from md up. Returns `null` when there are no items or
 * they are unavailable, so neither the optional heading nor the carousel's
 * arrows paint over an empty row — safe to render always.
 */
export function ProductCarousel({
  items,
  title,
  onPressItem,
  onToggleSaveItem,
}: ProductCarouselProps) {
  const t = useSharedUiTranslation();
  const shelf = useShelfCarouselProps();
  const { width } = useWindowDimensions();
  const products = uniqueByKey(items, (product) => product.id);
  if (products.length === 0) return null;

  const slotWidth = width >= MD_BREAKPOINT ? PRODUCT_SLOT_WIDTH_MD : PRODUCT_SLOT_WIDTH;

  return (
    <View>
      {title ? (
        <Text className="px-4 pb-3 text-lg font-semibold text-foreground md:px-5 md:text-[22px] md:font-bold md:leading-7">
          {title}
        </Text>
      ) : null}

      <Carousel {...shelf} accessibilityLabel={title ?? t(CAROUSEL_PRODUCTS_KEY)}>
        {products.map((product) => (
          <CarouselItem key={product.id} width={slotWidth}>
            <ProductCard
              product={product}
              onPress={onPressItem}
              onToggleSave={onToggleSaveItem}
            />
          </CarouselItem>
        ))}
      </Carousel>
    </View>
  );
}
