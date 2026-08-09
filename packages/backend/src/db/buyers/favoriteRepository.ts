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

import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { ListingSaveIntent } from '@mercaria/shared-types';
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
 *
 * `DO NOTHING` and not `DO UPDATE`, even though #80 added `save_intent`: a
 * conflict branch that also wrote the intent would return a row either way, and
 * the boolean above — which the counter depends on — would stop meaning "a row
 * was created". Changing an existing save's intent is
 * {@link updateFavoriteSaveIntent}, a separate statement with a separate job.
 */
export async function insertFavorite(
  oxyUserId: string,
  listingId: string,
  saveIntent: ListingSaveIntent = 'listing_save',
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .insert(favorites)
    .values({ oxyUserId, listingId, saveIntent })
    .onConflictDoNothing({ target: [favorites.oxyUserId, favorites.listingId] })
    .returning({ id: favorites.id });
  return rows.length > 0;
}

/**
 * Change an existing listing save's intent (#80 listing rule 4).
 *
 * Called ONLY when a client stated an intent explicitly. A v1 client's plain
 * `POST /favorites/:listingId` carries none, and must not silently turn a
 * buyer's deliberate pin back into an unqualified listing save — which is why
 * this is a separate call the service makes conditionally rather than something
 * the insert does on conflict.
 */
export async function updateFavoriteSaveIntent(
  oxyUserId: string,
  listingId: string,
  saveIntent: ListingSaveIntent,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(favorites)
    .set({ saveIntent })
    .where(and(eq(favorites.oxyUserId, oxyUserId), eq(favorites.listingId, listingId)))
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
 * One page of the buyer's listing saves, newest first, keyset-paginated.
 *
 * The offset pager above stays exactly as it is for `GET /favorites`; this is
 * the read the #80 merged saved-items list uses, and it orders by
 * `(created_at desc, id desc)` — the SAME ordering `product_saves` uses — so
 * the two streams can be merged under ONE stable cursor (#80 API rule 7). An
 * offset pager cannot be merged that way: the offsets are per-table and a save
 * arriving in either one shifts both.
 */
export async function findFavoritePage(
  oxyUserId: string,
  limit: number,
  after: { createdAt: Date; id: string } | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<FavoriteRecord[]> {
  const where = after
    ? and(
        eq(favorites.oxyUserId, oxyUserId),
        or(
          lt(favorites.createdAt, after.createdAt),
          and(eq(favorites.createdAt, after.createdAt), lt(favorites.id, after.id)),
        ),
      )
    : eq(favorites.oxyUserId, oxyUserId);

  return db
    .select()
    .from(favorites)
    .where(where)
    .orderBy(desc(favorites.createdAt), desc(favorites.id))
    .limit(limit);
}

/**
 * A bounded, resumable page of listing saves across ALL buyers, ordered by id.
 *
 * The #80 migration's cursor. Ordered by the primary key rather than by
 * `created_at` because the cursor has to advance over every row the page
 * examined — including the ones it left alone, which is most of them once the
 * migration has run — and `id` is the only column that is unique and stable
 * under concurrent writes.
 */
export async function findFavoriteMigrationPage(
  limit: number,
  afterId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<FavoriteRecord[]> {
  return db
    .select()
    .from(favorites)
    .where(afterId ? sql`${favorites.id} > ${afterId}` : undefined)
    .orderBy(favorites.id)
    .limit(limit);
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

/** One listing save, by its owner and its listing — the two-button page's read. */
export async function findFavorite(
  oxyUserId: string,
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<FavoriteRecord | undefined> {
  const rows = await db
    .select()
    .from(favorites)
    .where(and(eq(favorites.oxyUserId, oxyUserId), eq(favorites.listingId, listingId)))
    .limit(1);
  return rows[0];
}
