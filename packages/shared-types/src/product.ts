/**
 * Product/merchant browse/feed DTOs for the Mercaria home feed.
 *
 * A `Feed` is an ordered list of `sections`, each discriminated by `kind`:
 * `'products'` sections hold a row of `ProductSummary` cards, `'merchants'`
 * sections hold a row of `MerchantSummary` (shop) cards, and `'categories'`
 * sections hold a row of `Category` cards (each card a header + 2×2 subcategory
 * grid). These are the canonical server-serialized shapes consumed directly by
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

/** A compact product reference shown as a thumbnail inside a merchant card. */
export interface ProductThumbnail {
  /** Stable product id (links to the product). */
  id: string;
  /** Product title (for accessibility / alt text). */
  title: string;
  /** Resolvable square thumbnail image URL. */
  imageUrl: string;
}

/** Text/foreground tone to use over a merchant's cover/brand color. */
export type TextTone = 'light' | 'dark';

/** A merchant (shop) as summarized for the home feed's merchant carousel. */
export interface MerchantSummary {
  /** Stable merchant id. */
  id: string;
  /** Merchant handle (without leading @), used to build the `/m/<handle>` route. */
  handle: string;
  /** Display name of the shop. */
  name: string;
  /** Optional white logo/wordmark PNG (resolvable URL) shown over the cover. */
  logoUrl?: string;
  /** Cover image filling the card background (object-cover). */
  coverImageUrl: string;
  /** Solid brand color behind/over the cover (full CSS color string, e.g. `#1D4ED8`). */
  brandColor: string;
  /** Average rating, 0–5. */
  rating: number;
  /** Number of reviews contributing to `rating`. */
  reviewCount: number;
  /** Which text tone reads best over this merchant's brand color/cover. */
  textTone: TextTone;
  /** 2–3 featured product thumbnails shown along the bottom of the card. */
  products: ProductThumbnail[];
}

/** A single subcategory tile inside a category card's 2×2 grid. */
export interface CategoryTile {
  /** Stable tile id. */
  id: string;
  /** Display name (e.g. "Dresses"). */
  name: string;
  /** URL slug used to build the `/categories/<categoryId>/<slug>` route. */
  slug: string;
  /** Background image URL for the tile. */
  imageUrl: string;
}

/** A top-level category with a small grid of featured subcategories. */
export interface Category {
  /** Stable category id. */
  id: string;
  /** Display name (e.g. "Women"). */
  name: string;
  /** URL slug used to build the `/categories/<id>/<slug>` route. */
  slug: string;
  /** Featured subcategory tiles (exactly 4, shown as a 2×2 grid). */
  subcategories: CategoryTile[];
}

/** A home-feed section holding a row of product cards. */
export interface ProductFeedSection {
  kind: 'products';
  /** Stable section id (slug, e.g. `new-arrivals`). */
  id: string;
  /** Human-readable section heading. */
  title: string;
  /** Ordered products in this section. */
  products: ProductSummary[];
}

/** A home-feed section holding a row of merchant (shop) cards. */
export interface MerchantFeedSection {
  kind: 'merchants';
  /** Stable section id (slug, e.g. `worth-the-hype`). */
  id: string;
  /** Human-readable section heading. */
  title: string;
  /** Ordered merchants in this section. */
  merchants: MerchantSummary[];
}

/** A home-feed section holding a row of category cards (each card brings its own header). */
export interface CategoryFeedSection {
  kind: 'categories';
  /** Stable section id. */
  id: string;
  /** Ordered categories in this section. */
  categories: Category[];
}

/** A single home-feed section, discriminated by `kind`. */
export type FeedSection = ProductFeedSection | MerchantFeedSection | CategoryFeedSection;

/** The home feed: an ordered list of sections rendered top-to-bottom. */
export interface Feed {
  /** Ordered sections rendered top-to-bottom on the home screen. */
  sections: FeedSection[];
}
