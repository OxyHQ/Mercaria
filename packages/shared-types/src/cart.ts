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
  /** The single currency every line in this cart shares. */
  currency: CurrencyCode;
  /** Sum of every line total (always in `currency`). */
  subtotal: Money;
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
