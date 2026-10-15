import type { Money } from './money';
import type { ItemConditionKey } from './condition';

/** Operator decisions about the explicitly bounded shopping projection, not seller labels. */
export const CATALOG_SAFETY_REVIEW_DECISIONS = ['allow', 'withhold'] as const;
export type CatalogSafetyReviewDecision = (typeof CATALOG_SAFETY_REVIEW_DECISIONS)[number];

export interface ReviewedShoppingVariant {
  id: string;
  title: string;
  options: { id: string; name: string; value: string }[];
  price: Money | null;
}

/** This is the entire child-facing content surface: no arbitrary Listing/Cart spreading. */
export interface ReviewedShoppingListing {
  id: string;
  title: string;
  reviewDigest: string;
  variants: ReviewedShoppingVariant[];
}

/** Full material inspected by a platform operator before approving the text-only projection. */
export interface CatalogSafetyReviewMaterial {
  listing: ReviewedShoppingListing;
  description: string;
  condition: ItemConditionKey;
  conditionDetails: { kind: string; severity: string | null; note: string | null }[];
  options: { id: string; name: string; values: string[] }[];
  imageFileIds: string[];
  status: string;
  latestDecision: CatalogSafetyReviewDecision | null;
  reviewCurrent: boolean;
}

/** Oversized source records are unavailable without returning partial review material. */
export type CatalogSafetyReviewCandidate =
  | CatalogSafetyReviewMaterial
  | {
      listingId: string;
      unavailableReason: 'review_limit_exceeded';
    };

export interface ReviewedShoppingCart {
  items: {
    listingId: string;
    variantId: string;
    quantity: number;
    /** Unavailable items carry no unreviewed text, media or price. */
    selection: {
      title: string;
      variantTitle: string;
      options: { id: string; name: string; value: string }[];
      unitPrice: Money;
      lineTotal: Money;
      stale: boolean;
    } | null;
  }[];
  subtotal: Money | null;
  checkoutAvailable: boolean;
}
