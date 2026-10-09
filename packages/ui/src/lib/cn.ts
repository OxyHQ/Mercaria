import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Custom font-size tokens defined in `shop-typography.css` (Shopify type scale).
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
  "heroBold",
  "buttonSmall",
  "buttonMedium",
  "buttonLarge",
  "posterXS",
];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: FONT_SIZE_TOKENS.flatMap((token) => [token, `shop-${token}`]) }],
      "font-weight": [{ font: FONT_SIZE_TOKENS.map((token) => `shop-${token}`) }],
    },
  },
});

/** Merge Tailwind / NativeWind class names, resolving conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
