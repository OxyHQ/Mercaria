/**
 * `stores` and `store_members`.
 *
 * One Mongoose model became two tables, so this module is the seam that keeps
 * them looking like one thing to callers: a {@link StoreRecord} is the store row
 * with its members attached, which is the shape `store.service`, `store-authz`
 * and `toStoreDTO` all already wanted. Nothing above this layer joins the two.
 *
 * ## Why members became a table at all
 *
 * `{'members.oxyUserId': 1}` was read on EVERY admin request to answer "may this
 * Oxy user act for this store". That is a query BY ELEMENT, which is the
 * documented trigger for a child table rather than an embedded array — and it
 * buys an invariant Mongo could not state: `UNIQUE(store_id, oxy_user_id)`, so
 * the same user can no longer appear twice on one store.
 *
 * ## `oxy_user_id` is a foreign service's key
 *
 * Every `oxyUserId` here belongs to Oxy and carries no foreign key. A membership
 * naming a deleted Oxy account is therefore possible and always was; the store
 * side cannot validate it without an HTTP round trip in front of every insert.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { StorePermission, StoreRole } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { stores, storeMembers } from '../schema/stores.js';

/** One row of `store_members`. */
export type StoreMemberRecord = InferSelectModel<typeof storeMembers>;

/**
 * One row of `stores`, with NO members attached — a store's public face.
 *
 * This is what the storefront reads return. Keeping it a distinct type from
 * {@link StoreRecord} is what stops a public response from carrying the list of
 * Oxy accounts that can act for the shop: a serializer written against this type
 * cannot reach `.members`, because it is not there to reach.
 */
export type StoreRow = InferSelectModel<typeof stores>;

/** A store row WITH its members — the admin shape. */
export interface StoreRecord extends StoreRow {
  readonly members: StoreMemberRecord[];
}

/** The columns a caller may set when creating a store. */
export interface NewStore {
  handle: string;
  name: string;
  description: string;
  brandColor: string;
  defaultCurrency: string;
  logoFileId?: string;
  coverFileId?: string;
}

/** The columns a caller may set when adding a member. */
export interface NewStoreMember {
  oxyUserId: string;
  role: StoreRole;
  permissions: StorePermission[];
  invitedBy?: string;
}

/**
 * Attach each store's members, in ONE query for the whole batch.
 *
 * Written as a batched second query rather than a join because a join
 * multiplies the store row by its member count and every scalar column has to
 * be de-duplicated back out — which is where a rollup silently doubles.
 *
 * Ordering is `joined_at` then `oxy_user_id`: the embedded array had insertion
 * order, and `joined_at` reproduces it for every row except two members added in
 * the same millisecond, where the id breaks the tie deterministically rather
 * than letting the page order wobble between requests.
 */
async function withMembers(
  rows: StoreRow[],
  db: DatabaseOrTransaction,
): Promise<StoreRecord[]> {
  if (rows.length === 0) return [];

  const memberRows = await db
    .select()
    .from(storeMembers)
    .where(inArray(storeMembers.storeId, rows.map((row) => row.id)))
    .orderBy(storeMembers.joinedAt, storeMembers.oxyUserId);

  const byStore = new Map<string, StoreMemberRecord[]>();
  for (const member of memberRows) {
    const bucket = byStore.get(member.storeId);
    if (bucket) bucket.push(member);
    else byStore.set(member.storeId, [member]);
  }

  return rows.map((row) => ({ ...row, members: byStore.get(row.id) ?? [] }));
}

/** One store with its members, or `null`. */
export async function findStoreById(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRecord | null> {
  const rows = await db.select().from(stores).where(eq(stores.id, storeId)).limit(1);
  const [record] = await withMembers(rows, db);
  return record ?? null;
}

/** One store by its public handle, with its members, or `null`. */
export async function findStoreByHandle(
  handle: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRecord | null> {
  const rows = await db.select().from(stores).where(eq(stores.handle, handle)).limit(1);
  const [record] = await withMembers(rows, db);
  return record ?? null;
}

/**
 * Several stores by id, WITHOUT members.
 *
 * The batch read hydration uses to build a `MerchantSummary`, which needs the
 * store's public face and never its membership. Keeping members off this path
 * is not an optimization detail: it is what stops a storefront response from
 * carrying the list of Oxy accounts that can act for the shop.
 */
export async function findStoresByIds(
  storeIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRow[]> {
  if (storeIds.length === 0) return [];
  return db.select().from(stores).where(inArray(stores.id, [...storeIds]));
}

/**
 * ONE store's public face, WITHOUT members — the read every commerce path makes
 * to resolve a settlement currency or a tax setting.
 *
 * Distinct from {@link findStoreById} on purpose, and not merely lighter: those
 * paths run per checkout, per cart hydration and per pricing call, and none of
 * them has any business seeing which Oxy accounts can act for the shop. Keeping
 * the member join off them is the same reasoning as {@link findStoresByIds},
 * applied to the single-row case.
 */
export async function findStoreRow(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRow | null> {
  const [row] = await db.select().from(stores).where(eq(stores.id, storeId)).limit(1);
  return row ?? null;
}

/**
 * The feed's "Worth the hype" shelf: the best-rated ACTIVE stores, WITHOUT
 * members — the same reasoning as {@link findStoresByIds}, since this is a
 * public storefront read.
 *
 * `product_count` breaks ties on `rating` so a brand-new store with one
 * five-star review does not outrank an established one, which is the ordering
 * the Mongo sort already had.
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

/** Every store the given Oxy user is a member of, newest first. */
export async function findStoresForMember(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRecord[]> {
  const rows = await db
    .select({ store: stores })
    .from(stores)
    .innerJoin(storeMembers, eq(storeMembers.storeId, stores.id))
    .where(eq(storeMembers.oxyUserId, oxyUserId))
    .orderBy(desc(stores.createdAt));

  return withMembers(
    rows.map((row) => row.store),
    db,
  );
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

/**
 * Create a store and its founding members in ONE transaction.
 *
 * Atomic because the alternative is a store with no owner: `loadStore` refuses
 * every request that names one, so a crash between the two inserts leaves a row
 * nobody — including its creator — can ever reach or delete.
 */
export async function insertStore(
  values: NewStore,
  members: readonly NewStoreMember[],
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRecord> {
  const run = async (tx: DatabaseOrTransaction): Promise<StoreRecord> => {
    const [row] = await tx.insert(stores).values(values).returning();

    const memberRows =
      members.length > 0
        ? await tx
            .insert(storeMembers)
            .values(
              members.map((member) => ({
                storeId: row.id,
                oxyUserId: member.oxyUserId,
                role: member.role,
                permissions: [...member.permissions],
                ...(member.invitedBy ? { invitedBy: member.invitedBy } : {}),
                joinedAt: new Date(),
              })),
            )
            .returning()
        : [];

    return { ...row, members: memberRows };
  };

  // A caller already inside a transaction joins it; drizzle has no nested
  // `transaction` on a `Transaction` handle that would let us open a second one.
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/** Patch a store's own columns. Returns the updated store, or `null` if it is gone. */
export async function updateStoreColumns(
  storeId: string,
  patch: Partial<StoreRow>,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRecord | null> {
  const rows = await db
    .update(stores)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(stores.id, storeId))
    .returning();
  const [record] = await withMembers(rows, db);
  return record ?? null;
}

/** One membership, or `null` — the read `loadStore` makes on every admin request. */
export async function findStoreMember(
  storeId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreMemberRecord | null> {
  const [row] = await db
    .select()
    .from(storeMembers)
    .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.oxyUserId, oxyUserId)))
    .limit(1);
  return row ?? null;
}

/** Add a member. The `UNIQUE(store_id, oxy_user_id)` index refuses a duplicate. */
export async function insertStoreMember(
  storeId: string,
  member: NewStoreMember,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreMemberRecord> {
  const [row] = await db
    .insert(storeMembers)
    .values({
      storeId,
      oxyUserId: member.oxyUserId,
      role: member.role,
      permissions: [...member.permissions],
      ...(member.invitedBy ? { invitedBy: member.invitedBy } : {}),
      joinedAt: new Date(),
    })
    .returning();
  return row;
}

/** Patch a member's role and/or permissions. */
export async function updateStoreMember(
  storeId: string,
  oxyUserId: string,
  patch: { role?: StoreRole; permissions?: StorePermission[] },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(storeMembers)
    .set({
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.permissions !== undefined ? { permissions: [...patch.permissions] } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.oxyUserId, oxyUserId)));
}

/** Remove a member. */
export async function deleteStoreMember(
  storeId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .delete(storeMembers)
    .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.oxyUserId, oxyUserId)));
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
