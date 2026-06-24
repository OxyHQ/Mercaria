import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Custom font-size tokens defined in `global.css` `@theme` (Shopify type scale).
 * They MUST be registered with tailwind-merge so that `text-<token>` utilities
 * are recognized as members of the `font-size` class group — otherwise the
 * default base `text-base` is never dropped when a token overrides it.
 */
const FONT_SIZE_TOKENS = [
  "caption",
  "captionMedium",
  "captionBold",
  "badge",
  "badgeBold",
  "bodySmall",
  "body",
  "bodyTitleSmall",
  "bodyTitleLarge",
  "subtitle",
  "sectionTitle",
  "header",
  "headerBold",
  "buttonSmall",
  "buttonMedium",
  "buttonLarge",
];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: FONT_SIZE_TOKENS }],
    },
  },
});

/** Merge Tailwind / NativeWind class names, resolving conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
