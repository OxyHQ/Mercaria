/**
 * `favorites` — a buyer's saved listings.
 *
 * `UNIQUE(oxy_user_id, listing_id)` is what makes the toggle idempotent, and it
 * is now the ONLY thing that does: `insertFavorite` returns whether a row was
 * actually created (`ON CONFLICT DO NOTHING` + `RETURNING`), so the caller moves
 * `listings.favorite_count` exactly when the set really changed. The Mongo path
 * read first and then wrote, which two concurrent saves could both pass —
 * inserting once and counting twice.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { favorites } from '../schema/buyers.js';

/** One row of `favorites`. */
export type FavoriteRecord = InferSelectModel<typeof favorites>;

/**
 * Save a listing.
 *
 * @returns `true` when a row was created, `false` when the buyer had already
 *   saved it. The caller increments `favorite_count` only on `true`, so the
 *   counter cannot drift on a repeated save.
 */
export async function insertFavorite(
  oxyUserId: string,
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .insert(favorites)
    .values({ oxyUserId, listingId })
    .onConflictDoNothing({ target: [favorites.oxyUserId, favorites.listingId] })
    .returning({ id: favorites.id });
  return rows.length > 0;
}

/**
 * Un-save a listing.
 *
 * @returns `true` when a row was removed, `false` when there was nothing to
 *   remove — the mirror of {@link insertFavorite}, and the same reason.
 */
export async function deleteFavorite(
  oxyUserId: string,
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(favorites)
    .where(and(eq(favorites.oxyUserId, oxyUserId), eq(favorites.listingId, listingId)))
    .returning({ id: favorites.id });
  return rows.length > 0;
}

/** Whether the buyer has saved this listing. */
export async function favoriteExists(
  oxyUserId: string,
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: favorites.id })
    .from(favorites)
    .where(and(eq(favorites.oxyUserId, oxyUserId), eq(favorites.listingId, listingId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * A page of the buyer's saved listing ids, most recently saved first, plus the
 * total for the pager.
 */
export async function findFavoriteListingIdsPage(
  oxyUserId: string,
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ listingIds: string[]; total: number }> {
  const where = eq(favorites.oxyUserId, oxyUserId);

  const [rows, [totals]] = await Promise.all([
    db
      .select({ listingId: favorites.listingId })
      .from(favorites)
      .where(where)
      .orderBy(desc(favorites.createdAt), desc(favorites.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(favorites).where(where),
  ]);

  return { listingIds: rows.map((row) => row.listingId), total: totals?.count ?? 0 };
}

/**
 * Of `listingIds`, which has the buyer saved? The batched lookup hydration makes
 * once per page to set `saved`.
 */
export async function findSavedListingIds(
  oxyUserId: string,
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  if (listingIds.length === 0) return new Set();
  const rows = await db
    .select({ listingId: favorites.listingId })
    .from(favorites)
    .where(
      and(eq(favorites.oxyUserId, oxyUserId), inArray(favorites.listingId, [...listingIds])),
    );
  return new Set(rows.map((row) => row.listingId));
}
