/**
 * The PUBLIC integration contract (#1017) — what another Oxy application may
 * read from Mercaria, and the only shapes `@mercaria.co/sdk` publishes.
 *
 * ## Why a separate contract rather than `Listing` / `StoreSummary`
 *
 * The storefront DTOs are shaped for Mercaria's own apps and carry things a
 * foreign application must never hold: connector provenance, variant SKUs and
 * barcodes, a manual collection's raw member ids (including non-active ones)
 * and its automation rules, Oxy media file ids instead of URLs. Every type below
 * is instead built FIELD BY FIELD by the backend's public projection — never by
 * spreading a storefront DTO — so a field added to `Listing` tomorrow does not
 * reach Mention, Goway or an agent unless somebody adds it here on purpose.
 *
 * ## References are identity, never a snapshot
 *
 * A `Mercaria*Ref` carries exactly the stable id needed to resolve the entity and
 * nothing that can change: no title, no image, no price, no availability, and no
 * store HANDLE (a merchant can rename one). A consumer persists the ref and
 * hydrates current facts through the SDK every time it renders them.
 *
 * The product grain is the SELLABLE PRODUCT — the thing a store or a person puts
 * up for sale, with its own purchase options, price and stock. Its id is
 * globally unique, so a product ref does not name its store. The multi-seller
 * canonical catalogue identity (ADR 0002) is a different grain and is not part of
 * this contract yet.
 *
 * ## Current truth, not history
 *
 * Every read here returns CURRENT catalogue facts. Prices are in the listing's
 * NATIVE currency, converted by nothing (a consumer that needs presentment
 * currency does not get a guess). A price or an availability read from this
 * contract is a fact about the moment it was served and must not be persisted as
 * authoritative; order and payment snapshots live in the order domain and are
 * never reconstructed from these reads.
 */

import type { Money } from './money';
import type { ConditionGroup, ItemConditionKey } from './condition';

/** The path every public integration route is mounted under. */
export const MERCARIA_PUBLIC_API_BASE_PATH = '/public/v1' as const;

// ── References ──────────────────────────────────────────────────────────────

/** The entity kinds a portable reference can name. */
export const MERCARIA_REF_KINDS = ['product', 'variant', 'store', 'collection'] as const;
export type MercariaRefKind = (typeof MERCARIA_REF_KINDS)[number];

/** A sellable product, by its globally unique id. */
export interface MercariaProductRef {
  readonly kind: 'product';
  /** The product id. Globally unique; no store is needed to resolve it. */
  readonly id: string;
}

/**
 * One purchase option of a product.
 *
 * Carries the product id as well as the variant id because a variant is
 * resolved THROUGH its product — there is no public read of a lone variant.
 */
export interface MercariaVariantRef {
  readonly kind: 'variant';
  /** The owning product's id. */
  readonly productId: string;
  /** The variant id. */
  readonly variantId: string;
}

/** A store, by id — never by handle, which the merchant can change. */
export interface MercariaStoreRef {
  readonly kind: 'store';
  /** The store id. */
  readonly id: string;
}

/** A store's curated collection, by its globally unique id. */
export interface MercariaCollectionRef {
  readonly kind: 'collection';
  /** The collection id. */
  readonly id: string;
}

/** Any portable Mercaria reference. */
export type MercariaRef =
  | MercariaProductRef
  | MercariaVariantRef
  | MercariaStoreRef
  | MercariaCollectionRef;

// ── Shared presentation pieces ──────────────────────────────────────────────

/** An image, as an absolute URL a foreign client can render directly. */
export interface MercariaImage {
  /** Absolute URL. */
  url: string;
  /** Accessible description, or `null` when the seller gave none. */
  alt: string | null;
}

/**
 * Whether a product (or one purchase option) can be bought right now.
 *
 * - `in_stock`: live and buyable.
 * - `out_of_stock`: live, but no purchase option has stock.
 * - `sold`: a one-off item that has been sold. Still viewable, never buyable.
 */
export const MERCARIA_PRODUCT_AVAILABILITIES = ['in_stock', 'out_of_stock', 'sold'] as const;
export type MercariaProductAvailability = (typeof MERCARIA_PRODUCT_AVAILABILITIES)[number];

/** The item's condition, as its taxonomy key and the segment it belongs to. */
export interface MercariaProductCondition {
  key: ItemConditionKey;
  group: ConditionGroup;
}

/**
 * Who sells a product. A store is referenced by id; a person is identified by
 * their Oxy user id, the one cross-application identity Oxy owns.
 */
export type MercariaSeller =
  | {
      kind: 'store';
      store: MercariaStoreRef;
      /** The store's CURRENT handle — presentation, not identity. */
      handle: string;
      name: string;
      logoUrl: string | null;
    }
  | {
      kind: 'person';
      oxyUserId: string;
      displayName: string;
      /** Oxy username without the leading `@`. */
      username: string;
      avatarUrl: string | null;
      isVerified: boolean;
    };

// ── Products ────────────────────────────────────────────────────────────────

/** One way to buy a product: a variant with its own price and stock. */
export interface MercariaPurchaseOption {
  ref: MercariaVariantRef;
  /** The variant's display title (e.g. `Blue / M`). */
  title: string;
  price: Money;
  /** The pre-discount price when the option is on sale, else `null`. */
  compareAtPrice: Money | null;
  availability: Exclude<MercariaProductAvailability, 'sold'>;
}

/** A product as a card renders it — what search and store/collection grids serve. */
export interface MercariaProductSummary {
  ref: MercariaProductRef;
  title: string;
  /** The first gallery image, or `null` when the product has none. */
  primaryImage: MercariaImage | null;
  /** The lowest current purchase-option price, in the product's native currency. */
  price: Money;
  /** The cheapest option's pre-discount price when on sale, else `null`. */
  compareAtPrice: Money | null;
  /** The span across purchase options, or `null` when they all cost the same. */
  priceRange: { min: Money; max: Money } | null;
  availability: MercariaProductAvailability;
  condition: MercariaProductCondition;
  seller: MercariaSeller;
  /** The canonical Mercaria web URL for this product. */
  url: string;
}

/** A product as a detail view or a hydrated attachment renders it. */
export interface MercariaProduct extends MercariaProductSummary {
  description: string;
  /** The full ordered gallery. */
  images: MercariaImage[];
  purchaseOptions: MercariaPurchaseOption[];
  /** ISO-8601 time the product was last changed. */
  updatedAt: string;
  /**
   * Facts about the CALLER, present only when the request carried a valid Oxy
   * session; `null` for an anonymous read.
   */
  viewer: { saved: boolean } | null;
}

/** How a product page is ordered. `relevance` needs a search query. */
export const MERCARIA_PRODUCT_SORTS = ['relevance', 'newest', 'price_asc', 'price_desc'] as const;
export type MercariaProductSort = (typeof MERCARIA_PRODUCT_SORTS)[number];

// ── Stores and collections ──────────────────────────────────────────────────

/** A public storefront. */
export interface MercariaStore {
  ref: MercariaStoreRef;
  /** The CURRENT handle — presentation, not identity. */
  handle: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  coverImageUrl: string | null;
  /** The store's brand colour, as a CSS hex string. */
  brandColor: string;
  /** Average rating 0–5, or `null` when the store has no reviews. */
  rating: number | null;
  reviewCount: number;
  /** The canonical Mercaria web URL for this store. */
  url: string;
}

/** A published, curated collection of one store's products. */
export interface MercariaCollection {
  ref: MercariaCollectionRef;
  store: MercariaStoreRef;
  title: string;
  description: string | null;
  image: MercariaImage | null;
  /** The canonical Mercaria web URL for this collection. */
  url: string;
}

// ── Pagination and the wire envelope ────────────────────────────────────────

/** The largest page a public list read serves. */
export const MERCARIA_PUBLIC_PAGE_LIMIT_MAX = 50;
/** The page size a public list read applies when the caller names none. */
export const MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT = 20;

/**
 * One page of a public list. `nextCursor` is OPAQUE — pass it back verbatim to
 * get the next page; `null` means there is none. Its contents are not a contract.
 */
export interface MercariaPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * The stable, machine-readable error codes the public routes emit. A consumer
 * branches on these (the SDK maps them to typed errors), never on `message`.
 *
 * `GONE` is the one that is specific to this contract: the entity EXISTED and is
 * no longer publicly available (archived, withdrawn by moderation, or its store
 * closed or suspended). It is deliberately distinct from
 * `NOT_FOUND`, so a post attachment can say "no longer available" rather than
 * "broken link" — and it deliberately says nothing about WHY.
 *
 * `UNKNOWN_ROUTE` (404) answers a path or method the public surface does not
 * serve at all. It is NOT `NOT_FOUND`: a client and a server that disagree about
 * the route table must never read as "this entity does not exist", or a consumer
 * would discard a perfectly valid persisted reference.
 */
export const MERCARIA_PUBLIC_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'GONE',
  'UNKNOWN_ROUTE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;
export type MercariaPublicErrorCode = (typeof MERCARIA_PUBLIC_ERROR_CODES)[number];

/** A successful public response body. */
export interface MercariaPublicSuccess<T> {
  success: true;
  data: T;
}

/** A failed public response body. */
export interface MercariaPublicFailure {
  success: false;
  error: MercariaPublicErrorCode;
  message: string;
}
