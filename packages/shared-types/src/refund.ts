/**
 * Refund/Return DTOs for the Mercaria store-admin commerce surface (B6).
 *
 * A `Refund` records money returned for part or all of a paid `Order`: per-line
 * amounts computed from each item's DISCOUNTED net (never gross), optional
 * shipping, and an optional per-line restock that returns units to inventory.
 * Refunds are store-scoped and immutable once processed — the order's status
 * moves to `partially_refunded` (more refundable) or `refunded` (fully refunded)
 * and, for store orders with a buyer, the customer's lifetime `totalSpent` is
 * decremented. The optional `rmaNumber` is a human-friendly return-merchandise
 * authorization number (e.g. `RMA-000123`).
 */

import type { Timestamps } from './common';
import type { DualMoney } from './money';

/** Whether the record is a money-only refund or a return (RMA workflow). */
export type RefundType = 'refund' | 'return';

/**
 * Lifecycle status of a refund/return. A processed money refund lands in
 * `refunded`; the other states exist for the return RMA workflow lifecycle.
 */
export type RefundStatus =
  | 'requested'
  | 'approved'
  | 'restocked'
  | 'refunded'
  | 'rejected'
  | 'cancelled';

/** One refunded line: the variant, quantity, computed amount and restock flag. */
export interface RefundLineItem {
  /** The order item's variant being refunded. */
  variantId: string;
  /** Number of units refunded on this line. */
  quantity: number;
  /**
   * The refunded amount for this line (the discounted net for `quantity` units),
   * in shop + presentment currency — derived from the order item's `DualMoney`.
   */
  amount: DualMoney;
  /** Whether these units were returned to inventory. */
  restock: boolean;
  /** The store location the units were restocked at (POS); absent → default location. */
  locationId?: string;
}

/** A processed refund/return against an order. */
export interface Refund extends Timestamps {
  /** Stable refund id. */
  id: string;
  /** The order this refund applies to. */
  orderId: string;
  /** The store that owns the refund (mirrors the order's store identity). */
  storeId?: string;
  /** The P2P seller, when the order was P2P (mirrors the order's seller identity). */
  sellerOxyUserId?: string;
  /** Whether this is a money-only refund or a return (RMA workflow). */
  type: RefundType;
  /** Current lifecycle status. */
  status: RefundStatus;
  /** Optional reason captured by the operator. */
  reason?: string;
  /** The refunded lines. */
  lineItems: RefundLineItem[];
  /** Shipping cost refunded (shop + presentment), when shipping was included. */
  refundShipping?: DualMoney;
  /**
   * Total refunded = sum of every line amount (+ shipping when included), in shop
   * + presentment currency. Reports/customer-stats sum the SHOP side.
   */
  totalRefunded: DualMoney;
  /** Human-friendly return-merchandise authorization number, when assigned. */
  rmaNumber?: string;
  /** ISO-8601 time any line was restocked, when one was. */
  restockedAt?: string;
  /** Oxy user id of the member who processed the refund. */
  processedByOxyUserId?: string;
}

/** A line in a `CreateRefundInput` — the server computes the refundable amount. */
export interface RefundLineInput {
  /** The order item's variant to refund. */
  variantId: string;
  /** Number of units to refund. */
  quantity: number;
  /** Whether to return these units to inventory (defaults to false). */
  restock?: boolean;
  /** The store location to restock at (defaults to the order line's / store default). */
  locationId?: string;
}

/** Body for `POST /admin/stores/:storeId/orders/:id/refunds`. */
export interface CreateRefundInput {
  /** Money-only refund or a return (defaults to `refund`). */
  type?: RefundType;
  /** Optional reason for the refund. */
  reason?: string;
  /** The lines to refund (amounts are computed server-side from the order). */
  lineItems: RefundLineInput[];
  /** When true, also refund the order's shipping cost. */
  refundShipping?: boolean;
  /** Idempotency key — a replayed submit with the same key returns the prior refund. */
  idempotencyKey?: string;
}
