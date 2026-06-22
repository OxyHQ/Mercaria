/**
 * Category tree DTO for the Mercaria.
 *
 * `CategoryNode` is the recursive, tree-shaped projection returned by
 * `GET /categories` — each node may carry `children`. This is distinct from the
 * flat feed-card shapes (`Category`, `CategoryTile`, `CategoryPill`) in
 * `./product`, which exist purely to drive the home-feed carousels.
 */

/** A node in the category taxonomy tree. */
export interface CategoryNode {
  /** Stable category id. */
  id: string;
  /** Display name (e.g. "Dresses"). */
  name: string;
  /** URL slug (unique across the taxonomy). */
  slug: string;
  /** Parent category id, or `null` for a top-level category. */
  parentId: string | null;
  /** Optional resolvable image URL for the category. */
  imageUrl?: string;
  /** Direct child categories (omitted/empty for leaf nodes). */
  children?: CategoryNode[];
}
