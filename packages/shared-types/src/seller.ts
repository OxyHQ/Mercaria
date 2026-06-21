/**
 * Seller DTO for the Mercaria.
 *
 * A seller is the public-facing identity that owns a listing. It is backed by an
 * Oxy user account (`oxyUserId`); display fields are denormalized onto the DTO so
 * the frontend renders directly without a second lookup.
 */

/** Public seller identity attached to listings. */
export interface Seller {
  /** Stable seller id (Mercaria-scoped). */
  id: string;
  /** Owning Oxy user account id. */
  oxyUserId: string;
  /** Canonical display name (from the Oxy profile contract). */
  displayName: string;
  /** Oxy username/handle, without the leading `@`. */
  username: string;
  /** Avatar file id resolvable via the Oxy media CDN, when present. */
  avatar?: string | null;
  /** Whether the seller's identity has been verified. */
  isVerified: boolean;
  /** Aggregate rating in the range 0–5, when the seller has reviews. */
  rating?: number;
  /** Total number of reviews contributing to `rating`. */
  reviewCount?: number;
}
