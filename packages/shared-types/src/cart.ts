/**
 * Cart DTOs for the Mercaria buyer commerce flow.
 *
 * A cart is a single-currency, soft "wishlist-to-buy": it stores only the
 * variant reference + quantity, NEVER a price. Prices and availability are read
 * LIVE from the variant at view time, so `unitPrice`/`lineTotal`/`subtotal` and
 * the `stale` flags always reflect current catalog state — inventory is reserved
 * at checkout, not when an item is added.
 *
 * ## Ownership is NOT in these DTOs, on purpose (#104, ADR 0003 D8)
 *
 * A cart is owned by an Oxy account OR by a guest session, and neither owner id
 * appears in any type here. The server resolves the owner from the request's
 * `CommerceActor` and answers with the cart; a client that could name an owner
 * could name someone else's. `Cart.id` is the cart row id, which the holder
 * already has and which authorizes nothing.
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
  /**
   * Why this line needs the buyer's attention after a guest→Oxy cart merge
   * (#104). `stale` is DERIVED live at every hydration and can therefore clear
   * itself when stock returns; this one is a STORED fact about what the merge
   * did to the line, and it survives until the buyer touches the line again.
   * Absent on a line no merge altered.
   */
  reviewReason?: CartLineReviewReason;
}

/**
 * Why a merged cart line is flagged for the buyer to review (#104).
 *
 * These are stored on `cart_items.merge_review_reason` under a CHECK derived
 * from this very tuple, so the wire vocabulary and the column can never drift.
 * The set is deliberately CLOSED and small: a merge that could not carry a
 * line forward exactly as the guest had it must say which of four things
 * happened, and nothing here is free text a buyer or a seller could inject.
 *
 * No line is ever DELETED to resolve a conflict — the whole point of the flag
 * is that "no item disappears silently during merge" (#104 acceptance 6).
 */
export const CART_LINE_REVIEW_REASONS = [
  /** The summed quantity exceeded the variant's live tracked stock. */
  'quantity_clamped_to_stock',
  /** The summed quantity exceeded the configured per-item maximum. */
  'quantity_clamped_to_limit',
  /** The listing is no longer sellable (not `active`), or its variant is gone. */
  'listing_unavailable',
  /** The variant now belongs to a different listing than the line recorded. */
  'listing_remapped',
] as const;

/** One of {@link CART_LINE_REVIEW_REASONS}. */
export type CartLineReviewReason = (typeof CART_LINE_REVIEW_REASONS)[number];

/**
 * The bounded vocabulary a cart-merge AUDIT event may carry (#104).
 *
 * A superset of {@link CART_LINE_REVIEW_REASONS} plus the three outcomes that
 * are properties of the merge rather than of any one line. Bounded on purpose:
 * the merge event is stored and read by operators, and a free-text reason
 * would be the one place a listing title or a discount code could leak into an
 * audit row that is explicitly NOT item-sensitive (#104 merge requirement 12).
 */
export const CART_MERGE_REASON_CODES = [
  ...CART_LINE_REVIEW_REASONS,
  /** The guest session had already been converted; this call was a no-op. */
  'already_converted',
  /** The guest session owned no cart at all. */
  'no_guest_cart',
  /** The guest cart existed but held no lines. */
  'guest_cart_empty',
  /** A pending discount code did not survive revalidation against the merged cart. */
  'discount_code_dropped',
] as const;

/** One of {@link CART_MERGE_REASON_CODES}. */
export type CartMergeReasonCode = (typeof CART_MERGE_REASON_CODES)[number];

/**
 * The COUNTS a merge records — the durable, repairable analytics of #104.
 *
 * Counts only: how many lines moved, combined, were clamped or flagged, and
 * how many discount codes were kept or dropped. Never a listing id, a variant
 * id, a title, a price or a discount code, so the audit row can be read by an
 * operator without exposing what the buyer is buying.
 */
export interface CartMergeCounts {
  /** Guest lines that had no counterpart and moved across whole. */
  linesAdded: number;
  /** Guest lines whose variant was already in the authenticated cart. */
  linesCombined: number;
  /** Lines whose resulting quantity was clamped below the plain sum. */
  linesClamped: number;
  /** Lines carried across but flagged for review (see {@link CART_LINE_REVIEW_REASONS}). */
  linesFlagged: number;
  /** Guest discount codes added to the authenticated cart's pending set. */
  discountCodesAdded: number;
  /** Guest discount codes that did not survive revalidation. */
  discountCodesDropped: number;
}

/**
 * The answer to `POST /cart/merge` (#104).
 *
 * Carries NO internal owner id — not the guest session id, not the Oxy user
 * id, and never the guest credential in any form. `merged` distinguishes the
 * call that did the work from the idempotent convergence a retry gets; both
 * answer 200 with the same resulting `cart`, which is what "a repeated merge
 * request returns the same result" means on the wire.
 */
export interface CartMergeResult extends CartMergeCounts {
  /** `false` when this call converged on an already-completed merge. */
  merged: boolean;
  /** Bounded reason codes, deduplicated and sorted for a stable response. */
  reasons: CartMergeReasonCode[];
  /**
   * Whether the guest credential is now revoked and the client must discard
   * it. Web clients also get the cookie cleared; native clients have nothing
   * server-side to clear, so this flag is their discard instruction (ADR 0003
   * D3/D9).
   */
  guestCredentialRevoked: boolean;
  /** The resulting authenticated cart, freshly hydrated. */
  cart: Cart;
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
