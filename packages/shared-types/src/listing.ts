/**
 * Listing DTO and its supporting enums for the Mercaria — the core domain
 * entity shared between the frontend and backend.
 */

import type { Timestamps } from './common';
import type { Money } from './money';
import type { Seller } from './seller';

/** Condition of the item being sold. */
export type ListingCondition = 'new' | 'used';

/** Lifecycle status of a listing. */
export type ListingStatus = 'draft' | 'active' | 'sold' | 'archived';

/** A single image attached to a listing. */
export interface ListingImage {
  /** Oxy media file id, resolvable via the media CDN. */
  fileId: string;
  /** Optional alt text for accessibility. */
  alt?: string;
  /** Display order within the listing gallery (0-based). */
  position: number;
}

/**
 * A marketplace listing: an item a seller has put up for sale.
 *
 * This is the canonical server-serialized DTO consumed directly by the
 * frontend — display fields (e.g. `seller`) are denormalized so the client
 * renders without follow-up requests.
 */
export interface Listing extends Timestamps {
  /** Stable listing id. */
  id: string;
  /** Short, human-readable title. */
  title: string;
  /** Full description (plain text or markdown, per product decision). */
  description: string;
  /** Asking price. */
  price: Money;
  /** Condition of the item. */
  condition: ListingCondition;
  /** Lifecycle status. */
  status: ListingStatus;
  /** Category slug the listing belongs to (e.g. `electronics`). */
  category: string;
  /** Ordered gallery images. */
  images: ListingImage[];
  /** Denormalized seller identity. */
  seller: Seller;
  /** Free-form search tags. */
  tags: string[];
  /** Available quantity (defaults to 1 for single-item listings). */
  quantity: number;
}

/** Payload accepted when creating a new listing. */
export interface CreateListingInput {
  title: string;
  description: string;
  price: Money;
  condition: ListingCondition;
  category: string;
  /** Oxy media file ids for the gallery, in display order. */
  imageFileIds: string[];
  tags?: string[];
  quantity?: number;
}

/** Partial payload accepted when updating an existing listing. */
export type UpdateListingInput = Partial<CreateListingInput> & {
  status?: ListingStatus;
};

/** Filter/sort parameters accepted by the listing search endpoint. */
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
  /** Sort order for the result set. */
  sort?: 'newest' | 'price_asc' | 'price_desc';
}
