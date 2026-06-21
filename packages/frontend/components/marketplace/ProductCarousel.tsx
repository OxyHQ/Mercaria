import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { Carousel } from "./Carousel";
import { ProductCard } from "./ProductCard";
import type { ProductSummary } from "./types";

/** Responsive breakpoints (px), measured against the carousel's own width. */
const SM_BREAKPOINT = 640;
const MD_BREAKPOINT = 768;
/** Gap between adjacent cards (kept in sync with the carousel's slot gap). */
const CARD_GAP = 12;
/** How many cards are visible at once per breakpoint (a fractional value lets
 *  the next card peek). Tuned to the reference: ~3.3 on phones, 3 at sm, 4 at md+. */
const PHONE_CARDS_VISIBLE = 3.3;
const TABLET_CARDS_VISIBLE = 3;
const DESKTOP_CARDS_VISIBLE = 4;

export interface ProductCarouselProps {
  items: ProductSummary[];
  /** Optional inline heading rendered above the row. */
  title?: string;
  onPressItem?: (id: string) => void;
  onToggleSaveItem?: (id: string, nextSaved: boolean) => void;
}

/**
 * Responsive card width from the MEASURED carousel width (passed by `Carousel`
 * via `onLayout`). Using the carousel's real on-screen width — not the window
 * width — keeps cards correctly sized when a sidebar narrows the content area.
 */
function computeItemWidth(carouselWidth: number): number {
  const visible =
    carouselWidth >= MD_BREAKPOINT
      ? DESKTOP_CARDS_VISIBLE
      : carouselWidth >= SM_BREAKPOINT
        ? TABLET_CARDS_VISIBLE
        : PHONE_CARDS_VISIBLE;
  return Math.floor(carouselWidth / visible - CARD_GAP);
}

/**
 * A horizontally scrollable row of product cards with a responsive item width.
 * The scroll + web-arrow behavior lives entirely in the generic `Carousel`;
 * this component only supplies the responsive width function and renders a
 * `ProductCard` per item.
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
        <Text className="px-4 pb-3 text-lg font-bold text-foreground">{title}</Text>
      ) : null}

      <Carousel
        items={items}
        keyExtractor={(product) => product.id}
        itemWidth={computeItemWidth}
        gap={CARD_GAP}
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
