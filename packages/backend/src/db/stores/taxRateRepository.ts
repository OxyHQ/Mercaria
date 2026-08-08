/**
 * `tax_rates` — a store-scoped tax rule, matched by region and priority.
 *
 * The plainest table in the port: a flat Mongoose document with one embedded
 * `region` object, which flattens into three columns. The only thing worth
 * stating is what `product_type_scope` means, because Postgres can represent a
 * distinction Mongo blurred.
 *
 * **NULL and `{}` are different values here, and the service must keep them
 * apart.** Mongoose declared `default: undefined`, i.e. ABSENT — "this rate is
 * not scoped to any particular product type, so it applies to all of them". An
 * EMPTY array is the opposite: "scoped to no product type at all", which matches
 * nothing. A patch that writes `[]` where it meant to clear the scope silently
 * disables the rate.
 */

import { and, asc, desc, eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { taxRates } from '../schema/stores.js';

/** One row of `tax_rates`. */
export type TaxRateRecord = InferSelectModel<typeof taxRates>;

/** The fields a caller may set when creating a tax rate. */
export interface NewTaxRate {
  name: string;
  rateBps: number;
  regionCountry: string | null;
  regionRegion: string | null;
  regionPostalCodePattern: string | null;
  appliesToShipping: boolean;
  productTypeScope: string[] | null;
  priority: number;
  isActive: boolean;
}

/** A store's tax rates, highest priority first then newest — the admin list order. */
export async function findTaxRatesByStore(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TaxRateRecord[]> {
  return db
    .select()
    .from(taxRates)
    .where(eq(taxRates.storeId, storeId))
    .orderBy(desc(taxRates.priority), desc(taxRates.createdAt));
}

/**
 * A store's ACTIVE tax rates — the pricing engine's one query per seller group.
 *
 * Ordered highest priority first with `id` as the tiebreaker, which is the order
 * the engine applies them in: the Mongo path sorted in memory by
 * `priority desc, _id asc` after loading, and doing it in SQL keeps that ordering
 * a property of the read rather than of whoever calls it next.
 */
export async function findActiveTaxRates(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TaxRateRecord[]> {
  return db
    .select()
    .from(taxRates)
    .where(and(eq(taxRates.storeId, storeId), eq(taxRates.isActive, true)))
    .orderBy(desc(taxRates.priority), asc(taxRates.id));
}

/** One tax rate scoped to its store, or `null` — the scoping IS the authorization. */
export async function findTaxRate(
  storeId: string,
  taxRateId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TaxRateRecord | null> {
  const [row] = await db
    .select()
    .from(taxRates)
    .where(and(eq(taxRates.id, taxRateId), eq(taxRates.storeId, storeId)))
    .limit(1);
  return row ?? null;
}

/** Create a tax rate for a store. */
export async function insertTaxRate(
  storeId: string,
  values: NewTaxRate,
  db: DatabaseOrTransaction = getDb(),
): Promise<TaxRateRecord> {
  const [row] = await db
    .insert(taxRates)
    .values({ storeId, ...values })
    .returning();
  return row;
}

/** Patch a tax rate scoped to its store. Returns `null` when it is not that store's. */
export async function updateTaxRate(
  storeId: string,
  taxRateId: string,
  patch: Partial<NewTaxRate>,
  db: DatabaseOrTransaction = getDb(),
): Promise<TaxRateRecord | null> {
  const [row] = await db
    .update(taxRates)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(taxRates.id, taxRateId), eq(taxRates.storeId, storeId)))
    .returning();
  return row ?? null;
}

/** Delete a tax rate scoped to its store. `false` when it was not that store's. */
export async function deleteTaxRate(
  storeId: string,
  taxRateId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(taxRates)
    .where(and(eq(taxRates.id, taxRateId), eq(taxRates.storeId, storeId)))
    .returning({ id: taxRates.id });
  return rows.length > 0;
}
