/**
 * `product_save_sources` — which listing favorite the #80 migration read, and
 * which product save it produced (#80 migration rule 5).
 *
 * The table is append-only by trigger, so there is deliberately no update here
 * and no delete: the only way a row leaves is the `ON DELETE CASCADE` from the
 * favorite it names, which is a buyer un-saving that listing.
 *
 * Nothing in this file is what makes a replay safe. #80 migration rule 6 rests
 * on `product_saves_oxy_user_id_canonical_product_id_key` and on the counter
 * being derived; this record converges on its OWN unique so the LOG does not
 * grow on a replay, which is a different property and stated separately because
 * conflating them would make the cascade above look like a hole.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { productSaveSources, productSaves } from '../schema/productSaves.js';

/** One row of `product_save_sources`. */
export type ProductSaveSourceRow = InferSelectModel<typeof productSaveSources>;

/** The provenance one migrated favorite records. */
export interface NewProductSaveSource {
  readonly saveId: string;
  readonly favoriteId: string;
  readonly listingId: string;
  readonly productVariantId: string;
  readonly migrationVersion: string;
}

/**
 * Record that one favorite produced one save.
 *
 * `ON CONFLICT DO NOTHING` on `(favorite_id, migration_version)`: re-running the
 * SAME mapping version over a favorite it already read writes nothing at all —
 * no tuple version, no timestamp — which is what makes a replay a genuine
 * no-op rather than a quiet write (the `moderation_outboxes` enqueue's
 * reasoning, and the reason the append-only trigger and this conflict clause
 * are not redundant with each other).
 *
 * @returns `true` when a row was created.
 */
export async function insertProductSaveSource(
  input: NewProductSaveSource,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .insert(productSaveSources)
    .values({ ...input, recordedAt: new Date() })
    .onConflictDoNothing({
      target: [productSaveSources.favoriteId, productSaveSources.migrationVersion],
    })
    .returning({ id: productSaveSources.id });
  return rows.length > 0;
}

/** Whether this favorite has already been read under this mapping version. */
export async function productSaveSourceExists(
  favoriteId: string,
  migrationVersion: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: productSaveSources.id })
    .from(productSaveSources)
    .where(
      and(
        eq(productSaveSources.favoriteId, favoriteId),
        eq(productSaveSources.migrationVersion, migrationVersion),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Of `favoriteIds`, which are REPRESENTED by a product save that still exists?
 *
 * The join back to `product_saves` is the point and is not a belt-and-braces
 * check: the migration record survives the save being deleted (a buyer un-saving
 * the product), and a listing then shown as "covered by your product save" when
 * no such save exists would hide it from the saved list entirely. Derived at
 * read time, never stored, so the buyer sees the listing reappear in the
 * statement that removed the product save.
 */
export async function findRepresentedFavoriteIds(
  favoriteIds: readonly string[],
  migrationVersion: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  if (favoriteIds.length === 0) return new Set();
  const rows = await db
    .select({ favoriteId: productSaveSources.favoriteId })
    .from(productSaveSources)
    .innerJoin(productSaves, eq(productSaves.id, productSaveSources.saveId))
    .where(
      and(
        inArray(productSaveSources.favoriteId, [...favoriteIds]),
        eq(productSaveSources.migrationVersion, migrationVersion),
      ),
    );
  return new Set(rows.map((row) => row.favoriteId));
}

/** How many favorites one save was derived from — the operator trace's read. */
export async function countProductSaveSources(
  saveId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productSaveSources)
    .where(eq(productSaveSources.saveId, saveId));
  return rows[0]?.count ?? 0;
}
