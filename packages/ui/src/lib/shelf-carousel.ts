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

/** What every card shelf hands Bloom's `Carousel` beyond its own label. */
export type ShelfCarouselProps = Required<
  Pick<CarouselProps, "gap" | "showArrows" | "previousLabel" | "nextLabel" | "dotLabel" | "style">
>;

/**
 * The props every horizontal card shelf passes to `@oxy.so/bloom/carousel`.
 *
 * One place for three decisions, so the product, merchant and cart shelves
 * cannot drift apart:
 *
 * - **The copy is ours.** Bloom's arrow and dot names default to English, so
 *   they come from `@mercaria/ui`'s own bundles, in the viewer's language.
 * - **Arrows on web only.** A touch screen swipes; the shelves never drew
 *   arrows on native, and Bloom's would take a row above every shelf there.
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
      showArrows: isWeb,
      previousLabel: t(CAROUSEL_PREVIOUS_KEY),
      nextLabel: t(CAROUSEL_NEXT_KEY),
      dotLabel: (slide: number) => t(CAROUSEL_GO_TO_KEY, { position: slide }),
      style: { paddingHorizontal: SHELF_GUTTER },
    }),
    [gap, isWeb, t],
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
