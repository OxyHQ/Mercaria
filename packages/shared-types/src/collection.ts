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
  /**
   * Resolved, absolute collection image URL, derived from `imageFileId` through
   * the media chokepoint. Present on PUBLIC store-collection responses (store
   * page tiles/pills); omitted from admin responses, which carry only the raw
   * `imageFileId`.
   */
  imageUrl?: string;
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

/**
 * The ONE product fact collection membership writes.
 *
 * A row in `listing_collections`, and nothing else. ADR 0007 D3: `collections`,
 * `collection_rules` and `listing_collections` "are **not** given category
 * semantics and a collection membership never becomes a product fact".
 */
export type CollectionProductWrite = 'collection_membership';

/** {@link CollectionProductWrite}. */
export const COLLECTION_PRODUCT_WRITES: readonly CollectionProductWrite[] = [
  'collection_membership',
];

/**
 * A product fact a merchandising collection may NEVER write (ADR 0007 D3).
 *
 * The named half of "without assigning fake categories to products". The failure
 * is not a crash and not a refusal — it is a merchant who needs a *Summer Sale*
 * shelf, mints a *Summer Sale* CATEGORY because that is what the browse tree
 * reads, and files forty products under it. Every page renders. The taxonomy is
 * now carrying a marketing campaign, `category_slugs` says a swimsuit's browse
 * path is `summer-sale`, and the damage surfaces months later as a shopper
 * filtering *Swimwear* and finding nothing.
 *
 * Stated as VALUES rather than as prose so a refusal can name the thing —
 * `NAVIGATION_FORBIDDEN_TARGET_KINDS` is the same device for D3's other half,
 * and the two lists exist because the temptation is symmetric: a menu and a
 * collection are both arrangements OF the catalogue, and both are one convenient
 * write away from becoming a second authority OVER it.
 *
 * Asserted DISJOINT from {@link COLLECTION_PRODUCT_WRITES} by
 * `merchandising-category-isolation.test.ts`, which also holds the import graph
 * that makes each of these unreachable from the merchandising domain.
 *
 * A collection legitimately READS a category — `categorySlug` is a
 * {@link CollectionRuleField}, and "everything in Shoes" is the ordinary reason
 * somebody builds an automated collection. The prohibition is on the WRITE.
 */
export type CollectionForbiddenProductWrite =
  | 'primary_category'
  | 'secondary_classification'
  | 'category_browse_path'
  | 'category_definition'
  | 'canonical_product_category'
  | 'product_type'
  | 'brand';

/** {@link CollectionForbiddenProductWrite}. */
export const COLLECTION_FORBIDDEN_PRODUCT_WRITES: readonly CollectionForbiddenProductWrite[] = [
  'primary_category',
  'secondary_classification',
  'category_browse_path',
  'category_definition',
  'canonical_product_category',
  'product_type',
  'brand',
];
