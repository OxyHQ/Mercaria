/**
 * Product browse/feed DTOs for the Mercaria home feed.
 *
 * A `Feed` is an ordered list of `Shelf` carousels, each holding `ProductSummary`
 * cards. These are the canonical server-serialized shapes consumed directly by
 * the frontend home screen.
 */

import type { Money } from './money';

/** A product as summarized for browse/feed cards. */
export interface ProductSummary {
  /** Stable product id. */
  id: string;
  /** Short product title. */
  title: string;
  /** Brand / seller short name shown above the title. */
  brand: string;
  /** Resolvable image URL for the product card. */
  imageUrl: string;
  /** Average rating, 0–5. */
  rating: number;
  /** Number of reviews contributing to `rating`. */
  reviewCount: number;
  /** Current asking price. */
  price: Money;
  /** Original price when the item is on sale (omitted when not discounted). */
  compareAtPrice?: Money;
  /** Whether the current viewer has saved/favorited this product. */
  saved?: boolean;
}

/** A titled, ordered group of products in the home feed (a carousel "shelf"). */
export interface Shelf {
  /** Stable shelf id (slug, e.g. `new-arrivals`). */
  id: string;
  /** Human-readable section heading. */
  title: string;
  /** Ordered products in this shelf. */
  products: ProductSummary[];
}

/** The home feed: an ordered list of shelves. */
export interface Feed {
  /** Ordered shelves rendered top-to-bottom on the home screen. */
  shelves: Shelf[];
}
