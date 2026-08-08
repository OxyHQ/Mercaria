/**
 * `inventory_levels` — per-(variant, location) stock, the AUTHORITATIVE record
 * for a store variant.
 *
 * ## The guard and the rowcount
 *
 * `UNIQUE(variant_id, location_id)` is what makes a conditional decrement
 * race-safe at the location grain: there is exactly one row to lock, so
 * `SET available = available - $n WHERE … AND available >= $n` re-evaluates its
 * predicate against the winner's write. **A zero rowcount from
 * {@link reserveAtLocation} means the guard REFUSED**, never "nothing to do" —
 * the caller raises `OUT_OF_STOCK`.
 *
 * Every mutator here leaves the variant's denormalized scalar rollup stale by
 * design; `recomputeVariantRollup` is a separate statement the caller runs
 * afterwards, exactly as the Mongo version did. Folding the rollup in here would
 * make it impossible to move several levels of one variant and recompute once.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { inventoryLevels } from '../schema/catalog.js';

/** One row of `inventory_levels`. */
export type InventoryLevelRecord = InferSelectModel<typeof inventoryLevels>;

/** A level row as a caller supplies it. */
export interface NewInventoryLevel {
  variantId: string;
  listingId: string;
  locationId: string;
  available: number;
  committed?: number;
}

/** One level row, or `null`. */
export async function findLevel(
  variantId: string,
  locationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<InventoryLevelRecord | null> {
  const [row] = await db
    .select()
    .from(inventoryLevels)
    .where(and(eq(inventoryLevels.variantId, variantId), eq(inventoryLevels.locationId, locationId)))
    .limit(1);
  return row ?? null;
}

/** Every level row of one variant, for the per-location stock breakdown. */
export async function findLevelsByVariant(
  variantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<InventoryLevelRecord[]> {
  return db.select().from(inventoryLevels).where(eq(inventoryLevels.variantId, variantId));
}

/** Insert level rows — the initial stocking of a new product's variants. */
export async function insertLevels(
  rows: readonly NewInventoryLevel[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(inventoryLevels).values(
    rows.map((row) => ({
      variantId: row.variantId,
      listingId: row.listingId,
      locationId: row.locationId,
      available: row.available,
      committed: row.committed ?? 0,
    })),
  );
}

/**
 * Set a level's `available` absolutely, creating the row if this location has
 * never stocked the variant.
 *
 * `ON CONFLICT … DO UPDATE` sets ONLY `available`, which is what preserves an
 * existing row's `committed` — the Mongo form spelled that as `$set: {available}`
 * plus `$setOnInsert: {committed: 0}`, and getting it wrong silently releases
 * every in-flight reservation at that location.
 */
export async function setLevelAvailable(
  values: NewInventoryLevel,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .insert(inventoryLevels)
    .values({
      variantId: values.variantId,
      listingId: values.listingId,
      locationId: values.locationId,
      available: values.available,
      committed: values.committed ?? 0,
    })
    .onConflictDoUpdate({
      target: [inventoryLevels.variantId, inventoryLevels.locationId],
      set: { available: values.available, updatedAt: new Date() },
    });
}

/**
 * Reserve `qty` at one location, guarded.
 *
 * @returns `false` when the guard refused — the level has fewer than `qty`
 *   available, or there is no row for this (variant, location) at all. Both are
 *   `OUT_OF_STOCK` to the caller: a variant with no level at the location it is
 *   being sold from has no stock there.
 */
export async function reserveAtLocation(
  variantId: string,
  locationId: string,
  qty: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(inventoryLevels)
    .set({
      available: sql`${inventoryLevels.available} - ${qty}`,
      committed: sql`${inventoryLevels.committed} + ${qty}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(inventoryLevels.variantId, variantId),
        eq(inventoryLevels.locationId, locationId),
        gte(inventoryLevels.available, qty),
      ),
    )
    .returning({ id: inventoryLevels.id });
  return rows.length > 0;
}

/**
 * Move a level's counters by an UNGUARDED delta — commit, release and restock,
 * which settle or return stock a reserve already took.
 *
 * Unguarded on purpose: they run after a reservation succeeded, so refusing one
 * would strand the units rather than protect anything. Both counters clamp at
 * zero so a double commit of the same line cannot make the number meaningless.
 */
export async function adjustLevel(
  variantId: string,
  locationId: string,
  delta: { available?: number; committed?: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(inventoryLevels)
    .set({
      ...(delta.available !== undefined
        ? { available: sql`greatest(0, ${inventoryLevels.available} + ${delta.available})` }
        : {}),
      ...(delta.committed !== undefined
        ? { committed: sql`greatest(0, ${inventoryLevels.committed} + ${delta.committed})` }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(eq(inventoryLevels.variantId, variantId), eq(inventoryLevels.locationId, locationId)),
    );
}
