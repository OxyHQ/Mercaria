/**
 * Seller-profile service.
 *
 * Owns the lazy lifecycle + preference edits of an individual P2P seller's
 * marketplace profile, keyed by Oxy user id. Display identity (name/avatar) is
 * NEVER stored here — it is read live from Oxy at hydration time; this service
 * only manages the Mercaria-owned aggregates and prefs.
 *
 * The aggregates themselves are written elsewhere and deliberately not through
 * here: `order.service` bumps `salesCount` at the paid transition and
 * `review.service` sets the rating from its own recompute, both via the
 * repository. Routing those through this module would put a counter behind a
 * function whose job is preferences.
 */

import {
  ensureSellerProfile,
  upsertSellerPrefs,
  type SellerProfilePrefs,
  type SellerProfileRecord,
} from '../db/buyers/sellerProfileRepository.js';

export type { SellerProfileRecord };

/** Editable shipping/return preferences. */
export type SellerPrefsInput = SellerProfilePrefs;

/**
 * Get the seller profile for `oxyUserId`, creating an empty one on first use
 * (lazy). Idempotent under concurrent first-writes via an upsert.
 */
export async function getOrCreate(oxyUserId: string): Promise<SellerProfileRecord> {
  return ensureSellerProfile(oxyUserId);
}

/** Return the seller's own profile, creating it lazily if absent. */
export async function getMine(oxyUserId: string): Promise<SellerProfileRecord> {
  return getOrCreate(oxyUserId);
}

/** Update the seller's shipping/return preferences (lazily creating the profile). */
export async function updatePrefs(
  oxyUserId: string,
  prefs: SellerPrefsInput,
): Promise<SellerProfileRecord> {
  return upsertSellerPrefs(oxyUserId, prefs);
}
