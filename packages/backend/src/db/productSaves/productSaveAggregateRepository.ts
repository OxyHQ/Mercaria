/**
 * `product_save_aggregates` — the derived save counter, and the drift probe
 * that makes it checkable (#80 counter rules 1 and 3, acceptance 6).
 *
 * Everything here DERIVES. There is no increment, no decrement and no delta
 * parameter anywhere in this file, which is what makes the rebuild idempotent
 * and what makes a merge's rollup phase correct: a merge that ADDED the loser's
 * count to the winner's would double-count every buyer who saved both, and a
 * count has no rows beside it to catch the error with. `review_aggregates` is
 * the precedent and the reasoning is the same one #59 merge invariant 6 states.
 *
 * The drift probe REPAIRS NOTHING. It reports the pairs that disagree and
 * leaves the rebuild to an explicit operator action — the `payment_discrepancies`
 * posture, for the reason that a sweep that silently rewrote the number would
 * also silently hide whatever was writing the wrong one.
 */

import { asc, eq, gt, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { ListingFavoriteCounterRow, ProductSaveCounterRow } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { productSaveAggregates, productSaves } from '../schema/productSaves.js';
import { favorites } from '../schema/buyers.js';
import { listings } from '../schema/catalog.js';

/** One row of `product_save_aggregates`. */
export type ProductSaveAggregateRow = InferSelectModel<typeof productSaveAggregates>;

/**
 * Re-derive one product's save count from `product_saves` and store it.
 *
 * The count is computed by the DATABASE inside the same statement that writes
 * it, so two concurrent rebuilds cannot interleave a stale read with a later
 * write — the value stored is always the value the row set held at the moment
 * of the write, whichever rebuild wins.
 *
 * Takes a `DatabaseOrTransaction` and defaults to the root connection rather
 * than opening its own. That is load-bearing where it is called from a curation
 * phase: `rebuildScopedAggregate` opening a SECOND connection inside a phase
 * transaction deadlocked a merge against itself (`services/curation/rollups.ts`
 * records the incident), and a function that can join the caller's transaction
 * cannot repeat it.
 */
export async function rebuildProductSaveAggregate(
  canonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const derived = sql<number>`(select count(*)::int from ${productSaves}
                               where ${productSaves.canonicalProductId} = ${canonicalProductId})`;

  const rows = await db
    .insert(productSaveAggregates)
    .values({
      canonicalProductId,
      saveCount: derived,
      lastRebuiltAt: new Date(),
    })
    .onConflictDoUpdate({
      target: productSaveAggregates.canonicalProductId,
      set: { saveCount: derived, lastRebuiltAt: new Date() },
    })
    .returning({ saveCount: productSaveAggregates.saveCount });

  return rows[0]?.saveCount ?? 0;
}

/** The stored counters for a batch of products — the saved-list read's one query. */
export async function findProductSaveAggregates(
  canonicalProductIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, ProductSaveAggregateRow>> {
  if (canonicalProductIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(productSaveAggregates)
    .where(sql`${productSaveAggregates.canonicalProductId} = any(${sql.param([...canonicalProductIds])}::text[])`);
  return new Map(rows.map((row) => [row.canonicalProductId, row]));
}

/** One product's stored counter. */
export async function findProductSaveAggregate(
  canonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductSaveAggregateRow | undefined> {
  const rows = await db
    .select()
    .from(productSaveAggregates)
    .where(eq(productSaveAggregates.canonicalProductId, canonicalProductId))
    .limit(1);
  return rows[0];
}

/**
 * A bounded, resumable page of products whose STORED count disagrees with the
 * count derived from `product_saves`.
 *
 * The comparison is done in SQL against a correlated count, so the two numbers
 * are read in one snapshot — comparing a stored count fetched now against a
 * derived count fetched a moment later would report drift that a concurrent
 * save created between the two reads, which is a false alarm and the worst
 * possible output for a probe whose job is to be believed.
 *
 * Cursored on `canonical_product_id` rather than on the drift itself: the
 * cursor has to advance over rows the page REJECTED as well as the ones it
 * returned, or a sweep would restart from the first agreeing row forever.
 */
export async function findProductSaveCounterDrift(
  limit: number,
  afterProductId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ scanned: number; drift: ProductSaveCounterRow[]; nextCursor?: string }> {
  // Written with EXPLICIT table qualification rather than through drizzle's
  // column interpolation, and that is load-bearing: a column of a table that is
  // not in the subquery's own `FROM` renders UNQUALIFIED, so
  // `${productSaveAggregates.canonicalProductId}` becomes a bare
  // `canonical_product_id` which Postgres resolves against `product_saves` —
  // turning the correlation into `ps.canonical_product_id = ps.canonical_product_id`,
  // a tautology that counts the WHOLE table for every row. It reports a plausible
  // number, which is why it was caught by a realdb case asserting the value and
  // not by anything a mock could have said.
  const derived = sql<number>`(select count(*)::int from product_saves ps
                               where ps.canonical_product_id
                                     = product_save_aggregates.canonical_product_id)`;

  const rows = await db
    .select({
      canonicalProductId: productSaveAggregates.canonicalProductId,
      storedCount: productSaveAggregates.saveCount,
      derivedCount: derived,
      lastRebuiltAt: productSaveAggregates.lastRebuiltAt,
    })
    .from(productSaveAggregates)
    .where(
      afterProductId
        ? gt(productSaveAggregates.canonicalProductId, afterProductId)
        : undefined,
    )
    .orderBy(asc(productSaveAggregates.canonicalProductId))
    .limit(limit);

  const drift = rows
    .filter((row) => row.storedCount !== row.derivedCount)
    .map((row) => ({
      canonicalProductId: row.canonicalProductId,
      storedCount: row.storedCount,
      derivedCount: row.derivedCount,
      ...(row.lastRebuiltAt ? { lastRebuiltAt: row.lastRebuiltAt.toISOString() } : {}),
    }));

  const last = rows[rows.length - 1];
  return {
    scanned: rows.length,
    drift,
    ...(rows.length === limit && last ? { nextCursor: last.canonicalProductId } : {}),
  };
}

/**
 * `listings.favorite_count`, re-derived from `favorites`.
 *
 * #80 counter rule 2 keeps the listing counter scoped to EXACT listing saves,
 * and rule 3 makes it repairable from source records — which it was not before:
 * `favorite.service` moves it by ±1 on a real set change, which is race-safe but
 * has no way back if a row is ever removed by anything other than that path (an
 * `ON DELETE CASCADE` from a deleted listing is exactly such a path, and a
 * merge or a restore is another). Deriving it is the repair, and the counter
 * stays incremental in the hot path because a save must not pay for a count.
 */
export async function rebuildListingFavoriteCount(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .update(listings)
    .set({
      favoriteCount: sql`(select count(*)::int from ${favorites}
                          where ${favorites.listingId} = ${listingId})`,
    })
    .where(eq(listings.id, listingId))
    .returning({ favoriteCount: listings.favoriteCount });
  return rows[0]?.favoriteCount ?? 0;
}

/** The listing-counter half of the drift probe. Same shape, same reasoning. */
export async function findListingFavoriteCounterDrift(
  limit: number,
  afterListingId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ scanned: number; drift: ListingFavoriteCounterRow[]; nextCursor?: string }> {
  // Explicitly qualified, for the reason stated on the product-side probe above.
  const derived = sql<number>`(select count(*)::int from favorites f
                               where f.listing_id = listings.id)`;

  const rows = await db
    .select({
      listingId: listings.id,
      storedCount: listings.favoriteCount,
      derivedCount: derived,
    })
    .from(listings)
    .where(afterListingId ? gt(listings.id, afterListingId) : undefined)
    .orderBy(asc(listings.id))
    .limit(limit);

  const drift = rows
    .filter((row) => row.storedCount !== row.derivedCount)
    .map((row) => ({
      listingId: row.listingId,
      storedCount: row.storedCount,
      derivedCount: row.derivedCount,
    }));

  const last = rows[rows.length - 1];
  return {
    scanned: rows.length,
    drift,
    ...(rows.length === limit && last ? { nextCursor: last.listingId } : {}),
  };
}

/**
 * The aggregates a rebuild sweep should visit next: never rebuilt first, then
 * oldest rebuilt.
 *
 * `review_aggregates_last_rebuilt_at_idx`' cursor, reused — nulls first is what
 * makes a freshly created aggregate the sweep's next stop rather than its last.
 */
export async function findStaleProductSaveAggregates(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ canonicalProductId: productSaveAggregates.canonicalProductId })
    .from(productSaveAggregates)
    .orderBy(sql`${productSaveAggregates.lastRebuiltAt} asc nulls first`)
    .limit(limit);
  return rows.map((row) => row.canonicalProductId);
}

/**
 * Every aggregate row of one product, for the operator trace.
 *
 * Deliberately returns COUNTS and a timestamp and nothing else — there is no
 * actor column on this table to return, which is #80 privacy rule 1 held by an
 * absence rather than by a projection somebody has to keep honest.
 */
export async function readProductSaveAggregateTrace(
  canonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ stored?: ProductSaveAggregateRow; derived: number }> {
  const [stored, derivedRows] = await Promise.all([
    findProductSaveAggregate(canonicalProductId, db),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(productSaves)
      .where(eq(productSaves.canonicalProductId, canonicalProductId)),
  ]);
  return { ...(stored ? { stored } : {}), derived: derivedRows[0]?.count ?? 0 };
}
