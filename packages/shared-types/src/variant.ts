/**
 * Product variant DTO for the Mercaria.
 *
 * A `Listing` is the sellable product; its `variants` are the concrete buyable
 * SKUs (e.g. "Size: M / Color: Black"). Each variant carries its own price and
 * availability. P2P (secondhand) listings always have exactly one default
 * variant; store products may have many.
 *
 * The internal inventory `committed` count (units reserved by pending orders) is
 * NEVER exposed on the wire — clients only ever see `available` and `inStock`.
 */

import type { CommercialPresentation } from './commercial-presentation';
import type { Money } from './money';

/** A single option assignment for a variant (e.g. `{ name: 'Size', value: 'M' }`). */
export interface VariantOptionValue {
  /** Option name (e.g. `Size`). */
  name: string;
  /** Selected value for that option (e.g. `M`). */
  value: string;
}

/** A concrete buyable SKU of a `Listing`. */
export interface ProductVariantDTO {
  /** Stable variant id. */
  id: string;
  /** Human-readable variant title (e.g. `M / Black`, or `Default Title`). */
  title: string;
  /** The option assignments that define this variant (empty for P2P listings). */
  optionValues: VariantOptionValue[];
  /** Stock-keeping unit, when set by the seller. */
  sku?: string;
  /** Barcode (UPC/EAN/ISBN, etc.), when set by the seller. */
  barcode?: string;
  /** This variant's price. */
  price: Money;
  /** Original price when this variant is on sale (omitted when not discounted). */
  compareAtPrice?: Money;
  /** Units currently available to buy. */
  available: number;
  /** Whether this variant can be purchased right now. */
  inStock: boolean;
  /**
   * Who is selling THIS configuration, and what the buyer is told about it
   * (#129).
   *
   * On the VARIANT rather than on the `Listing`, because that is where the fact
   * lives: `retail_offer_bindings` is keyed on `product_variant_id`, so a
   * listing can in principle carry some configurations Mercaria sells itself
   * and some it does not. A listing-level claim would have to pick one answer
   * for both, and the wrong half of that pick is `Sold by Mercaria` over
   * somebody else's stock. It also means switching a swatch can change the
   * disclosure, which is truthful rather than surprising.
   *
   * Optional because a variant reaches a client from several projections and
   * only the ones that resolved the binding may state one — an ABSENT
   * disclosure is a surface that has not answered the question, which a client
   * must treat as "do not claim a seller", never as a marketplace default.
   */
  commercial?: CommercialPresentation;
}
