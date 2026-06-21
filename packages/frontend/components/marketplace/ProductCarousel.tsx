import { useRef } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { ProductCard } from "./ProductCard";
import type { ProductSummary } from "./types";

/** Responsive breakpoints (px) for how many cards are visible at once. */
const SM_BREAKPOINT = 640;
const LG_BREAKPOINT = 1024;
/** Horizontal padding applied to the scroll content. */
const CONTENT_PADDING = 16;
/** Gap between adjacent cards. */
const CARD_GAP = 12;
/** Visible-card divisors per breakpoint (smaller = more cards peek). */
const PHONE_CARDS_VISIBLE = 2.4;
const TABLET_CARDS_VISIBLE = 3;
const DESKTOP_CARDS_VISIBLE = 4;
/** Arrow button icon size. */
const ARROW_ICON_SIZE = 20;

export interface ProductCarouselProps {
  items: ProductSummary[];
  /** Optional inline heading rendered above the row. */
  title?: string;
  onPressItem?: (id: string) => void;
  onToggleSaveItem?: (id: string, nextSaved: boolean) => void;
}

function computeItemWidth(viewportWidth: number): number {
  if (viewportWidth >= LG_BREAKPOINT) {
    return Math.floor(viewportWidth / DESKTOP_CARDS_VISIBLE - CARD_GAP);
  }
  if (viewportWidth >= SM_BREAKPOINT) {
    return Math.floor(viewportWidth / TABLET_CARDS_VISIBLE - CARD_GAP);
  }
  return Math.floor(viewportWidth / PHONE_CARDS_VISIBLE);
}

export function ProductCarousel({
  items,
  title,
  onPressItem,
  onToggleSaveItem,
}: ProductCarouselProps) {
  const { width } = useWindowDimensions();
  const { colors } = useColorScheme();
  const scrollRef = useRef<ScrollView>(null);
  // Mutable scroll metrics kept in refs so updating them never re-renders.
  const scrollX = useRef(0);
  const contentWidth = useRef(0);

  const itemWidth = computeItemWidth(width);
  const showArrows = Platform.OS === "web" && width >= SM_BREAKPOINT;

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollX.current = event.nativeEvent.contentOffset.x;
    contentWidth.current = event.nativeEvent.contentSize.width;
  };

  const scrollByViewport = (direction: 1 | -1) => {
    const maxX = Math.max(0, contentWidth.current - width);
    const nextX = Math.min(maxX, Math.max(0, scrollX.current + direction * width));
    scrollRef.current?.scrollTo({ x: nextX, animated: true });
  };

  return (
    <View className="relative">
      {title ? (
        <Text className="px-4 pb-3 text-lg font-bold text-foreground">{title}</Text>
      ) : null}

      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingHorizontal: CONTENT_PADDING }}
      >
        {items.map((item, index) => (
          <View
            key={item.id}
            style={{
              width: itemWidth,
              marginRight: index < items.length - 1 ? CARD_GAP : 0,
            }}
          >
            <ProductCard
              product={item}
              onPress={onPressItem}
              onToggleSave={onToggleSaveItem}
            />
          </View>
        ))}
      </ScrollView>

      {showArrows ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go to the previous item"
            onPress={() => scrollByViewport(-1)}
            className="absolute left-2 top-1/2 -mt-5 h-10 w-10 items-center justify-center rounded-full border border-border bg-card web:shadow"
          >
            <ChevronLeft size={ARROW_ICON_SIZE} color={colors.foreground} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go to the next item"
            onPress={() => scrollByViewport(1)}
            className="absolute right-2 top-1/2 -mt-5 h-10 w-10 items-center justify-center rounded-full border border-border bg-card web:shadow"
          >
            <ChevronRight size={ARROW_ICON_SIZE} color={colors.foreground} />
          </Pressable>
        </>
      ) : null}
    </View>
  );
}
