/**
 * Listing DTO and its supporting enums for the Mercaria — the core domain
 * entity shared between the frontend and backend.
 *
 * A `Listing` is the sellable product. It is owned EITHER by an individual P2P
 * seller (`ownerType: 'user'`, `seller` present) OR by a store
 * (`ownerType: 'store'`, `store` present). Its price fields are DERIVED from its
 * `variants`: `price` is the minimum ("from") price, `priceRange` spans
 * min→max, and `compareAtPrice` (when present) is the discount baseline of the
 * cheapest variant.
 */

import type { Timestamps } from './common';
import type { Money } from './money';
import type { Seller } from './seller';
import type { MerchantSummary } from './product';
import type { ProductVariantDTO } from './variant';

/** Condition of the item being sold. */
export type ListingCondition = 'new' | 'used';

/** Lifecycle status of a listing. */
export type ListingStatus = 'draft' | 'active' | 'sold' | 'archived';

/** Whether a listing is owned by an individual user or a store. */
export type ListingOwnerType = 'user' | 'store';

/** A single image attached to a listing. */
export interface ListingImage {
  /** Oxy media file id (or absolute URL), resolvable via the media CDN. */
  fileId: string;
  /** Optional alt text for accessibility. */
  alt?: string;
  /** Display order within the listing gallery (0-based). */
  position: number;
}

/** A selectable option (e.g. `Size`) and its allowed values. */
export interface ListingOption {
  /** Option name (e.g. `Size`). */
  name: string;
  /** Allowed values for the option (e.g. `['S', 'M', 'L']`). */
  values: string[];
}

/**
 * A marketplace listing: an item put up for sale by a user or a store.
 *
 * This is the canonical server-serialized DTO consumed directly by the
 * frontend — owner identity (`seller` / `store`), variants and derived price
 * fields are denormalized so the client renders without follow-up requests.
 */
export interface Listing extends Timestamps {
  /** Stable listing id. */
  id: string;
  /** Whether this listing is owned by a user or a store. */
  ownerType: ListingOwnerType;
  /** Short, human-readable title. */
  title: string;
  /** Full description (plain text or markdown, per product decision). */
  description: string;
  /** "From" price — the minimum variant price. */
  price: Money;
  /** Discount baseline of the cheapest variant, when on sale. */
  compareAtPrice?: Money;
  /** Min→max price span across all variants (present when variants exist). */
  priceRange?: { min: Money; max: Money };
  /** Concrete buyable SKUs. P2P listings have exactly one default variant. */
  variants: ProductVariantDTO[];
  /** Selectable options (empty for P2P listings). */
  options?: ListingOption[];
  /** Condition of the item. */
  condition: ListingCondition;
  /** Lifecycle status. */
  status: ListingStatus;
  /** Category slug the listing belongs to (e.g. `electronics`). */
  category: string;
  /** Ordered gallery images. */
  images: ListingImage[];
  /** Denormalized seller identity (present iff `ownerType === 'user'`). */
  seller?: Seller;
  /** Denormalized store identity (present iff `ownerType === 'store'`). */
  store?: MerchantSummary;
  /** Free-form search tags. */
  tags: string[];
  /** Total available quantity, summed across all variants. */
  quantity: number;
  /** Whether the current viewer has saved/favorited this listing. */
  saved?: boolean;
}

/** Payload accepted when an individual user creates a P2P (secondhand) listing. */
export interface CreateP2PListingInput {
  title: string;
  description: string;
  price: Money;
  condition: ListingCondition;
  category: string;
  /** Oxy media file ids for the gallery, in display order. */
  imageFileIds: string[];
  tags?: string[];
  /** Available quantity (defaults to 1 server-side). */
  quantity?: number;
}

/** A single variant supplied when a store creates a new product. */
export interface CreateStoreProductVariantInput {
  /** Option assignments that define this variant. */
  optionValues: { name: string; value: string }[];
  price: Money;
  compareAtPrice?: Money;
  sku?: string;
  inventory: {
    /** Whether stock is tracked (defaults true). */
    tracked?: boolean;
    /** Units available. */
    available: number;
  };
}

/** Payload accepted when a store creates a new product. */
export interface CreateStoreProductInput {
  title: string;
  description: string;
  category: string;
  /** Oxy media file ids for the gallery, in display order. */
  imageFileIds: string[];
  tags?: string[];
  /** Selectable options that the variants assign values for. */
  options: ListingOption[];
  /** Concrete variants for the product (at least one). */
  variants: CreateStoreProductVariantInput[];
}

/** Partial payload accepted when updating an existing listing. */
export type UpdateListingInput = Partial<CreateP2PListingInput> & {
  status?: ListingStatus;
};

/** Filter/sort parameters accepted by the listing search/browse endpoint. */
export interface ListingQuery {
  /** Full-text search term. */
  q?: string;
  /** Restrict to a single category slug. */
  category?: string;
  /** Restrict to a condition. */
  condition?: ListingCondition;
  /** Minimum price in minor units. */
  minPrice?: number;
  /** Maximum price in minor units. */
  maxPrice?: number;
  /** Restrict to a single store. */
  storeId?: string;
  /** Restrict to user-owned (P2P) or store-owned listings. */
  ownerType?: ListingOwnerType;
  /** Geo radius filter (P2P proximity browse). */
  near?: { lng: number; lat: number; radiusM: number };
  /** Restrict to listings with available stock. */
  inStock?: boolean;
  /** Opaque cursor for the infinite `newest` browse path. */
  cursor?: string;
  /** Sort order for the result set. */
  sort?: 'newest' | 'price_asc' | 'price_desc';
}
