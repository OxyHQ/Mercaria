/**
 * `product_saves` — the only writer of a canonical product save (#80).
 *
 * Every mutating function here is idempotent by CONSTRUCTION rather than by a
 * prior read: the insert is `ON CONFLICT DO NOTHING` on
 * `product_saves_oxy_user_id_canonical_product_id_key`, the delete reports
 * whether a row was actually removed, and the split marking carries its own
 * predicate. That is what makes #80 acceptance 5 ("save toggles are idempotent
 * under repeated taps and network retries") true of a retrying mobile client
 * and of two concurrent taps, which a read-then-write cannot be — the
 * `favoriteRepository` note one table over records the same lesson from the
 * Mongo port.
 *
 * The COUNTER is not touched here. It is derived from these rows by
 * `productSaveAggregateRepository`, so no function in this file can move a
 * number, and a caller that forgets to rebuild leaves a detectable drift rather
 * than a wrong count that nothing can notice (#80 counter rule 3).
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { ConditionGroup, ProductSaveSourceContext } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { productSaves } from '../schema/productSaves.js';

/** One row of `product_saves`. */
export type ProductSaveRow = InferSelectModel<typeof productSaves>;

/** Everything a caller may supply when creating a save. */
export interface NewProductSave {
  readonly oxyUserId: string;
  readonly canonicalProductId: string;
  readonly sourceContext: ProductSaveSourceContext;
  readonly preferredCanonicalVariantId?: string | null;
  readonly preferredConditionGroup?: ConditionGroup | null;
  readonly preferredMerchantId?: string | null;
  readonly referencePriceAmount?: number | null;
  readonly referencePriceCurrency?: string | null;
  readonly referencePriceObservedAt?: Date | null;
  readonly migrationVersion?: string | null;
}

/**
 * Create a save, or leave the existing one exactly as it is.
 *
 * `DO NOTHING` and not `DO UPDATE`: a second save of a product the buyer
 * already saves must not overwrite the preferences they set on the first, and
 * must not move `created_at` — which is the saved list's ordering key, so a
 * repeated tap would otherwise reshuffle their list. The returned row is the
 * one that survived either way, which is what makes the HTTP response identical
 * on the first call and the fifth.
 */
export async function insertProductSave(
  input: NewProductSave,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ save: ProductSaveRow; created: boolean }> {
  const inserted = await db
    .insert(productSaves)
    .values({
      oxyUserId: input.oxyUserId,
      canonicalProductId: input.canonicalProductId,
      sourceContext: input.sourceContext,
      preferredCanonicalVariantId: input.preferredCanonicalVariantId ?? null,
      preferredConditionGroup: input.preferredConditionGroup ?? null,
      preferredMerchantId: input.preferredMerchantId ?? null,
      referencePriceAmount: input.referencePriceAmount ?? null,
      referencePriceCurrency: input.referencePriceCurrency ?? null,
      referencePriceObservedAt: input.referencePriceObservedAt ?? null,
      migrationVersion: input.migrationVersion ?? null,
    })
    .onConflictDoNothing({
      target: [productSaves.oxyUserId, productSaves.canonicalProductId],
    })
    .returning();

  const created = inserted[0];
  if (created) return { save: created, created: true };

  const existing = await findProductSave(input.oxyUserId, input.canonicalProductId, db);
  if (!existing) {
    // Unreachable in practice: the insert conflicted, so a row exists. A
    // concurrent DELETE between the two statements is the only way here, and
    // throwing is the honest answer — the caller retries and converges rather
    // than being handed a save that is not there.
    throw new Error(
      `product_saves conflicted for ${input.canonicalProductId} and then no row was found; ` +
        'a concurrent unsave landed between the insert and the read.',
    );
  }
  return { save: existing, created: false };
}

/** Un-save. `true` when a row was removed, `false` when there was nothing to remove. */
export async function deleteProductSave(
  oxyUserId: string,
  canonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(productSaves)
    .where(
      and(
        eq(productSaves.oxyUserId, oxyUserId),
        eq(productSaves.canonicalProductId, canonicalProductId),
      ),
    )
    .returning({ id: productSaves.id });
  return rows.length > 0;
}

/** One save, by its owner and its product. */
export async function findProductSave(
  oxyUserId: string,
  canonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductSaveRow | undefined> {
  const rows = await db
    .select()
    .from(productSaves)
    .where(
      and(
        eq(productSaves.oxyUserId, oxyUserId),
        eq(productSaves.canonicalProductId, canonicalProductId),
      ),
    )
    .limit(1);
  return rows[0];
}

/** What a buyer may change about an existing save (#80 API rule 5). */
export interface ProductSavePreferences {
  readonly preferredCanonicalVariantId?: string | null;
  readonly preferredConditionGroup?: ConditionGroup | null;
  readonly preferredMerchantId?: string | null;
}

/**
 * Change a save's preferences.
 *
 * Only the keys PRESENT in `preferences` are written, and an explicit `null`
 * clears one — "leave it alone" and "clear it" are different requests and a
 * PATCH that could not tell them apart would make a preferred variant
 * impossible to remove.
 */
export async function updateProductSavePreferences(
  oxyUserId: string,
  canonicalProductId: string,
  preferences: ProductSavePreferences,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductSaveRow | undefined> {
  const patch: Record<string, string | null> = {};
  if ('preferredCanonicalVariantId' in preferences) {
    patch['preferredCanonicalVariantId'] = preferences.preferredCanonicalVariantId ?? null;
  }
  if ('preferredConditionGroup' in preferences) {
    patch['preferredConditionGroup'] = preferences.preferredConditionGroup ?? null;
  }
  if ('preferredMerchantId' in preferences) {
    patch['preferredMerchantId'] = preferences.preferredMerchantId ?? null;
  }
  if (Object.keys(patch).length === 0) {
    return findProductSave(oxyUserId, canonicalProductId, db);
  }

  const rows = await db
    .update(productSaves)
    .set(patch)
    .where(
      and(
        eq(productSaves.oxyUserId, oxyUserId),
        eq(productSaves.canonicalProductId, canonicalProductId),
      ),
    )
    .returning();
  return rows[0];
}

/** The keyset a saved-items page resumes from. */
export interface SavedCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * One page of a buyer's saved products, newest first.
 *
 * The ordering is `(created_at desc, id desc)` and both halves are written out,
 * because a plain SQL row comparison is what the `product_saves_oxy_user_id_created_at_id_idx`
 * index serves and because `created_at` alone is not unique — two saves made in
 * the same millisecond would otherwise straddle a page boundary and one of them
 * would never be returned. Ids here are uuid v7 and uuid v7 is NOT monotonic
 * within a millisecond (`~/Oxy/AGENTS.md`), so `id` is used purely as a
 * TIEBREAKER for stability and never as a claim about creation order.
 */
export async function findProductSavePage(
  oxyUserId: string,
  limit: number,
  after: SavedCursor | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductSaveRow[]> {
  const where = after
    ? and(
        eq(productSaves.oxyUserId, oxyUserId),
        or(
          lt(productSaves.createdAt, after.createdAt),
          and(eq(productSaves.createdAt, after.createdAt), lt(productSaves.id, after.id)),
        ),
      )
    : eq(productSaves.oxyUserId, oxyUserId);

  return db
    .select()
    .from(productSaves)
    .where(where)
    .orderBy(desc(productSaves.createdAt), desc(productSaves.id))
    .limit(limit);
}

/** Of `canonicalProductIds`, which does this buyer already save? */
export async function findSavedCanonicalProductIds(
  oxyUserId: string,
  canonicalProductIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  if (canonicalProductIds.length === 0) return new Set();
  const rows = await db
    .select({ canonicalProductId: productSaves.canonicalProductId })
    .from(productSaves)
    .where(
      and(
        eq(productSaves.oxyUserId, oxyUserId),
        inArray(productSaves.canonicalProductId, [...canonicalProductIds]),
      ),
    );
  return new Set(rows.map((row) => row.canonicalProductId));
}

/**
 * Mark every RESOLVED save of one product as ambiguous, naming the split that
 * divided it (#80 migration rule 8).
 *
 * `resolution_state = 'resolved'` is in the predicate, so a re-run of the phase
 * writes nothing and a save already made ambiguous by an EARLIER split keeps
 * naming that earlier job — the buyer answers one question at a time, and
 * silently retargeting an unanswered one at a newer job would lose the
 * candidates they were being asked about.
 *
 * @returns how many saves were marked.
 */
export async function markProductSavesAmbiguousAfterSplit(
  canonicalProductId: string,
  splitJobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .update(productSaves)
    .set({ resolutionState: 'ambiguous_after_split', ambiguousSplitJobId: splitJobId })
    .where(
      and(
        eq(productSaves.canonicalProductId, canonicalProductId),
        eq(productSaves.resolutionState, 'resolved'),
      ),
    )
    .returning({ id: productSaves.id });
  return rows.length;
}

/**
 * Clear one save's ambiguity — the buyer has answered.
 *
 * A CAS on "still ambiguous", so two taps of the same answer converge on one
 * write and the second reports `false` rather than clearing an ambiguity a
 * LATER split raised in between.
 */
export async function clearProductSaveAmbiguity(
  saveId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(productSaves)
    .set({ resolutionState: 'resolved', ambiguousSplitJobId: null })
    .where(
      and(
        eq(productSaves.id, saveId),
        eq(productSaves.resolutionState, 'ambiguous_after_split'),
      ),
    )
    .returning({ id: productSaves.id });
  return rows.length > 0;
}

/**
 * Repoint one ambiguous save at the split's other candidate and clear it.
 *
 * `ON CONFLICT` cannot help here — this is an UPDATE, and the unique it could
 * violate is `(oxy_user_id, canonical_product_id)`. So the caller checks for an
 * existing save of the destination first and deletes this row instead when
 * there is one; that path is in `split-resolution.ts`, where the DECISION lives,
 * rather than hidden in a repository that would then be making it.
 */
export async function repointProductSave(
  saveId: string,
  toCanonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductSaveRow | undefined> {
  const rows = await db
    .update(productSaves)
    .set({
      canonicalProductId: toCanonicalProductId,
      resolutionState: 'resolved',
      ambiguousSplitJobId: null,
      // The preference is dropped with the move: a variant of the product this
      // save is LEAVING does not exist under the one it is arriving at, and
      // carrying it would leave a foreign key pointing across the split.
      preferredCanonicalVariantId: null,
    })
    .where(eq(productSaves.id, saveId))
    .returning();
  return rows[0];
}

/** One save by id, scoped to its owner — the only way a buyer reaches one. */
export async function findProductSaveByIdForOwner(
  saveId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductSaveRow | undefined> {
  const rows = await db
    .select()
    .from(productSaves)
    .where(and(eq(productSaves.id, saveId), eq(productSaves.oxyUserId, oxyUserId)))
    .limit(1);
  return rows[0];
}

/**
 * Erase every save belonging to one Oxy account (#80 privacy rule 5).
 *
 * A single scoped DELETE is the WHOLE of "remove or anonymize according to
 * ecosystem policy", and that is a property of the schema rather than of this
 * function: a save row holds an Oxy account id and a product id and nothing
 * else — no name, no handle, no email, no avatar, no contact detail — so there
 * is nothing left over to anonymize and no second table to sweep.
 *
 * @returns the products whose counters the caller must now rebuild, and how
 *   many rows went. The caller rebuilds; this function moves no number, for the
 *   reason stated in the module header.
 */
export async function deleteProductSavesForOxyUser(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ deleted: number; canonicalProductIds: string[] }> {
  const rows = await db
    .delete(productSaves)
    .where(eq(productSaves.oxyUserId, oxyUserId))
    .returning({ canonicalProductId: productSaves.canonicalProductId });
  return {
    deleted: rows.length,
    canonicalProductIds: [...new Set(rows.map((row) => row.canonicalProductId))],
  };
}

/**
 * The products a merge or a bulk change must re-derive counters for.
 *
 * Bounded and resumable — an unbounded `select distinct` over the whole table
 * is exactly the shape that works in a test database and times out in
 * production.
 */
export async function findCanonicalProductIdsWithSaves(
  limit: number,
  afterProductId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ canonicalProductId: productSaves.canonicalProductId })
    .from(productSaves)
    .where(afterProductId ? sql`${productSaves.canonicalProductId} > ${afterProductId}` : undefined)
    .orderBy(asc(productSaves.canonicalProductId))
    .limit(limit);
  return rows.map((row) => row.canonicalProductId);
}

/** How many saves one product actually has, counted from the rows. */
export async function countProductSaves(
  canonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productSaves)
    .where(eq(productSaves.canonicalProductId, canonicalProductId));
  return rows[0]?.count ?? 0;
}

/** Saves waiting on their owner to answer a split — the buyer's own count. */
export async function countAmbiguousProductSaves(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productSaves)
    .where(
      and(
        eq(productSaves.oxyUserId, oxyUserId),
        eq(productSaves.resolutionState, 'ambiguous_after_split'),
        isNotNull(productSaves.ambiguousSplitJobId),
      ),
    );
  return rows[0]?.count ?? 0;
}

/** Saves the #80 migration created, for the operator trace. Never who made them. */
export async function countMigratedProductSaves(
  canonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productSaves)
    .where(
      and(
        eq(productSaves.canonicalProductId, canonicalProductId),
        isNotNull(productSaves.migrationVersion),
      ),
    );
  return rows[0]?.count ?? 0;
}

/** Saves a person made themselves — the complement of the count above. */
export async function countBuyerAuthoredProductSaves(
  canonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productSaves)
    .where(
      and(
        eq(productSaves.canonicalProductId, canonicalProductId),
        isNull(productSaves.migrationVersion),
      ),
    );
  return rows[0]?.count ?? 0;
}
