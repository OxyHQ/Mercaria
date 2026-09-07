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
 * contrast ratio of at least 5.9:1 against WHITE, comfortably past the
 * 4.5:1 "normal text" AA floor even though the label (`bodyTitleLarge`,
 * 18px/700) only needs 3:1 as "large text".
 *
 * **This is a stated limit, not a guarantee that holds everywhere.**
 * `text-inverse` resolves to Bloom's `--background` custom property, which is
 * white in Mercaria's default light theme but a Bloom-managed, seed- and
 * mode-dependent value otherwise — a dark-seeded theme's `--background` is
 * not necessarily white, or even light. The contrast guarantee above holds
 * against a LIGHT background; a dark-seeded theme is NOT covered by it. This
 * module has no business reading the active seed at runtime to compensate —
 * that would make a "pure function of an id" secretly depend on global
 * theme state, which is a worse defect than an unverified dark-mode contrast.
 * Closing this gap, if it needs closing, is a decision for whoever owns
 * theme/seed selection, not a fix to bury here.
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
