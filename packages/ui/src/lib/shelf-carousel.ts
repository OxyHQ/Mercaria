import { useMemo } from "react";
import { Platform, useWindowDimensions } from "react-native";
import type { CarouselProps } from "@oxy.so/bloom/carousel";
import { useSharedUiTranslation } from "../i18n/ui-translation";
import {
  CAROUSEL_GO_TO_KEY,
  CAROUSEL_NEXT_KEY,
  CAROUSEL_PREVIOUS_KEY,
} from "./marketplace-labels";

/** Width (px) from which the web inter-card gap steps up — Tailwind's `sm`. */
const WIDE_GAP_BREAKPOINT = 640;
/** Inter-card gap on phones and on native. */
const NARROW_GAP = 8;
/** Inter-card gap on web from `sm` up. */
const WIDE_GAP = 16;
/** The page gutter the shelves have always sat inside. */
const SHELF_GUTTER = 16;

const ARROW_CLASS_NAME = "min-h-0 min-w-0 rounded-radius-max border-[0.5px] border-border-image bg-bg-fill hover:bg-bg-fill-hover active:scale-[0.96] active:opacity-60 motion-reduce:active:scale-100";
const SHELF_ARROW_BUTTON_PROPS = {
  material: "flat",
  appearance: "outline",
  tone: "neutral",
  iconSize: 20,
  className: `${ARROW_CLASS_NAME} size-space-40 p-space-10 shadow-shop-m`,
} satisfies NonNullable<CarouselProps["arrowButtonProps"]>;

/** Shop's review-preview controls use 12px padding and a smaller shadow. */
export const REVIEW_PREVIEW_ARROW_BUTTON_PROPS = {
  ...SHELF_ARROW_BUTTON_PROPS,
  className: `${ARROW_CLASS_NAME} h-[44px] w-[44px] p-space-12 shadow-shop-s`,
} satisfies NonNullable<CarouselProps["arrowButtonProps"]>;

/** What every card shelf hands Bloom's `Carousel` beyond its own label. */
export type ShelfCarouselProps = Required<
  Pick<CarouselProps, "gap" | "showArrows" | "showDots" | "inset" | "previousLabel" | "nextLabel" | "dotLabel" | "arrowsPlacement" | "arrowButtonProps" | "hideUnavailableArrows">
>;

/**
 * The props every horizontal card shelf passes to `@oxy.so/bloom/carousel`.
 *
 * One place for three decisions, so the product, merchant and cart shelves
 * cannot drift apart:
 *
 * - **The copy is ours.** Bloom's arrow and dot names default to English, so
 *   they come from `@mercaria/ui`'s own bundles, in the viewer's language.
 * - **Overlay arrows from `sm` on web.** Phones and native use swipe. The
 *   40px flat outlined controls match Shop's Carousel, without a separate
 *   control row between the section heading and its cards. Bloom owns hiding
 *   unavailable arrows and moving focus when a focused arrow reaches an edge.
 * - **The gap is 8px, 16px from `sm` on web.** The step is web-only because the
 *   reference it was measured from is a web capture.
 *
 * The accessible name of the carousel itself is NOT here: it says which shelf
 * this is, and only the shelf knows that.
 */
export function useShelfCarouselProps(): ShelfCarouselProps {
  const t = useSharedUiTranslation();
  const { width } = useWindowDimensions();
  const isWeb = Platform.OS === "web";
  const gap = isWeb && width >= WIDE_GAP_BREAKPOINT ? WIDE_GAP : NARROW_GAP;
  return useMemo(
    () => ({
      gap,
      showArrows: isWeb && width >= WIDE_GAP_BREAKPOINT,
      showDots: false,
      arrowsPlacement: "overlay",
      hideUnavailableArrows: true,
      arrowButtonProps: SHELF_ARROW_BUTTON_PROPS,
      inset: isWeb && width >= 1024 ? 48 : SHELF_GUTTER,
      previousLabel: t(CAROUSEL_PREVIOUS_KEY),
      nextLabel: t(CAROUSEL_NEXT_KEY),
      dotLabel: (slide: number) => t(CAROUSEL_GO_TO_KEY, { position: slide }),
    }),
    [gap, isWeb, width, t],
  );
}

/**
 * `items` without its repeated keys, keeping the first of each.
 *
 * Defensive on purpose: a partial/in-transition feed payload can hand a shelf
 * `undefined`, and a backend can return the same listing twice across
 * overlapping sections — which would otherwise crash on `.map` or on React's
 * duplicate-key check.
 */
export function uniqueByKey<T>(items: readonly T[] | undefined, keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return (items ?? []).filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
