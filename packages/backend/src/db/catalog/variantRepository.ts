/**
 * `product_variants` — the reads and writes the ported domains make today.
 *
 * Only the inventory ROLLUP lives here so far. The rest of the variant surface
 * (create, patch, remove, and the guarded stock mutators) arrives with the
 * catalogue write path; this module grows with its callers rather than shipping
 * functions nothing calls, which is how a repository quietly accumulates a
 * second, subtly different way to do the same write.
 */

import { eq, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { inventoryLevels, productVariants } from '../schema/catalog.js';

/** One row of `product_variants`. */
export type VariantRecord = InferSelectModel<typeof productVariants>;

/**
 * Recompute a variant's scalar `inventory_*` as the SUM over its
 * `inventory_levels` rows — the denormalized rollup every other read of a store
 * variant's stock goes through.
 *
 * ## The correlation is against a BOUND id, and that is not a style choice
 *
 * A drizzle column interpolated into `sql` renders BARE when its table is not in
 * that statement's FROM. Written the obvious way,
 * `where ${inventoryLevels.variantId} = ${productVariants.id}` renders
 * `where "variant_id" = "id"` — BOTH names then resolve against
 * `inventory_levels` itself, the predicate compares two of its own columns to
 * each other, and the sum comes back as though the variant had stock nowhere,
 * with NO error at all. That exact shape shipped in a sibling Oxy port and read
 * zero on every profile until a test caught it. Passing `variantId` as a
 * parameter makes the correlation unambiguous.
 *
 * `coalesce(…, 0)` is what turns a variant with no level rows — an untracked or
 * P2P variant — into a rollup of zero rather than the NULL the column forbids.
 */
export async function recomputeVariantRollup(
  variantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const [totals] = await db
    .select({
      available: sql<number>`coalesce(sum(${inventoryLevels.available}), 0)::int`,
      committed: sql<number>`coalesce(sum(${inventoryLevels.committed}), 0)::int`,
    })
    .from(inventoryLevels)
    .where(eq(inventoryLevels.variantId, variantId));

  await db
    .update(productVariants)
    .set({
      inventoryAvailable: totals?.available ?? 0,
      inventoryCommitted: totals?.committed ?? 0,
      updatedAt: new Date(),
    })
    .where(eq(productVariants.id, variantId));
}
