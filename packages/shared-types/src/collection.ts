/**
 * Collection DTOs for the Mercaria store-admin merchandising surface.
 *
 * A `Collection` groups a store's products. MANUAL collections hold an ordered,
 * hand-picked `productIds` list; AUTOMATED collections derive membership from a
 * set of `rules` evaluated against each product's denormalized fields (title,
 * vendor, productType, tags, category, price, inventory). Membership is
 * materialized onto each `Listing.collectionIds`, so collection browse runs off
 * an indexed listing field without joining the collection on every query.
 */

import type { Timestamps } from './common';

/** Whether a collection's membership is hand-picked or rule-derived. */
export type CollectionType = 'manual' | 'automated';

/** The order products are returned in within a collection. */
export type CollectionSortOrder =
  | 'manual'
  | 'best_selling'
  | 'price_asc'
  | 'price_desc'
  | 'created_desc'
  | 'title_asc';

/** A product field an automated collection rule can test. */
export type CollectionRuleField =
  | 'title'
  | 'productType'
  | 'vendor'
  | 'tag'
  | 'price'
  | 'categorySlug'
  | 'compareAtPrice'
  | 'inventory';

/** The comparison an automated collection rule applies. */
export type CollectionRuleOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte';

/** A single condition in an automated collection's rule set. */
export interface CollectionRule {
  /** The product field this rule tests. */
  field: CollectionRuleField;
  /** The comparison applied to `field`. */
  operator: CollectionRuleOperator;
  /** The value compared against (numeric fields parse this to a number). */
  value: string;
}

/** A merchandising collection of a store's products. */
export interface Collection extends Timestamps {
  /** Stable collection id. */
  id: string;
  /** Owning store id. */
  storeId: string;
  /** Display title. */
  title: string;
  /** URL-safe handle, unique per store. */
  handle: string;
  /** Long-form description. */
  description?: string;
  /** Oxy media file id (or absolute URL) of the collection image. */
  imageFileId?: string;
  /** Whether membership is hand-picked (`manual`) or rule-derived (`automated`). */
  type: CollectionType;
  /** Hand-picked, ordered product ids (manual collections). */
  productIds: string[];
  /** Membership rules (automated collections). */
  rules?: {
    /** When true, a product matching ANY condition belongs; otherwise ALL must match. */
    appliesDisjunctively: boolean;
    /** The conditions evaluated against each product. */
    conditions: CollectionRule[];
  };
  /** The order products are returned in. */
  sortOrder: CollectionSortOrder;
  /** SEO overrides. */
  seo?: { title?: string; description?: string };
  /** Whether the collection is publicly visible. */
  isPublished: boolean;
  /** ISO-8601 time the collection was first published. */
  publishedAt?: string;
}

/** Body for `POST /admin/stores/:storeId/collections` — create a collection. */
export interface CreateCollectionInput {
  title: string;
  handle: string;
  description?: string;
  imageFileId?: string;
  type: CollectionType;
  productIds?: string[];
  rules?: {
    appliesDisjunctively?: boolean;
    conditions: CollectionRule[];
  };
  sortOrder?: CollectionSortOrder;
  seo?: { title?: string; description?: string };
  isPublished?: boolean;
}

/** Body for `PATCH /admin/stores/:storeId/collections/:id` — partial update. */
export type UpdateCollectionInput = Partial<CreateCollectionInput>;

/** Body for `POST /admin/stores/:storeId/collections/:id/products` — set products. */
export interface SetCollectionProductsInput {
  /** Full ordered replacement of the manual collection's product list. */
  productIds: string[];
}
