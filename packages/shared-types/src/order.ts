/**
 * Order DTOs for the Mercaria checkout + fulfilment flow.
 *
 * An order is the IMMUTABLE record of a single seller's portion of a checkout:
 * a multi-seller cart splits into one order per seller (`checkoutGroupId` ties
 * the siblings together). Order line items (`OrderItem`) are SNAPSHOTS copied at
 * checkout — title, variant, options, unit price and image are frozen at the
 * moment of purchase and never re-read from the live catalog, so a later price
 * change or listing edit can never mutate a placed order.
 */

import type { Money, DualMoney, FxRateSnapshot } from './money';
import type { Seller } from './seller';
import type { MerchantSummary } from './product';
import type { Timestamps } from './common';
import type { DiscountAllocation } from './discount';
import type { TaxLine } from './tax';
import type { ConnectorProviderId } from './integration';

/**
 * Lifecycle status of an order.
 *
 * `pending_payment` (stock reserved, awaiting pay) → `paid` (sale committed) →
 * `processing` → `shipped` → `delivered`; `cancelled` and `refunded` are
 * terminal exits. `partially_refunded` is a non-terminal partial-refund state: a
 * paid/delivered order with SOME amount refunded that can still progress to a
 * full `refunded`. Allowed transitions are enforced server-side.
 */
export type OrderStatus =
  | 'pending_payment'
  | 'paid'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded';

/** Payment state + provider reference for an order. */
export interface PaymentInfo {
  /** Where the payment is in its own lifecycle. */
  status: 'unpaid' | 'authorized' | 'paid' | 'refunded' | 'failed';
  /**
   * Payment provider that settled (or will settle) this order. Native Mercaria
   * orders settle through `oxy_pay`; `external` marks an order that was PAID on a
   * connected external platform (e.g. a Shopify order pulled in via a connector),
   * whose payment was captured outside Oxy Pay.
   */
  provider: 'oxy_pay' | 'external';
  /** Provider-side reference/transaction id, when one exists. */
  reference?: string;
  /** ISO-8601 time the order was paid, when paid. */
  paidAt?: string;
}

/**
 * Provenance of an order synced from an external commerce platform. Present only
 * on connector-sourced orders; native Mercaria orders omit it. `externalId` +
 * `connectionId` are the idempotency key — a re-sync/webhook of the same external
 * order updates the existing Mercaria order instead of creating a duplicate.
 */
export interface OrderSource {
  /** The `Connection` this order was imported through. */
  connectionId: string;
  /** External platform the order came from. */
  provider: ConnectorProviderId;
  /** The order's id on the external platform (the upsert key with the connection). */
  externalId: string;
  /** The external platform's `updated_at` for the order at last sync, when known. */
  externalUpdatedAt?: string;
}

/** A shipping speed/option the buyer may pick per seller at checkout. */
export type ShippingMethod = 'standard' | 'express' | 'pickup';

/** The chosen shipping method, its human label, cost and (later) tracking. */
export interface ShippingInfo {
  /** The shipping method selected for this order. */
  method: ShippingMethod;
  /** Human-readable label for the method (e.g. "Standard shipping"). */
  label: string;
  /** Shipping cost added to the order total, in shop + presentment currency. */
  cost: DualMoney;
  /** Carrier tracking number, set by the seller once shipped. */
  trackingNumber?: string;
}

/**
 * An immutable line item snapshot, copied from the cart at checkout. None of
 * these fields are re-read from the live catalog after the order is placed.
 */
export interface OrderItem {
  /** The listing the item was bought from (reference only). */
  listingId: string;
  /** The concrete variant purchased (reference only). */
  variantId: string;
  /** Listing title at purchase time. */
  title: string;
  /** Variant title at purchase time (e.g. `Size / M`). */
  variantTitle: string;
  /** First listing image, resolved through the media chokepoint, when present. */
  imageUrl?: string;
  /** Variant option assignments at purchase time. */
  optionValues: { name: string; value: string }[];
  /** Unit price at purchase time, in shop + presentment currency. */
  unitPrice: DualMoney;
  /** Quantity of this variant ordered. */
  quantity: number;
  /** `unitPrice * quantity`, in shop + presentment currency. */
  lineTotal: DualMoney;
  /** Total discount attributed to this line (shop + presentment), when discounted. */
  discountTotal?: DualMoney;
  /**
   * The store location this line's stock is committed at (POS sales). Absent for
   * storefront orders, which commit at the store's default location.
   */
  locationId?: string;
}

/** Who fulfils an order: an individual P2P seller or a store. */
export type OrderSellerType = 'user' | 'store';

/**
 * The channel an order originated from: the online `storefront`, an in-store
 * `pos` sale, or a `draft` order converted to a sale.
 */
export type OrderSourceChannel = 'storefront' | 'pos' | 'draft';

/**
 * Immutable copy of the buyer's shipping destination at checkout. Snapshotted so
 * a later edit/deletion of the saved `Address` never changes a placed order.
 */
export interface AddressSnapshot {
  /** Optional address label (e.g. "Home"). */
  label?: string;
  /** Recipient full name. */
  recipientName: string;
  /** Street address line 1. */
  line1: string;
  /** Street address line 2 (apt/suite), when present. */
  line2?: string;
  /** City / locality. */
  city: string;
  /** State / region / province, when present. */
  region?: string;
  /** Postal / ZIP code. */
  postalCode: string;
  /** ISO-3166 alpha-2 country code. */
  country: string;
  /** Contact phone, when present. */
  phone?: string;
}

/**
 * The seller identity attached to an order, discriminated by `type`: a P2P order
 * carries a `Seller`, a store order carries a `MerchantSummary`.
 */
export type OrderSellerMini =
  | { type: 'user'; seller: Seller }
  | { type: 'store'; store: MerchantSummary };

/**
 * The shop→FAIR settlement snapshot, captured when an order is paid. FAIR is the
 * canonical settlement currency: on the `paid` transition the order's shop
 * grandTotal is converted to FAIR (`amount`) at the captured `rate`, so payout is
 * reproducible independent of later rate moves. Absent until the order is paid.
 */
export interface OrderSettlement {
  /** The settled grand total in FAIR (canonical settlement currency). */
  amount: Money;
  /** Units of FAIR per ONE unit of the order's shop currency, at settlement. */
  rate: number;
  /** ISO-8601 time settlement was computed (the `paid` transition). */
  asOf: string;
}

/** A single entry in an order's status history (audit trail of transitions). */
export interface OrderStatusEvent {
  /** The status the order moved INTO. */
  status: OrderStatus;
  /** ISO-8601 time of the transition. */
  at: string;
  /** Oxy user id of the actor who triggered it, when known. */
  byOxyUserId?: string;
  /** Optional free-text note attached to the transition. */
  note?: string;
}

/**
 * A placed order — one seller's portion of a checkout. `seller` (P2P) or `store`
 * (store) is hydrated for display; `checkoutGroupId` ties together the sibling
 * orders created from the same multi-seller cart.
 */
export interface Order extends Timestamps {
  /** Stable order id. */
  id: string;
  /** Sequential, human-friendly order number (e.g. `MRC-000123`). */
  orderNumber: string;
  /** Oxy user id of the buyer. */
  buyerOxyUserId: string;
  /** Whether this order is fulfilled by a user (P2P) or a store. */
  sellerType: OrderSellerType;
  /** Oxy user id of the seller, for P2P orders. */
  sellerOxyUserId?: string;
  /** Store id, for store orders. */
  storeId?: string;
  /** The store customer this order relates to, when one was attached (POS/draft). */
  customerId?: string;
  /** The channel the order originated from (defaults to `storefront`). */
  sourceChannel: OrderSourceChannel;
  /** Connector provenance — present only on orders synced from an external platform. */
  source?: OrderSource;
  /** Hydrated P2P seller identity, for `sellerType: 'user'`. */
  seller?: Seller;
  /** Hydrated store identity, for `sellerType: 'store'`. */
  store?: MerchantSummary;
  /** Immutable line item snapshots. */
  items: OrderItem[];
  /** Immutable shipping destination snapshot. */
  shippingAddress: AddressSnapshot;
  /** Chosen shipping method + cost (+ tracking once shipped). */
  shipping: ShippingInfo;
  /** Money totals for the order, each carried in shop + presentment currency. */
  totals: {
    /** Sum of every line total. */
    subtotal: DualMoney;
    /** Total of every applied discount allocation (0 when none). */
    discountTotal: DualMoney;
    /** Shipping cost added to the order. */
    shipping: DualMoney;
    /** Total tax added to the order (0 when none / tax-inclusive). */
    tax: DualMoney;
    /** `subtotal - discountTotal + tax + shipping`. */
    grandTotal: DualMoney;
  };
  /**
   * The shop→presentment rate snapshot used to form the order's presentment
   * amounts. Absent on legacy single-currency orders.
   */
  fxRate?: FxRateSnapshot;
  /** The shop→FAIR settlement snapshot, present once the order is paid. */
  settlement?: OrderSettlement;
  /**
   * Per-discount breakdown of every reduction applied (empty when none). Amounts
   * are in the order's SHOP currency (the settlement basis).
   */
  appliedDiscounts?: DiscountAllocation[];
  /**
   * Per-rate tax breakdown (empty when none). Amounts are in the order's SHOP
   * currency (the settlement basis).
   */
  taxLines?: TaxLine[];
  /** Current lifecycle status. */
  status: OrderStatus;
  /** Audit trail of every status transition. */
  statusHistory: OrderStatusEvent[];
  /** Payment state + provider reference. */
  payment: PaymentInfo;
  /** Id tying together the sibling orders created from the same checkout. */
  checkoutGroupId: string;
}

/** A compact order projection for buyer/seller order lists. */
export interface OrderSummary {
  /** Stable order id. */
  id: string;
  /** Sequential, human-friendly order number. */
  orderNumber: string;
  /** Current lifecycle status. */
  status: OrderStatus;
  /** The order grand total, in shop + presentment currency. */
  grandTotal: DualMoney;
  /** Total units across all line items. */
  itemCount: number;
  /** Whether this order is fulfilled by a user (P2P) or a store. */
  sellerType: OrderSellerType;
  /** Hydrated P2P seller identity, for `sellerType: 'user'`. */
  seller?: Seller;
  /** Hydrated store identity, for `sellerType: 'store'`. */
  store?: MerchantSummary;
  /** ISO-8601 creation time. */
  createdAt: string;
}

/** Body for `POST /checkout` — place orders from the buyer's current cart. */
export interface CheckoutInput {
  /** The saved address to ship to (snapshotted onto each order). */
  addressId: string;
  /**
   * Restrict the checkout to these seller groups, keyed exactly like the order
   * grouping (`store:<storeId>` or `user:<oxyUserId>`). When provided, only the
   * matching cart lines are placed (one order per listed group) and every other
   * line stays in the cart. When absent, the WHOLE cart is checked out and
   * emptied — the original behavior.
   */
  sellerKeys?: string[];
  /**
   * Per-seller shipping method selection, keyed by the seller group key
   * (`store:<storeId>` or `user:<oxyUserId>`). Absent groups default to
   * `standard`.
   */
  shippingSelections?: Record<string, ShippingMethod>;
  /**
   * Discount codes to apply at checkout, merged with any codes already pinned to
   * the cart. Only honored for store-owned seller groups; ignored for P2P.
   */
  discountCodes?: string[];
}

/** Result of a successful checkout: the group id + a summary of each new order. */
export interface CheckoutResult {
  /** Id tying together the orders created from this checkout. */
  checkoutGroupId: string;
  /** A summary of each order created (one per seller). */
  orders: OrderSummary[];
}
