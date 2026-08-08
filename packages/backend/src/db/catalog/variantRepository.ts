/**
 * `product_variants`, `product_variant_option_values`, and the scalar stock
 * guards that live on the variant row.
 *
 * ## The guarded decrement is the whole point of this module
 *
 * Mongo's `updateOne({available: {$gte: qty}}, {$inc: …})` is a CONDITIONAL
 * write whose condition and mutation are evaluated together, which is what made
 * two concurrent reserves unable to both succeed past the stock. The Postgres
 * form is `UPDATE … SET available = available - $n WHERE … AND available >= $n`,
 * and it has the same property for the same reason: the row is locked for the
 * duration of the statement, so the predicate is re-checked against the winner's
 * write rather than against a value read earlier.
 *
 * **The rowcount IS the answer.** Every guarded mutator here returns whether it
 * matched, and a zero means "the guard refused", never "nothing to do" — the
 * caller turns that into `OUT_OF_STOCK`. A read-then-write would be a different
 * function with the same signature and a lost-update bug.
 */

import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { CurrencyCode } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { inventoryLevels, productVariantOptionValues, productVariants } from '../schema/catalog.js';

/** One row of `product_variants`. */
export type VariantRecord = InferSelectModel<typeof productVariants>;

/** One row of `product_variant_option_values`. */
export type VariantOptionValueRecord = InferSelectModel<typeof productVariantOptionValues>;

/** A `{name, value}` option assignment as a caller supplies it. */
export interface OptionValueInput {
  name: string;
  value: string;
}

/** A variant as a caller supplies it, before it has an id. */
export interface NewVariant {
  title: string;
  sku?: string;
  barcode?: string;
  priceAmount: number | null;
  priceCurrency: CurrencyCode | null;
  compareAtPriceAmount?: number | null;
  compareAtPriceCurrency?: CurrencyCode | null;
  inventoryTracked: boolean;
  inventoryAvailable: number;
  position: number;
  optionValues: OptionValueInput[];
  sourceConnectionId?: string | null;
  sourceProvider?: VariantRecord['sourceProvider'];
  sourceExternalVariantId?: string | null;
  sourceExternalInventoryItemId?: string | null;
}

/** The columns a caller may patch on an existing variant. */
export interface VariantPatch {
  title?: string;
  sku?: string | null;
  barcode?: string | null;
  priceAmount?: number | null;
  priceCurrency?: CurrencyCode | null;
  compareAtPriceAmount?: number | null;
  compareAtPriceCurrency?: CurrencyCode | null;
  inventoryTracked?: boolean;
  inventoryAvailable?: number;
  position?: number;
  sourceExternalInventoryItemId?: string | null;
}

/** One variant, or `null`. */
export async function findVariantById(
  variantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<VariantRecord | null> {
  const [row] = await db
    .select()
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .limit(1);
  return row ?? null;
}

/** One variant scoped to its listing, or `null` — the scoping IS the authorization. */
export async function findVariantInListing(
  listingId: string,
  variantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<VariantRecord | null> {
  const [row] = await db
    .select()
    .from(productVariants)
    .where(and(eq(productVariants.id, variantId), eq(productVariants.listingId, listingId)))
    .limit(1);
  return row ?? null;
}

/** A listing's variants in display order. */
export async function findVariantsByListing(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<VariantRecord[]> {
  return db
    .select()
    .from(productVariants)
    .where(eq(productVariants.listingId, listingId))
    .orderBy(asc(productVariants.position));
}

/**
 * Every variant of a BATCH of listings, ordered by listing then position — the
 * one query hydration makes for a whole page.
 */
export async function findVariantsByListingIds(
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<VariantRecord[]> {
  if (listingIds.length === 0) return [];
  return db
    .select()
    .from(productVariants)
    .where(inArray(productVariants.listingId, [...listingIds]))
    .orderBy(asc(productVariants.listingId), asc(productVariants.position));
}

/** Several variants by id, unordered — the cart/checkout line resolution. */
export async function findVariantsByIds(
  variantIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<VariantRecord[]> {
  if (variantIds.length === 0) return [];
  return db.select().from(productVariants).where(inArray(productVariants.id, [...variantIds]));
}

/** The `{name, value}` pairs of a batch of variants, in position order. */
export async function findVariantOptionValues(
  variantIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, VariantOptionValueRecord[]>> {
  const grouped = new Map<string, VariantOptionValueRecord[]>();
  if (variantIds.length === 0) return grouped;

  const rows = await db
    .select()
    .from(productVariantOptionValues)
    .where(inArray(productVariantOptionValues.variantId, [...variantIds]))
    .orderBy(asc(productVariantOptionValues.position));

  for (const row of rows) {
    const bucket = grouped.get(row.variantId);
    if (bucket) bucket.push(row);
    else grouped.set(row.variantId, [row]);
  }
  return grouped;
}

/** How many variants a listing has. Guards the "keep at least one" rule. */
export async function countVariants(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productVariants)
    .where(eq(productVariants.listingId, listingId));
  return row?.count ?? 0;
}

/** Write a variant's option values, replacing whatever it had. */
async function replaceOptionValues(
  variantId: string,
  optionValues: readonly OptionValueInput[],
  db: DatabaseOrTransaction,
): Promise<void> {
  await db
    .delete(productVariantOptionValues)
    .where(eq(productVariantOptionValues.variantId, variantId));
  if (optionValues.length === 0) return;
  await db.insert(productVariantOptionValues).values(
    optionValues.map((option, position) => ({
      variantId,
      name: option.name,
      value: option.value,
      position,
    })),
  );
}

/** A `sku`/`barcode` a caller left empty must be NULL — see {@link insertVariants}. */
function nullIfEmpty(value: string | null | undefined): string | null {
  return value !== undefined && value !== null && value.length > 0 ? value : null;
}

/**
 * Insert variants and their option values, atomically.
 *
 * A `sku` or `barcode` a caller left empty is written NULL and never `''`: both
 * columns carry a PARTIAL unique index, and an empty string is a VALUE — the
 * second variant saved without a SKU would collide with the first for real,
 * which is the trap `CONVENTIONS.md` names by name.
 */
export async function insertVariants(
  listingId: string,
  variants: readonly NewVariant[],
  db: DatabaseOrTransaction = getDb(),
): Promise<VariantRecord[]> {
  if (variants.length === 0) return [];

  const run = async (tx: DatabaseOrTransaction): Promise<VariantRecord[]> => {
    const rows = await tx
      .insert(productVariants)
      .values(
        variants.map((variant) => ({
          listingId,
          title: variant.title,
          sku: nullIfEmpty(variant.sku),
          barcode: nullIfEmpty(variant.barcode),
          priceAmount: variant.priceAmount,
          priceCurrency: variant.priceCurrency,
          compareAtPriceAmount: variant.compareAtPriceAmount ?? null,
          compareAtPriceCurrency: variant.compareAtPriceCurrency ?? null,
          inventoryTracked: variant.inventoryTracked,
          inventoryAvailable: variant.inventoryAvailable,
          position: variant.position,
          sourceConnectionId: variant.sourceConnectionId ?? null,
          sourceProvider: variant.sourceProvider ?? null,
          sourceExternalVariantId: variant.sourceExternalVariantId ?? null,
          sourceExternalInventoryItemId: variant.sourceExternalInventoryItemId ?? null,
        })),
      )
      .returning();

    for (const [index, row] of rows.entries()) {
      await replaceOptionValues(row.id, variants[index].optionValues, tx);
    }
    return rows;
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}

/** Patch a variant scoped to its listing, optionally replacing its option values. */
export async function updateVariant(
  listingId: string,
  variantId: string,
  patch: VariantPatch,
  optionValues: readonly OptionValueInput[] | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<VariantRecord | null> {
  const run = async (tx: DatabaseOrTransaction): Promise<VariantRecord | null> => {
    const [row] = await tx
      .update(productVariants)
      .set({
        ...patch,
        // Same NULL-not-empty-string rule as the insert path — a cleared SKU must
        // not become a value that collides with the next cleared one.
        ...(patch.sku !== undefined ? { sku: nullIfEmpty(patch.sku) } : {}),
        ...(patch.barcode !== undefined ? { barcode: nullIfEmpty(patch.barcode) } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(productVariants.id, variantId), eq(productVariants.listingId, listingId)))
      .returning();

    if (!row) return null;
    if (optionValues !== undefined) {
      await replaceOptionValues(variantId, optionValues, tx);
    }
    return row;
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}

/** Delete a variant scoped to its listing. `false` when it was not that listing's. */
export async function deleteVariant(
  listingId: string,
  variantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(productVariants)
    .where(and(eq(productVariants.id, variantId), eq(productVariants.listingId, listingId)))
    .returning({ id: productVariants.id });
  return rows.length > 0;
}

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

/**
 * Reserve `qty` on a variant's SCALAR stock (the P2P path), guarded.
 *
 * @returns `false` when the guard refused — i.e. the variant is tracked and has
 *   fewer than `qty` available. The caller raises `OUT_OF_STOCK`; it is never
 *   "nothing to do".
 */
export async function reserveVariantScalar(
  variantId: string,
  qty: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(productVariants)
    .set({
      inventoryAvailable: sql`${productVariants.inventoryAvailable} - ${qty}`,
      inventoryCommitted: sql`${productVariants.inventoryCommitted} + ${qty}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(productVariants.id, variantId),
        eq(productVariants.inventoryTracked, true),
        gte(productVariants.inventoryAvailable, qty),
      ),
    )
    .returning({ id: productVariants.id });
  return rows.length > 0;
}

/**
 * Move a variant's scalar stock by an UNGUARDED delta — commit, release and
 * restock, which return or settle stock a reserve already took.
 *
 * Unguarded on purpose: these run after a reservation succeeded, so refusing
 * them would strand the units rather than protect anything. Both counters are
 * clamped at zero because a double commit of the same line is a bug that should
 * not also make the number meaningless.
 */
export async function adjustVariantScalar(
  variantId: string,
  delta: { available?: number; committed?: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(productVariants)
    .set({
      ...(delta.available !== undefined
        ? {
            inventoryAvailable: sql`greatest(0, ${productVariants.inventoryAvailable} + ${delta.available})`,
          }
        : {}),
      ...(delta.committed !== undefined
        ? {
            inventoryCommitted: sql`greatest(0, ${productVariants.inventoryCommitted} + ${delta.committed})`,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(productVariants.id, variantId), eq(productVariants.inventoryTracked, true)));
}

/** Set a variant's scalar available stock absolutely (the P2P admin path). */
export async function setVariantScalarAvailable(
  variantId: string,
  available: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(productVariants)
    .set({ inventoryAvailable: available, updatedAt: new Date() })
    .where(eq(productVariants.id, variantId));
}

/**
 * One variant of a connection, resolved by the external platform's own variant
 * id — the connector's re-sync and inbound-webhook lookup.
 */
export async function findVariantBySourceExternalId(
  connectionId: string,
  externalVariantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<VariantRecord | null> {
  const [row] = await db
    .select()
    .from(productVariants)
    .where(
      and(
        eq(productVariants.sourceConnectionId, connectionId),
        eq(productVariants.sourceExternalVariantId, externalVariantId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * One variant of a connection, resolved by the platform's INVENTORY-ITEM id —
 * the key an `inventory_levels/update` webhook carries, which is not the variant
 * id.
 */
export async function findVariantBySourceInventoryItemId(
  connectionId: string,
  inventoryItemId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<VariantRecord | null> {
  const [row] = await db
    .select()
    .from(productVariants)
    .where(
      and(
        eq(productVariants.sourceConnectionId, connectionId),
        eq(productVariants.sourceExternalInventoryItemId, inventoryItemId),
      ),
    )
    .limit(1);
  return row ?? null;
}
