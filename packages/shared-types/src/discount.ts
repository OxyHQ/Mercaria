/**
 * Discount DTOs for the Mercaria pricing engine (B4).
 *
 * A `Discount` is a store-scoped promotion that reduces the price the buyer pays.
 * It is applied either by entering a CODE at the cart/checkout (`method: 'code'`)
 * or AUTOMATICALLY for every eligible cart (`method: 'automatic'`). The amount it
 * removes is expressed by `valueType`: a `percentage` (basis points, 1500 = 15%),
 * a `fixed_amount` (FAIR integer minor units), or a `bogo`/`free_item` buy-X-get-Y
 * rule. Discounts target the whole ORDER, specific PRODUCTS, or whole COLLECTIONS.
 *
 * Authoritative discount → tax → grand-total math runs server-side in the pricing
 * service; these types are the wire contract for the admin CRUD surface and for
 * the per-order `DiscountAllocation` breakdown persisted on a placed order.
 */

import type { Money } from './money';

/** How a discount is applied: by entering a code, or automatically. */
export type DiscountMethod = 'code' | 'automatic';

/**
 * What kind of reduction a discount makes.
 *
 * - `percentage` — `value` is basis points (1500 = 15%) off the applicable base.
 * - `fixed_amount` — `value` is FAIR minor units removed (clamped to the base).
 * - `bogo` — buy-X-get-Y at a discounted rate (`buy`/`get` drive the math).
 * - `free_item` — buy-X-get-Y free (a `bogo` whose get-discount is 100%).
 */
export type DiscountValueType = 'percentage' | 'fixed_amount' | 'bogo' | 'free_item';

/** What a discount (or one of its buy/get legs) targets. */
export type DiscountScope = 'order' | 'products' | 'collections';

/** A single redeemable code on a code-method discount, with its redemption count. */
export interface DiscountCode {
  /** The code the buyer enters (normalized to uppercase server-side). */
  code: string;
  /** How many times this code has been redeemed (drives usage limits). */
  usageCount: number;
}

/** The scope a discount applies to (whole order, or specific products/collections). */
export interface DiscountAppliesTo {
  /** Whether the discount targets the order, specific products, or collections. */
  scope: DiscountScope;
  /** Product ids the discount applies to, when `scope === 'products'`. */
  productIds?: string[];
  /** Collection ids the discount applies to, when `scope === 'collections'`. */
  collectionIds?: string[];
}

/** The "buy" leg of a BOGO/free-item rule: which units qualify and how many. */
export interface DiscountBuyLeg {
  /** How many qualifying units must be bought to unlock the "get" reward. */
  quantity: number;
  /** Whether the qualifying units are matched by product or by collection. */
  scope: Exclude<DiscountScope, 'order'>;
  /** Product ids that qualify, when `scope === 'products'`. */
  productIds?: string[];
  /** Collection ids that qualify, when `scope === 'collections'`. */
  collectionIds?: string[];
}

/** The "get" leg of a BOGO/free-item rule: which units are discounted and by how much. */
export interface DiscountGetLeg {
  /** How many units are discounted per unlocked reward. */
  quantity: number;
  /** Whether the rewarded units are matched by product or by collection. */
  scope: Exclude<DiscountScope, 'order'>;
  /** Product ids eligible for the reward, when `scope === 'products'`. */
  productIds?: string[];
  /** Collection ids eligible for the reward, when `scope === 'collections'`. */
  collectionIds?: string[];
  /**
   * Basis points off each rewarded unit (10000 = free). Absent on a `free_item`
   * discount (treated as 100% off); optional on a `bogo` discount.
   */
  discountPercent?: number;
}

/** A minimum the cart must meet for the discount to apply. */
export interface DiscountMinimumRequirement {
  /** What is measured: nothing, the subtotal, or the total quantity. */
  type: 'none' | 'subtotal' | 'quantity';
  /** The threshold (FAIR minor units for `subtotal`, a unit count for `quantity`). */
  value: number;
}

/** Which customers a discount is available to. */
export interface DiscountCustomerEligibility {
  /** Whether everyone, specific customers, or members of groups are eligible. */
  type: 'all' | 'groups' | 'customers';
  /** Oxy user ids eligible, when `type === 'customers'`. */
  customerIds?: string[];
  /** Customer group tags eligible, when `type === 'groups'`. */
  groupTags?: string[];
}

/** Caps on how many times a discount may be used. */
export interface DiscountUsageLimits {
  /** Maximum total redemptions across all customers (unset = unlimited). */
  totalMax?: number;
  /** Maximum redemptions per customer (unset = unlimited). */
  perCustomerMax?: number;
}

/** Which other discount classes this discount is allowed to stack with. */
export interface DiscountCombinesWith {
  /** Stacks with another ORDER-level discount. */
  orderDiscounts: boolean;
  /** Stacks with a PRODUCT-level discount. */
  productDiscounts: boolean;
  /** Stacks with a shipping discount (reserved; shipping discounts are a later seam). */
  shippingDiscounts: boolean;
}

/** A store-scoped promotion that reduces the price the buyer pays. */
export interface Discount {
  /** Stable discount id. */
  id: string;
  /** The store that owns the discount. */
  storeId: string;
  /** Admin-facing title. */
  title: string;
  /** How the discount is applied (by code, or automatically). */
  method: DiscountMethod;
  /** Redeemable codes (with usage counts), for `method: 'code'`. */
  codes: DiscountCode[];
  /** The kind of reduction the discount makes. */
  valueType: DiscountValueType;
  /** Basis points (percentage) or FAIR minor units (fixed_amount); may be 0 for bogo/free_item. */
  value: number;
  /** What the discount targets (order / products / collections). */
  appliesTo: DiscountAppliesTo;
  /** The "buy" leg, for `bogo`/`free_item`. */
  buy?: DiscountBuyLeg;
  /** The "get" leg, for `bogo`/`free_item`. */
  get?: DiscountGetLeg;
  /** A minimum the cart must meet to apply. */
  minimumRequirement?: DiscountMinimumRequirement;
  /** Which customers the discount is available to. */
  customerEligibility?: DiscountCustomerEligibility;
  /** Caps on total/per-customer redemptions. */
  usageLimits?: DiscountUsageLimits;
  /** Which other discount classes this discount is allowed to stack with. */
  combinesWith: DiscountCombinesWith;
  /** ISO-8601 time the discount becomes active. */
  startsAt: string;
  /** ISO-8601 time the discount expires, when it does. */
  endsAt?: string;
  /** Whether the discount is currently enabled. */
  isActive: boolean;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 last-update time. */
  updatedAt: string;
}

/**
 * One discount's contribution to an order, persisted on the placed order so a
 * later refund can attribute the reduction exactly. A `target: 'order'`
 * allocation reduces the whole order; a `target: 'line'` allocation reduces one
 * specific line (`targetLineIndex`), so line-scoped discounts are refundable
 * per line.
 */
export interface DiscountAllocation {
  /** The discount that produced this allocation. */
  discountId: string;
  /** The code redeemed, for a code-method discount. */
  code?: string;
  /** The discount's title at apply time (snapshot). */
  title: string;
  /** The discount's value type at apply time (snapshot). */
  valueType: DiscountValueType;
  /** The amount this allocation removes (FAIR minor units). */
  amount: Money;
  /** Whether the allocation reduces the whole order or one line. */
  target: 'order' | 'line';
  /** The index of the reduced line, when `target === 'line'`. */
  targetLineIndex?: number;
}

/** A buy/get leg as accepted by the admin create/update discount payloads. */
export interface DiscountLegInput {
  quantity: number;
  scope: Exclude<DiscountScope, 'order'>;
  productIds?: string[];
  collectionIds?: string[];
  discountPercent?: number;
}

/** Payload accepted when creating a discount. */
export interface CreateDiscountInput {
  title: string;
  method: DiscountMethod;
  /** Codes to mint (`code` strings); usage counts start at 0. Required for `method: 'code'`. */
  codes?: string[];
  valueType: DiscountValueType;
  value: number;
  appliesTo: DiscountAppliesTo;
  buy?: DiscountLegInput;
  get?: DiscountLegInput;
  minimumRequirement?: DiscountMinimumRequirement;
  customerEligibility?: DiscountCustomerEligibility;
  usageLimits?: DiscountUsageLimits;
  combinesWith?: Partial<DiscountCombinesWith>;
  startsAt?: string;
  endsAt?: string;
  isActive?: boolean;
}

/** Partial payload accepted when updating a discount. */
export type UpdateDiscountInput = Partial<CreateDiscountInput>;

/** Body for `POST /cart/discount` — apply a discount code to the cart. */
export interface ApplyCartDiscountInput {
  /** The code to apply (validated against an active store discount). */
  code: string;
}
