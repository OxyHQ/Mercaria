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
  /** This variant's price. */
  price: Money;
  /** Original price when this variant is on sale (omitted when not discounted). */
  compareAtPrice?: Money;
  /** Units currently available to buy. */
  available: number;
  /** Whether this variant can be purchased right now. */
  inStock: boolean;
}
