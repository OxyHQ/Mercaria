/**
 * Deterministic per-category background colour for `CategorySampleTile`.
 *
 * `categories` has no colour column, and this plan adds none: there is no
 * operator surface to set one, so a column would be a field nobody could
 * ever fill. The colour is derived instead — a stable hash of the category
 * id picks one member of a fixed palette below, so the same category always
 * renders the same colour with no storage, no migration, and no admin UI
 * nobody asked for. The next person tempted to add a `categories.color`
 * column: this is why there isn't one.
 *
 * Every palette entry is chosen for contrast against `text-text-inverse`
 * (`CategorySampleTile`'s label is always inverse): each clears a WCAG
 * contrast ratio of at least 5.9:1 against white, comfortably past the
 * 4.5:1 "normal text" AA floor even though the label (`bodyTitleLarge`,
 * 18px/700) only needs 3:1 as "large text". One caveat this palette cannot
 * close statically: `text-inverse` resolves to Bloom's `--background`
 * custom property, which is white in Mercaria's default light theme but is
 * a Bloom-managed, seed-dependent value in dark mode — not necessarily
 * white. Contrast is verified against white; it is not verified against
 * every Bloom theme/seed combination.
 */
const CATEGORY_PALETTE = [
  "#A6462D", // clay
  "#1E5F45", // forest
  "#1F3B63", // navy
  "#6A2E5C", // plum
  "#0F5E5A", // teal
  "#38316E", // indigo
  "#8C2F2F", // brick
  "#565E1E", // olive
] as const;

/**
 * Deterministic string hash (djb2). Only used to pick a stable palette
 * index — not a security or uniqueness primitive.
 */
function hashCategoryId(value: string): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return hash >>> 0;
}

/** The fixed background colour a category id always resolves to. */
export function categoryPaletteColor(categoryId: string): string {
  return CATEGORY_PALETTE[hashCategoryId(categoryId) % CATEGORY_PALETTE.length];
}
