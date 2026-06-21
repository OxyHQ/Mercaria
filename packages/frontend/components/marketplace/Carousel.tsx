import { useRef, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useColorScheme } from "@/lib/useColorScheme";

/** Breakpoint (px) at/above which web edge arrows are shown by default. */
const SM_BREAKPOINT = 640;
/** Horizontal padding applied to the scroll content. */
const DEFAULT_CONTENT_PADDING = 16;
/** Gap between adjacent items. */
const DEFAULT_GAP = 12;
/** Fraction of the viewport to scroll per arrow press (keeps a little context). */
const PAGE_FRACTION = 0.9;
/** Arrow button icon size. */
const ARROW_ICON_SIZE = 20;

export interface CarouselProps<T> {
  /** Items rendered left-to-right in the horizontal scroller. */
  items: T[];
  /** Stable React key for each item. */
  keyExtractor: (item: T) => string;
  /** Renders a single item; the carousel owns the fixed-width slot around it. */
  renderItem: (item: T) => ReactNode;
  /**
   * Pixel width per item. Either a fixed number (e.g. merchant hero cards), or a
   * function of the MEASURED carousel width — use the function form for
   * responsive product cards so sizing is based on the real on-screen carousel
   * area (which is narrower than the window when a sidebar is present), not the
   * window width.
   */
  itemWidth: number | ((measuredWidth: number) => number);
  /** Gap between adjacent items, in px. */
  gap?: number;
  /** Horizontal padding of the scroll content, in px. */
  contentPadding?: number;
  /**
   * Whether to render web edge arrows. When omitted, the carousel decides:
   * `Platform.OS === 'web' && measuredWidth >= 640`.
   */
  showArrows?: boolean;
}

/**
 * Generic, presentational horizontal carousel. Holds the ONLY copy of the
 * scroll + web-arrow logic shared by the product and merchant carousels — no
 * business logic, no card-type knowledge, fully theme/token based.
 *
 * Web arrows step ~90% of the MEASURED viewport. Viewport and content widths
 * are captured via `onLayout` / `onContentSizeChange` (with the window width as
 * a fallback) so the arrows move on the FIRST click, before any manual scroll
 * has populated the `onScroll` metrics.
 */
export function Carousel<T>({
  items,
  keyExtractor,
  renderItem,
  itemWidth,
  gap = DEFAULT_GAP,
  contentPadding = DEFAULT_CONTENT_PADDING,
  showArrows,
}: CarouselProps<T>) {
  const { width } = useWindowDimensions();
  const { colors } = useColorScheme();
  const scrollRef = useRef<ScrollView>(null);
  // Mutable scroll metrics kept in refs so updating them never re-renders.
  const scrollX = useRef(0);
  const contentWidth = useRef(0);
  const viewportWidth = useRef(0);
  // The MEASURED carousel width drives responsive item sizing, so it must live
  // in state (not just a ref) — the first render uses the window width as a
  // fallback, then re-renders once `onLayout` reports the real container width.
  const [measuredWidth, setMeasuredWidth] = useState(0);

  // Defensive: tolerate an undefined `items` (partial/in-transition feed data)
  // so the carousel never crashes on `.map`.
  const safeItems = items ?? [];

  // Use the measured carousel width when available; fall back to the window
  // width on the very first render (before the first layout pass).
  const sizingWidth = measuredWidth || width;
  const resolvedItemWidth =
    typeof itemWidth === "function" ? itemWidth(sizingWidth) : itemWidth;

  const arrowsEnabled =
    showArrows ?? (Platform.OS === "web" && sizingWidth >= SM_BREAKPOINT);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollX.current = event.nativeEvent.contentOffset.x;
    contentWidth.current = event.nativeEvent.contentSize.width;
  };

  const handleLayout = (event: LayoutChangeEvent) => {
    const layoutWidth = event.nativeEvent.layout.width;
    viewportWidth.current = layoutWidth;
    if (layoutWidth !== measuredWidth) {
      setMeasuredWidth(layoutWidth);
    }
  };

  const scrollByViewport = (direction: 1 | -1) => {
    // Use the measured viewport/content widths (captured via onLayout and
    // onContentSizeChange) so the arrows move on the FIRST click — before any
    // manual scroll has populated the onScroll metrics. Scroll ~90% of the
    // viewport so a little context carries over between pages.
    const viewport = viewportWidth.current || width;
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
        {safeItems.map((item, index) => (
          <View
            key={keyExtractor(item)}
            style={{
              width: resolvedItemWidth,
              marginRight: index < safeItems.length - 1 ? gap : 0,
            }}
          >
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
