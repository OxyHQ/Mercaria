import { useRef, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import { cn } from "@/lib/utils";

/** Horizontal padding applied to the scroll content. */
const DEFAULT_CONTENT_PADDING = 16;
/** Fraction of the viewport to scroll per arrow press (keeps a little context). */
const PAGE_FRACTION = 0.9;
/** Arrow button icon size. */
const ARROW_ICON_SIZE = 20;

export interface CarouselProps<T> {
  /** Items rendered left-to-right in the horizontal scroller. */
  items: T[];
  /** Stable React key for each item. */
  keyExtractor: (item: T) => string;
  /** Renders a single item; the slot around it is sized by `slotClassName`. */
  renderItem: (item: T) => ReactNode;
  /**
   * Tailwind classes that set each slot's FIXED, responsive width (and any
   * inter-item gap). No JS measuring — the width is purely class-driven, e.g.
   * `"w-[154px] md:w-[192px] mr-3"`. (Shop sizes cards by class, not by layout
   * math.)
   */
  slotClassName: string;
  /** Horizontal padding of the scroll content, in px. */
  contentPadding?: number;
  /**
   * Whether to render web edge arrows. When omitted, arrows show on web only.
   */
  showArrows?: boolean;
}

/**
 * Generic, presentational horizontal carousel. Holds the ONLY copy of the
 * scroll + web-arrow logic shared by the product/merchant/category carousels —
 * no business logic, no card-type knowledge, fully theme/token based.
 *
 * Item width is set entirely by `slotClassName` (fixed responsive Tailwind
 * classes) — the carousel does NOT measure the viewport to size cards. The web
 * arrows DO read the scroller's own width (via a ref captured on layout) to
 * compute the scroll distance on press — that's scroll mechanics, not layout
 * sizing.
 */
export function Carousel<T>({
  items,
  keyExtractor,
  renderItem,
  slotClassName,
  contentPadding = DEFAULT_CONTENT_PADDING,
  showArrows,
}: CarouselProps<T>) {
  const { colors } = useColorScheme();
  const scrollRef = useRef<ScrollView>(null);
  // Mutable scroll metrics kept in refs so updating them never re-renders.
  const scrollX = useRef(0);
  const contentWidth = useRef(0);
  const viewportWidth = useRef(0);

  // Defensive: tolerate an undefined `items` (partial/in-transition feed data)
  // so the carousel never crashes on `.map`.
  const safeItems = items ?? [];

  const arrowsEnabled = showArrows ?? Platform.OS === "web";

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollX.current = event.nativeEvent.contentOffset.x;
    contentWidth.current = event.nativeEvent.contentSize.width;
  };

  const handleLayout = (event: LayoutChangeEvent) => {
    // Capture the scroller's own width for the arrow scroll distance only. This
    // is NOT used to size cards (those are fixed via `slotClassName`).
    viewportWidth.current = event.nativeEvent.layout.width;
  };

  const scrollByViewport = (direction: 1 | -1) => {
    const viewport = viewportWidth.current;
    const maxX = Math.max(0, contentWidth.current - viewport);
    const delta = viewport * PAGE_FRACTION;
    const nextX = Math.min(maxX, Math.max(0, scrollX.current + direction * delta));
    scrollRef.current?.scrollTo({ x: nextX, animated: true });
  };

  return (
    <View className="relative" onLayout={handleLayout}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onContentSizeChange={(w) => {
          contentWidth.current = w;
        }}
        contentContainerStyle={{ paddingHorizontal: contentPadding }}
      >
        {safeItems.map((item) => (
          <View key={keyExtractor(item)} className={cn("shrink-0", slotClassName)}>
            {renderItem(item)}
          </View>
        ))}
      </ScrollView>

      {arrowsEnabled ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go to the previous item"
            onPress={() => scrollByViewport(-1)}
            className="absolute left-2 top-1/2 -mt-5 hidden h-10 w-10 items-center justify-center rounded-full border border-border bg-card web:flex web:shadow"
          >
            <ChevronLeft size={ARROW_ICON_SIZE} color={colors.foreground} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go to the next item"
            onPress={() => scrollByViewport(1)}
            className="absolute right-2 top-1/2 -mt-5 hidden h-10 w-10 items-center justify-center rounded-full border border-border bg-card web:flex web:shadow"
          >
            <ChevronRight size={ARROW_ICON_SIZE} color={colors.foreground} />
          </Pressable>
        </>
      ) : null}
    </View>
  );
}
