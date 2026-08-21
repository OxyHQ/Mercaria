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
import type { ListingImage } from './listing';
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
   * Which photographs show THIS configuration, and whether they are its own
   * (#850, epic #367).
   *
   * A DISCRIMINATED UNION rather than a plain array, because the two cases mean
   * different things to a seller and a client must not be able to render one as
   * the other. See {@link VariantImageResolution}.
   *
   * Optional for the reason `commercial` is: a variant reaches a client from
   * several projections and only the ones that resolved the gallery may state
   * one. ABSENT is "this surface did not answer the question", never "this
   * variant has no images".
   */
  images?: VariantImageResolution;

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

/**
 * What a variant's gallery resolves to, and WHY (#850, epic #367).
 *
 * ## The decision this type exists to make explicit
 *
 * A variant with no images of its own **falls back to the listing's gallery**.
 * It does not show nothing. That was settled by measurement rather than taste,
 * and the measurement is worth keeping next to the type:
 *
 *  1. **Every P2P listing would go blank.** `insertP2PListingWithin` creates
 *     exactly one `Default Title` variant per secondhand listing and gives it no
 *     images, because there is no surface on which a seller could attach one to
 *     it. "Shows nothing" therefore blanks the gallery on the entire secondhand
 *     half of a marketplace whose premise is buying secondhand from people.
 *  2. **It is what the surrounding code already does.** The PDP resolves every
 *     other variant-scoped fact as `selectedVariant?.x ?? listing.x` — price,
 *     compare-at price, availability. Images were the one such fact with no
 *     variant source to switch on; supplying one should not invert the rule the
 *     other three follow.
 *  3. **It is what a seller expects.** A seller who photographs the blue one and
 *     not the red one has said something about blue, not about red.
 *
 * ## Why a union and not `ListingImage[]`
 *
 * The two cases are different facts, and a surface that cannot tell them apart
 * cannot be honest about either. A seller's variant screen needs to say "this
 * configuration has no photographs of its own" — which a non-empty array
 * indistinguishable from a real selection makes unsayable. A `source` field on a
 * flat array would be the same information, but skippable; a union forces the
 * switch, which is the {@link CommercialPresentation} device one field up.
 *
 * String discriminants, not a boolean: the backend compiles with `strict: false`
 * and without `strictNullChecks` TypeScript does not narrow a union on the
 * truthiness of a boolean-literal discriminant.
 *
 * `images` is never empty in the `listing_fallback` branch UNLESS the listing
 * itself has no photographs, which is a listing-level state this type does not
 * try to describe differently.
 */
export type VariantImageResolution =
  | {
      /** The seller chose these photographs for this configuration. */
      readonly source: 'variant';
      readonly images: readonly ListingImage[];
    }
  | {
      /**
       * This configuration has no photographs of its own and is showing the
       * listing's gallery.
       */
      readonly source: 'listing_fallback';
      readonly images: readonly ListingImage[];
    };

/**
 * Resolve one variant's gallery against its listing's, applying the fallback
 * rule stated on {@link VariantImageResolution}.
 *
 * The ONE place the rule is expressed. Every projection that answers the images
 * question calls this rather than restating `variantImages.length > 0 ? ... :
 * ...`, because two spellings of one rule can disagree and the disagreement
 * would be a blank gallery on one surface and a full one on another.
 */
export function resolveVariantImages(
  variantImages: readonly ListingImage[],
  listingImages: readonly ListingImage[],
): VariantImageResolution {
  if (variantImages.length > 0) {
    return { source: 'variant', images: variantImages };
  }
  return { source: 'listing_fallback', images: listingImages };
}
