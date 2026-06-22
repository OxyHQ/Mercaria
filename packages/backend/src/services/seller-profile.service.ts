/**
 * Seller-profile service.
 *
 * Owns the lazy lifecycle + preference edits of an individual P2P seller's
 * marketplace profile (`SellerProfile`), keyed by Oxy user id. Display identity
 * (name/avatar) is NEVER stored here — it is read live from Oxy at hydration
 * time; this service only manages the Mercaria-owned aggregates and prefs.
 */

import { SellerProfile, type ISellerProfile } from '../models/seller-profile.js';

/**
 * Get the seller profile for `oxyUserId`, creating an empty one on first use
 * (lazy). Idempotent under concurrent first-writes via an upsert.
 */
export async function getOrCreate(oxyUserId: string): Promise<ISellerProfile> {
  const profile = await SellerProfile.findOneAndUpdate(
    { oxyUserId },
    { $setOnInsert: { oxyUserId } },
    { returnDocument: 'after', upsert: true },
  ).lean<ISellerProfile>();
  return profile;
}

/** Return the seller's own profile, creating it lazily if absent. */
export async function getMine(oxyUserId: string): Promise<ISellerProfile> {
  return getOrCreate(oxyUserId);
}

/** Editable shipping/return preferences. */
export interface SellerPrefsInput {
  shippingPrefs?: {
    note?: string;
    handlingDays?: number;
  };
  returnPrefs?: {
    accepts?: boolean;
    windowDays?: number;
  };
}

/** Update the seller's shipping/return preferences (lazily creating the profile). */
export async function updatePrefs(
  oxyUserId: string,
  prefs: SellerPrefsInput,
): Promise<ISellerProfile> {
  const set: Record<string, unknown> = {};
  if (prefs.shippingPrefs !== undefined) {
    set.shippingPrefs = prefs.shippingPrefs;
  }
  if (prefs.returnPrefs !== undefined) {
    set.returnPrefs = prefs.returnPrefs;
  }

  const profile = await SellerProfile.findOneAndUpdate(
    { oxyUserId },
    { $setOnInsert: { oxyUserId }, ...(Object.keys(set).length > 0 ? { $set: set } : {}) },
    { returnDocument: 'after', upsert: true },
  ).lean<ISellerProfile>();
  return profile;
}
