/**
 * `seller_profiles` — the marketplace aggregates Mercaria owns for a P2P seller.
 *
 * Display name, username and avatar are NEVER stored here: they are read live
 * from the Oxy profile at hydration time. This table holds only what Mercaria
 * itself computes — verification, the review aggregate, the sales counter — plus
 * the seller's shipping and return preferences.
 *
 * ## One owner for `sales_count`, and for the four sites that render it
 *
 * The commerce core bumps `sales_count` when an order is paid, and the cart's
 * vendor header, the catalogue's seller card and an order's seller summary all
 * read it back. The write and those readers stay in this one repository against
 * this one table: a counter incremented in one place and rendered from another
 * is not a design, it is a wrong number.
 *
 * ## Every write is an UPSERT, because the profile is lazily created
 *
 * A seller has no row until their first listing, first sale or first review, and
 * all three of those can be the same moment. `ON CONFLICT (oxy_user_id) DO
 * UPDATE` is the port of Mongoose's `upsert: true` and makes each of them
 * idempotent under a concurrent first write.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { sellerProfiles } from '../schema/buyers.js';

/** One row of `seller_profiles`. */
export type SellerProfileRecord = InferSelectModel<typeof sellerProfiles>;

/** The editable shipping/return preferences. */
export interface SellerProfilePrefs {
  shippingPrefs?: { note?: string; handlingDays?: number };
  returnPrefs?: { accepts?: boolean; windowDays?: number };
}

/** One seller's profile, or `null` when they have never had one created. */
export async function findSellerProfile(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerProfileRecord | null> {
  const [row] = await db
    .select()
    .from(sellerProfiles)
    .where(eq(sellerProfiles.oxyUserId, oxyUserId))
    .limit(1);
  return row ?? null;
}

/**
 * Several sellers' profiles by Oxy account id — the ONE query every hydration
 * path makes for a whole page of listings, cart lines or orders.
 */
export async function findSellerProfilesByUserIds(
  oxyUserIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerProfileRecord[]> {
  if (oxyUserIds.length === 0) return [];
  return db
    .select()
    .from(sellerProfiles)
    .where(inArray(sellerProfiles.oxyUserId, [...oxyUserIds]));
}

/**
 * The seller's profile, created empty on first use.
 *
 * `DO UPDATE` rather than `DO NOTHING` so the statement always returns a row: a
 * `DO NOTHING` that conflicts returns nothing at all, which would make this
 * return `undefined` for exactly the case it exists to serve. The update is a
 * no-op touch of `updated_at`, which is also the honest record that something
 * asked for the profile.
 */
export async function ensureSellerProfile(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerProfileRecord> {
  const [row] = await db
    .insert(sellerProfiles)
    .values({ oxyUserId })
    .onConflictDoUpdate({
      target: sellerProfiles.oxyUserId,
      set: { updatedAt: new Date() },
    })
    .returning();
  return row;
}

/** Update a seller's shipping/return preferences, creating the profile if absent. */
export async function upsertSellerPrefs(
  oxyUserId: string,
  prefs: SellerProfilePrefs,
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerProfileRecord> {
  // The four nested fields flatten into four columns, and each is only written
  // when its parent object was supplied — patching `shippingPrefs` alone must not
  // erase a stored return window.
  const columns = {
    ...(prefs.shippingPrefs !== undefined
      ? {
          shippingPrefsNote: prefs.shippingPrefs.note ?? null,
          shippingPrefsHandlingDays: prefs.shippingPrefs.handlingDays ?? null,
        }
      : {}),
    ...(prefs.returnPrefs !== undefined
      ? {
          returnPrefsAccepts: prefs.returnPrefs.accepts ?? null,
          returnPrefsWindowDays: prefs.returnPrefs.windowDays ?? null,
        }
      : {}),
  };

  const [row] = await db
    .insert(sellerProfiles)
    .values({ oxyUserId, ...columns })
    .onConflictDoUpdate({
      target: sellerProfiles.oxyUserId,
      set: { ...columns, updatedAt: new Date() },
    })
    .returning();
  return row;
}

/**
 * Move a seller's `sales_count` by `delta`, clamped at zero, creating the profile
 * if this is their first sale.
 *
 * The clamp is in SQL rather than a read-modify-write for the reason
 * `adjustStoreProductCount` states: two concurrent moves would otherwise read the
 * same count and write the same result, losing one. `greatest(0, …)` keeps the
 * counter from going negative if the two halves of a sale/cancel pair are ever
 * counted unevenly.
 */
export async function adjustSellerSalesCount(
  oxyUserId: string,
  delta: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .insert(sellerProfiles)
    .values({ oxyUserId, salesCount: Math.max(0, delta) })
    .onConflictDoUpdate({
      target: sellerProfiles.oxyUserId,
      set: {
        salesCount: sql`greatest(0, ${sellerProfiles.salesCount} + ${delta})`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Persist a seller's recomputed review aggregate, creating the profile if absent.
 *
 * An absolute SET rather than an increment: `review.service` derives both figures
 * from the published reviews in one aggregate, so this is the whole answer and
 * not a delta to apply.
 */
export async function setSellerRating(
  oxyUserId: string,
  rating: number,
  reviewCount: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .insert(sellerProfiles)
    .values({ oxyUserId, rating, reviewCount })
    .onConflictDoUpdate({
      target: sellerProfiles.oxyUserId,
      set: { rating, reviewCount, updatedAt: new Date() },
    });
}
