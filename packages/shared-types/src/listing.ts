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
import type { ConnectorProviderId } from './integration';

/**
 * Provenance of a listing imported/synced from an external commerce platform.
 * Present only on connector-sourced listings; native Mercaria listings omit it.
 * The `{ connectionId, externalId }` pair is the upsert key for re-sync.
 */
export interface ListingSource {
  /** The `Connection` this listing was imported through. */
  connectionId: string;
  /** External platform the listing originates from. */
  provider: ConnectorProviderId;
  /** The listing's id on the external platform. */
  externalId: string;
  /** ISO-8601 `updated_at` reported by the external platform at last sync. */
  externalUpdatedAt?: string;
}

/** Condition of the item being sold. */
export type ListingCondition = 'new' | 'used';

/**
 * Lifecycle status of a listing.
 *
 * `restricted` is a MODERATION status and is the one value a seller can neither
 * set nor clear — see {@link SellerSettableListingStatus}. It is applied only by
 * `ModerationEnforcementService` carrying out a CrowdSource decision, and lifted
 * only by a `restore` from a later one.
 *
 * It needs no query changes to take effect. Every catalogue read filters
 * `status: 'active'` (feed, search, collections, store pages), the cart marks a
 * non-active line `stale`, and checkout refuses stale lines — so this single
 * value delists the item AND makes it unsellable, and the seller's real status
 * survives underneath in `moderation.restrictedFromStatus` for the restore.
 */
export type ListingStatus = 'draft' | 'active' | 'sold' | 'archived' | 'restricted';

/**
 * The statuses a seller may move their OWN listing between.
 *
 * `restricted` is deliberately absent, and that absence is load-bearing rather
 * than tidy typing: `catalog-write.service.updateListing` assigns `patch.status`
 * straight onto the document, so a union that included it would let a seller both
 * restrict a rival's listing shape and — far worse — lift a moderation
 * restriction on their own by PATCHing `status: 'active'`. The type keeps it out
 * of the payload; `assertSellerSettableStatus` in the service keeps it out at
 * runtime, because a type is erased and the escape is silent.
 */
export type SellerSettableListingStatus = Exclude<ListingStatus, 'restricted'>;

/** The statuses a seller may set, as a runtime list for validation. */
export const SELLER_SETTABLE_LISTING_STATUSES: readonly SellerSettableListingStatus[] = [
  'draft',
  'active',
  'sold',
  'archived',
];

/**
 * EVERY listing status, as a runtime list — the Mongo schema enum reads THIS.
 *
 * It exists because the obvious alternative silently drifted. The model declared
 * its own `const STATUSES: readonly ListingStatus[] = [...]`, and a hand-written
 * SUBSET satisfies that type perfectly — so when `restricted` was added to the
 * union, tsc had no complaint and the schema enum simply never learned about it.
 *
 * The failure that produced was nastier than a rejected write: enforcement sets
 * the status with `updateOne`, which does NOT run validators, so restricting a
 * listing worked. But `catalog-write.service.updateListing` ends in
 * `listing.save()`, which validates the whole document — so a seller editing the
 * TITLE of a restricted listing got a validation error about a status they never
 * touched and could not see.
 *
 * Reading one list in both places makes that unrepresentable rather than merely
 * tested for. Same convention as `ALL_CURRENCY_CODES` and the `MoneySchema` enum.
 */
export const ALL_LISTING_STATUSES: readonly ListingStatus[] = [
  'draft',
  'active',
  'sold',
  'archived',
  'restricted',
];

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
  /** Manufacturer/brand (store products). */
  vendor?: string;
  /** Merchandising product type (store products). */
  productType?: string;
  /** URL-safe handle (store products); unique per store. */
  handle?: string;
  /** SEO overrides (store products). */
  seo?: { title?: string; description?: string };
  /** Collection ids this listing belongs to (store products). */
  collectionIds?: string[];
  /** Connector provenance — present only on listings synced from an external platform. */
  source?: ListingSource;
  /**
   * Field names locally edited on a connector-sourced listing and therefore
   * PINNED against connector re-sync overwrites (see `SyncSettings.conflictPolicy`).
   */
  overriddenFields?: string[];
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
  /** Barcode (UPC/EAN/ISBN, etc.). */
  barcode?: string;
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
  /** Manufacturer/brand. */
  vendor?: string;
  /** Merchandising product type. */
  productType?: string;
  /** URL-safe handle (unique per store). */
  handle?: string;
  /** SEO overrides. */
  seo?: { title?: string; description?: string };
}

/** Partial payload accepted when updating an existing listing. */
export type UpdateListingInput = Partial<CreateP2PListingInput> & {
  /**
   * Seller-settable statuses only — a client can never ask for `restricted`, nor
   * PATCH its way out of one. See {@link SellerSettableListingStatus}.
   */
  status?: SellerSettableListingStatus;
  /** Manufacturer/brand (store products). */
  vendor?: string;
  /** Merchandising product type (store products). */
  productType?: string;
  /** URL-safe handle (store products); unique per store. */
  handle?: string;
  /** SEO overrides (store products). */
  seo?: { title?: string; description?: string };
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
  /** Restrict to a single vendor/brand. */
  vendor?: string;
  /** Restrict to a single product type. */
  productType?: string;
  /** Restrict to listings in a single collection. */
  collectionId?: string;
  /** Geo radius filter (P2P proximity browse). */
  near?: { lng: number; lat: number; radiusM: number };
  /** Restrict to listings with available stock. */
  inStock?: boolean;
  /** Opaque cursor for the infinite `newest` browse path. */
  cursor?: string;
  /** Sort order for the result set. */
  sort?: 'newest' | 'price_asc' | 'price_desc';
}
