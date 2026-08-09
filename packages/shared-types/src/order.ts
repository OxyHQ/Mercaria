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

import type { DualMoney, FxRateSnapshot, Money } from './money';
import type { CheckoutContactInput, CheckoutDestination } from './checkout';
import type {
  CheckoutPaymentHandoff,
  CheckoutPaymentMethod,
  OrderPaymentStatus,
  PaymentProviderId,
  PaymentStatus,
} from './payment';
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

/**
 * The buyer-safe payment projection carried on an order.
 *
 * It is a POINTER plus the coarse state, never a copy of the payment's mutable
 * provider-side detail (#45 invariant 5). Amounts, attempts, provider events,
 * ledger entries, transfers and payouts all live on the payment aggregate and
 * are reached through `paymentId`; nothing here is recomputed from them, so a
 * payment moving through its lifecycle can never leave an order holding a stale
 * copy of a figure.
 */
export interface PaymentInfo {
  /** Where the payment is, in the coarse vocabulary an order lifecycle needs. */
  status: OrderPaymentStatus;
  /**
   * The rail that settled (or is settling) this order.
   *
   * ABSENT until a payment exists. A freshly checked-out order has reserved
   * stock and no payment at all, and naming a provider for it would be an
   * invented fact — which is exactly what the retired `oxy_pay` default was.
   */
  provider?: PaymentProviderId;
  /** Provider-side reference/transaction id, when one exists. */
  reference?: string;
  /** ISO-8601 time the order was paid, when paid. */
  paidAt?: string;
  /**
   * The Mercaria payment aggregate funding this order, once one exists.
   *
   * One payment covers a whole checkout group (ADR 0001 D4), so sibling orders
   * of a multi-seller cart share this id — it is not one payment per order.
   */
  paymentId?: string;
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
   * The shop→presentment rate snapshot the order's presentment amounts were
   * formed with. Absent only on an imported order whose source platform reported
   * a single currency (nothing was converted).
   */
  fxRate?: FxRateSnapshot;
  /**
   * Per-discount breakdown of every reduction applied (empty when none). Amounts
   * are in the order's SHOP currency (the merchant accounting / refund basis).
   */
  appliedDiscounts?: DiscountAllocation[];
  /**
   * Per-rate tax breakdown (empty when none). Amounts are in the order's SHOP
   * currency (the merchant accounting / refund basis).
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

/**
 * Body for `POST /checkout` — place orders from the buyer's current cart.
 *
 * ## `destination` and `addressId` are ONE field in two contract versions
 *
 * `addressId` is the v1 spelling and is still accepted: it means exactly
 * `{type: 'saved_address', addressId}` and the server maps it to that before
 * anything else looks at it (#105 migration rules 1-2). This is a VERSIONED
 * CONTRACT, not a compatibility shim — a shipped mobile build cannot be
 * recalled, and refusing its checkout would strand a buyer mid-purchase over a
 * field name. It retires when the supported client versions have migrated
 * (#105 migration rule 7), and until then exactly one of the two may be
 * present: sending both is a 400 rather than a precedence rule nobody would
 * remember.
 *
 * An OLD client is therefore an authenticated client by construction — it has
 * no way to express a guest destination — which is why the guest path can be
 * added without any client-version negotiation at all.
 */
export interface CheckoutInput {
  /**
   * Where this checkout's goods go. Required unless the v1 `addressId` is used.
   *
   * A guest actor may name `inline_shipping_address` or `pickup` and can never
   * name `saved_address`: the address book is Oxy-scoped, and a guest carries no
   * Oxy id to scope a lookup with (ADR 0003 I1).
   */
  destination?: CheckoutDestination;
  /**
   * v1: the saved address to ship to. Equivalent to
   * `{type: 'saved_address', addressId}`; see the interface docblock.
   */
  addressId?: string;
  /**
   * How to reach the buyer about this order.
   *
   * REQUIRED for a guest — ADR 0003 D4's contact record cannot exist without
   * it — and optional for an authenticated buyer, whose transactional channel
   * is their Oxy account. It is never filled in from an Oxy profile behind the
   * buyer's back (#105 actor rule 6): absent means absent.
   */
  contact?: CheckoutContactInput;
  /**
   * Opt in to marketing email. Defaults to FALSE, is never required to buy, and
   * is deliberately a field of its own rather than a property of `contact`:
   * permission to send a receipt comes from the purchase, permission to market
   * comes from here, and one must never be read as the other (#105 privacy
   * rules 1-2, 10).
   */
  marketingOptIn?: boolean;
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
  /**
   * Which rail to fund this checkout through.
   *
   * Absent means "whatever this deployment offers": the card rail when it is
   * enabled, and no payment at all when it is not — which is exactly the
   * behaviour every client had before a rail existed, so an old client keeps
   * working unchanged.
   *
   * Naming a rail the deployment does not offer is REFUSED rather than silently
   * downgraded. A buyer who asked to pay by card and got an unpayable order back
   * with a 201 has been told the wrong thing.
   */
  paymentMethod?: CheckoutPaymentMethod;
}

/** Result of a successful checkout: the group id + a summary of each new order. */
export interface CheckoutResult {
  /** Id tying together the orders created from this checkout. */
  checkoutGroupId: string;
  /** A summary of each order created (one per seller). */
  orders: OrderSummary[];
  /**
   * What the buyer's client needs to pay, when a rail was engaged.
   *
   * Absent when no payment was opened — a deployment with no rail enabled, or a
   * `mock` checkout whose dev seam funds the group from its own endpoint. A
   * replay of the same `Idempotency-Key` returns the SAME handoff, because both
   * the payment record and the rail's own object converge (ADR 0001 D11) rather
   * than being created a second time.
   */
  payment?: CheckoutPaymentHandoff;
}

/**
 * What a buyer may learn about their checkout group's payment while it is in
 * flight.
 *
 * The read side of "a client cannot forge paid state" (#45 invariant 6): a
 * client that has just finished a rail's payment sheet asks HERE what happened,
 * rather than reporting what it thinks happened. So this endpoint is the reason
 * the client's own result callback can stay purely cosmetic.
 *
 * Coarse on purpose. Order status and payment status are facts the buyer already
 * sees on their own orders; provider objects, transfers and ledger entries are
 * merchant and operator detail and are not projected here.
 */
export interface CheckoutPaymentStatus {
  checkoutGroupId: string;
  /**
   * The payment's status, absent when no payment has been opened for the group
   * — a checkout placed on a deployment with no rail enabled is the ordinary
   * case, not an error.
   */
  status?: PaymentStatus;
  provider?: PaymentProviderId;
  /** What the buyer is being charged, once a payment exists. */
  amount?: Money;
  /** The group's orders and where each one stands. */
  orders: CheckoutPaymentOrderState[];
}

/** One order's coarse state inside {@link CheckoutPaymentStatus}. */
export interface CheckoutPaymentOrderState {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
}
