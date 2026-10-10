/**
 * `stores` and `store_permission_overrides`.
 *
 * A store row is the whole store: who may act for it is NOT here. The store is
 * owned by an Oxy account (`oxy_account_id`, ADR 0012) and Oxy decides who
 * belongs to that account — `services/store-access.service.ts` asks it. The one
 * thing Mercaria keeps is the per-person EXCEPTION to the role map, which is
 * what the override reads below are for.
 *
 * Every `oxyUserId`/`oxyAccountId` here belongs to Oxy and carries no foreign
 * key: an override naming a deleted Oxy account is possible, and harmless — it
 * adjusts a role nobody holds.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { StorePermission } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { storePermissionOverrides, stores } from '../schema/stores.js';

/** One row of `stores`. */
export type StoreRow = InferSelectModel<typeof stores>;

/** One row of `store_permission_overrides`. */
export type StorePermissionOverrideRow = InferSelectModel<typeof storePermissionOverrides>;

/** The columns a caller may set when creating a store. */
export interface NewStore {
  oxyAccountId: string;
  handle: string;
  name: string;
  description: string;
  brandColor: string;
  defaultCurrency: string;
  logoFileId?: string;
  coverFileId?: string;
}

/** One store, or `null`. */
export async function findStoreById(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRow | null> {
  const [row] = await db.select().from(stores).where(eq(stores.id, storeId)).limit(1);
  return row ?? null;
}

/** One store by its public handle, or `null`. */
export async function findStoreByHandle(
  handle: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRow | null> {
  const [row] = await db.select().from(stores).where(eq(stores.handle, handle)).limit(1);
  return row ?? null;
}

/** Several stores by id — the batch read hydration uses to build a `StoreSummary`. */
export async function findStoresByIds(
  storeIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRow[]> {
  if (storeIds.length === 0) return [];
  return db.select().from(stores).where(inArray(stores.id, [...storeIds]));
}

/**
 * The feed's "Worth the hype" shelf: the best-rated ACTIVE stores.
 *
 * `product_count` breaks ties on `rating` so a brand-new store with one
 * five-star review does not outrank an established one.
 */
export async function findTopActiveStores(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRow[]> {
  return db
    .select()
    .from(stores)
    .where(eq(stores.status, 'active'))
    .orderBy(desc(stores.rating), desc(stores.productCount))
    .limit(limit);
}

/** Every store owned by one of `oxyAccountIds`, newest first. */
export async function findStoresByOwnerAccounts(
  oxyAccountIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRow[]> {
  if (oxyAccountIds.length === 0) return [];
  return db
    .select()
    .from(stores)
    .where(inArray(stores.oxyAccountId, [...oxyAccountIds]))
    // `id` breaks a same-millisecond tie: uuid v7 is time-ordered, so the
    // order is stable between requests rather than the planner's choice.
    .orderBy(desc(stores.createdAt), desc(stores.id));
}

/** Whether any store already holds `handle`. Drives handle derivation on create. */
export async function storeHandleExists(
  handle: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: stores.id })
    .from(stores)
    .where(eq(stores.handle, handle))
    .limit(1);
  return rows.length > 0;
}

/** Create a store. */
export async function insertStore(
  values: NewStore,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRow> {
  const [row] = await db.insert(stores).values(values).returning();
  return row;
}

/** Patch a store's own columns. Returns the updated store, or `null` if it is gone. */
export async function updateStoreColumns(
  storeId: string,
  patch: Partial<StoreRow>,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRow | null> {
  const [row] = await db
    .update(stores)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(stores.id, storeId))
    .returning();
  return row ?? null;
}

/** One person's override on one store, or `null` — the read `loadStore` makes. */
export async function findStorePermissionOverride(
  storeId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StorePermissionOverrideRow | null> {
  const [row] = await db
    .select()
    .from(storePermissionOverrides)
    .where(
      and(
        eq(storePermissionOverrides.storeId, storeId),
        eq(storePermissionOverrides.oxyUserId, oxyUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** One person's overrides across several stores, keyed by store id. */
export async function findStorePermissionOverridesForUser(
  storeIds: readonly string[],
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, StorePermissionOverrideRow>> {
  if (storeIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(storePermissionOverrides)
    .where(
      and(
        inArray(storePermissionOverrides.storeId, [...storeIds]),
        eq(storePermissionOverrides.oxyUserId, oxyUserId),
      ),
    );
  return new Map(rows.map((row) => [row.storeId, row]));
}

/** Every override on a store, oldest first. */
export async function listStorePermissionOverrides(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StorePermissionOverrideRow[]> {
  return db
    .select()
    .from(storePermissionOverrides)
    .where(eq(storePermissionOverrides.storeId, storeId))
    .orderBy(storePermissionOverrides.createdAt, storePermissionOverrides.oxyUserId);
}

/**
 * Write one person's override, replacing whatever it said. The
 * `(store_id, oxy_user_id)` unique key makes two concurrent writes converge on
 * one row — the later one wins whole, never a merge of the two.
 */
export async function upsertStorePermissionOverride(
  input: {
    storeId: string;
    oxyUserId: string;
    granted: readonly StorePermission[];
    revoked: readonly StorePermission[];
    updatedByOxyUserId: string | null;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<StorePermissionOverrideRow> {
  const values = {
    granted: [...input.granted],
    revoked: [...input.revoked],
    updatedByOxyUserId: input.updatedByOxyUserId,
  };
  const [row] = await db
    .insert(storePermissionOverrides)
    .values({ storeId: input.storeId, oxyUserId: input.oxyUserId, ...values })
    .onConflictDoUpdate({
      target: [storePermissionOverrides.storeId, storePermissionOverrides.oxyUserId],
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  return row;
}

/** Remove one person's override. Returns whether there was one. */
export async function deleteStorePermissionOverride(
  storeId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(storePermissionOverrides)
    .where(
      and(
        eq(storePermissionOverrides.storeId, storeId),
        eq(storePermissionOverrides.oxyUserId, oxyUserId),
      ),
    )
    .returning({ id: storePermissionOverrides.id });
  return rows.length > 0;
}

/**
 * Move a store's `product_count` by `delta`, clamped at zero.
 *
 * The clamp is in SQL rather than a read-modify-write because two concurrent
 * product deletions would otherwise both read the same count and write the same
 * decrement, losing one. `greatest(...)` is what keeps the counter from going
 * negative when the two halves of a create/delete pair are ever counted unevenly.
 */
export async function adjustStoreProductCount(
  storeId: string,
  delta: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(stores)
    .set({
      productCount: sql`greatest(0, ${stores.productCount} + ${delta})`,
      updatedAt: new Date(),
    })
    .where(eq(stores.id, storeId));
}

/**
 * Move a store's `sales_count` by `delta`, clamped at zero.
 *
 * Bumped once per paid order from the post-CAS side-effects of
 * `order.service.transition`, which is the only thing that keeps it in lockstep
 * with real sales — it is never recomputed or copied from anywhere. Same SQL
 * clamp and same reasoning as {@link adjustStoreProductCount}.
 */
export async function adjustStoreSalesCount(
  storeId: string,
  delta: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(stores)
    .set({
      salesCount: sql`greatest(0, ${stores.salesCount} + ${delta})`,
      updatedAt: new Date(),
    })
    .where(eq(stores.id, storeId));
}

/** Persist a store's recomputed review aggregate — `review.service`'s write. */
export async function setStoreRating(
  storeId: string,
  rating: number,
  reviewCount: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(stores)
    .set({ rating, reviewCount, updatedAt: new Date() })
    .where(eq(stores.id, storeId));
}
