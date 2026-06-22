/**
 * Draft order DTOs for the Mercaria store-admin POS surface (B5).
 *
 * A `DraftOrder` is the POS CART a store member builds at the register: line
 * items are added/edited against the live catalog, discount codes and a customer
 * may be attached, and totals are recomputed through the SAME pricing engine the
 * storefront uses. When the sale is taken, the draft `complete`s — it reserves
 * stock, freezes immutable line snapshots, and converts into a paid `Order`
 * (`sourceChannel: 'pos'`, `convertedOrderId`). Unlike an `Order`, an open draft
 * is MUTABLE; once completed/cancelled it is terminal.
 */

import type { Money, CurrencyCode } from './money';
import type { Timestamps } from './common';
import type { AddressSnapshot } from './order';
import type { DiscountAllocation } from './discount';
import type { TaxLine } from './tax';

/** Lifecycle status of a draft order. `open` is mutable; the others are terminal. */
export type DraftOrderStatus = 'open' | 'completed' | 'cancelled';

/** A mutable line on a draft order, snapshotted from the live catalog when added. */
export interface DraftOrderLineItem {
  /** The listing the line buys from. */
  listingId: string;
  /** The concrete variant. */
  variantId: string;
  /** Listing title at the time the line was added. */
  title: string;
  /** Variant title at the time the line was added. */
  variantTitle: string;
  /** Unit price (live variant price snapshotted onto the line). */
  unitPrice: Money;
  /** Quantity of this variant on the draft. */
  quantity: number;
  /** Variant option assignments. */
  optionValues: { name: string; value: string }[];
  /** Discount attributed to this line by the pricing engine, when non-zero. */
  discountTotal?: Money;
}

/** A POS cart that converts into a paid `Order`. */
export interface DraftOrder extends Timestamps {
  /** Stable draft order id. */
  id: string;
  /** The store that owns the draft. */
  storeId: string;
  /** The register/location the sale is taken at (reserve/commit target). */
  locationId?: string;
  /** The attached customer, when one was set. */
  customerId?: string;
  /** Oxy user id of the store member who created the draft (the POS operator). */
  createdByOxyUserId: string;
  /** Current lifecycle status. */
  status: DraftOrderStatus;
  /** The mutable line items. */
  lineItems: DraftOrderLineItem[];
  /** Discount codes applied to the draft (re-priced on every recompute). */
  discountCodes: string[];
  /** Per-discount breakdown produced by the pricing engine. */
  appliedDiscounts: DiscountAllocation[];
  /** Per-rate tax breakdown produced by the pricing engine. */
  taxLines: TaxLine[];
  /** A captured shipping/contact address, when one was set. */
  shippingAddress?: AddressSnapshot;
  /** Money totals, recomputed on every mutation through the pricing engine. */
  totals: {
    /** Sum of every line total. */
    subtotal: Money;
    /** Total of every applied discount allocation (0 when none). */
    discountTotal: Money;
    /** Total tax added (0 when none / tax-inclusive). */
    tax: Money;
    /** Shipping cost (always 0 for POS pickup). */
    shipping: Money;
    /** `subtotal - discountTotal + tax + shipping`. */
    grandTotal: Money;
  };
  /** Settlement currency for every amount (the store's default currency). */
  currency: CurrencyCode;
  /** Internal POS note. */
  note?: string;
  /** The id of the `Order` this draft converted into, once completed. */
  convertedOrderId?: string;
}

/** Body for `POST /admin/stores/:storeId/draft-orders` — open a new draft. */
export interface CreateDraftOrderInput {
  /** The register/location the sale is taken at; defaults to the store default. */
  locationId?: string;
  /** A customer to attach at creation time. */
  customerId?: string;
}

/** Body for `POST /admin/stores/:storeId/draft-orders/:id/lines` — add a line. */
export interface AddDraftLineInput {
  listingId: string;
  variantId: string;
  quantity: number;
}

/** Body for `PATCH .../lines/:variantId` — set a line's quantity (0 removes it). */
export interface UpdateDraftLineInput {
  quantity: number;
}

/** Body for `POST .../discounts` — replace the draft's applied discount codes. */
export interface ApplyDraftDiscountsInput {
  codes: string[];
}

/** Body for `POST .../customer` — attach a customer to the draft. */
export interface SetDraftCustomerInput {
  customerId: string;
}

/** Body for `PATCH /admin/stores/:storeId/draft-orders/:id` — note / shipping address. */
export interface UpdateDraftOrderInput {
  note?: string;
  shippingAddress?: AddressSnapshot;
}

/**
 * Body for `POST .../complete` — take the POS sale. Empty for now: payment is an
 * Oxy Pay seam, so completion reserves stock + converts the draft to a paid order
 * without any additional client input.
 */
export type CompleteDraftOrderInput = Record<string, never>;
