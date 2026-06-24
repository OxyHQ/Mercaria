/**
 * Cart DTOs for the Mercaria buyer commerce flow.
 *
 * A cart is a single-currency, soft "wishlist-to-buy": it stores only the
 * variant reference + quantity, NEVER a price. Prices and availability are read
 * LIVE from the variant at view time, so `unitPrice`/`lineTotal`/`subtotal` and
 * the `stale` flags always reflect current catalog state — inventory is reserved
 * at checkout, not when an item is added.
 */

import type { CurrencyCode, Money } from './money';

/**
 * The vendor (store or P2P seller) that owns a group of cart lines. Drives the
 * merchant-grouped cart UI: each `CartGroup` renders this header (logo, name,
 * rating) above its own lines and subtotal.
 */
export interface CartVendor {
  /** Whether this vendor is a store or an individual P2P seller. */
  kind: 'store' | 'user';
  /** Store id (`kind:'store'`) or seller Oxy user id (`kind:'user'`). */
  id: string;
  /** Store handle for the `/stores/:handle` route; undefined for P2P sellers. */
  handle?: string;
  /** Seller username, without the leading `@`; undefined for stores. */
  username?: string;
  /** Store name or seller display name. */
  name: string;
  /** Resolvable store logo / seller avatar URL. */
  logoUrl?: string;
  /** Store brand color (full CSS color string); undefined for P2P sellers. */
  brandColor?: string;
  /** Aggregate rating 0–5 (store rating, or seller rating when available). */
  rating?: number;
  /** Number of reviews contributing to `rating`. */
  reviewCount?: number;
}

/**
 * A cart's lines grouped by their owning vendor. Rendered Shop.app-style: one
 * card per vendor with the vendor header, its lines, and its own subtotal +
 * checkout affordance.
 */
export interface CartGroup {
  /** The store/seller that owns this group's lines. */
  vendor: CartVendor;
  /** The subset of cart items owned by this vendor, in cart order. */
  items: CartItemDTO[];
  /** Sum of this group's item `lineTotal`s (always in `Cart.currency`). */
  subtotal: Money;
}

/**
 * A single line in the cart, hydrated with live pricing and availability.
 *
 * `available` is the units in stock for the variant right now; `stale` is set
 * when the variant/listing has disappeared or its `available` has dropped below
 * the requested `quantity` (so the client can prompt the buyer to adjust).
 */
export interface CartItemDTO {
  /** The owning listing's id. */
  listingId: string;
  /** The concrete variant id this line buys. */
  variantId: string;
  /** Listing title (denormalized for display). */
  title: string;
  /** Variant title (e.g. `Size / M`, or `Default Title` for P2P). */
  variantTitle: string;
  /** First listing image, resolved through the media chokepoint. */
  imageUrl?: string;
  /** Live unit price read from the variant. */
  unitPrice: Money;
  /** Quantity of this variant in the cart. */
  quantity: number;
  /** Units currently available for the variant (live). */
  available: number;
  /** `unitPrice * quantity`. */
  lineTotal: Money;
  /** Set when the variant/listing is gone or under-stocked vs `quantity`. */
  stale?: boolean;
}

/** The buyer's cart: a single-currency set of hydrated line items. */
export interface Cart {
  /** Stable cart id. */
  id: string;
  /** Hydrated line items, in insertion order. */
  items: CartItemDTO[];
  /**
   * The same line items grouped by their owning vendor (store or P2P seller),
   * each group carrying the vendor header and its own subtotal. Groups are in
   * first-seen order; `items` is retained flat for back-compat.
   */
  groups: CartGroup[];
  /** The single currency every line in this cart shares. */
  currency: CurrencyCode;
  /** Sum of every line total (always in `currency`). */
  subtotal: Money;
  /** Discount codes pinned to the cart, pending application at checkout. */
  pendingDiscountCodes?: string[];
  /**
   * PREVIEW total of the pending discounts over store-owned lines (presentation
   * only; checkout re-computes authoritatively). Present when codes are pinned.
   */
  discountTotal?: Money;
  /** PREVIEW tax over the discounted store-owned lines (presentation only). */
  taxPreview?: Money;
  /** PREVIEW grand total `subtotal - discountTotal + taxPreview` (presentation only). */
  total?: Money;
}

/** Body for `POST /cart/items` — add (or increment) a variant in the cart. */
export interface AddCartItemInput {
  /** The owning listing's id. */
  listingId: string;
  /** The variant to add. */
  variantId: string;
  /** Units to add (will be clamped to availability when tracked). */
  quantity: number;
}

/** Body for `PATCH /cart/items/:variantId` — set the absolute quantity. */
export interface UpdateCartItemInput {
  /** New absolute quantity (0 removes the line). */
  quantity: number;
}
