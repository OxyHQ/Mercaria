/**
 * `carts` and `cart_items`.
 *
 * The cart stores ONLY variant references and quantities — never a price. Prices
 * and availability are read live from the catalogue every time the cart is
 * hydrated, so the cart can never serve a stale price, and there is nothing here
 * to keep in sync with a catalogue edit.
 *
 * ## `addItem` is an UPSERT, and the constraint is what makes it one
 *
 * `cart_items_cart_id_variant_id_key` states "one line per variant per cart",
 * which the Mongo path only ever approximated by searching the embedded array
 * first and then pushing. Two concurrent adds of the same variant could both miss
 * and both push, leaving a cart with two lines for one variant that the checkout
 * then reserved twice. `ON CONFLICT … DO UPDATE` collapses find-then-write into
 * one statement, so the second add bumps the quantity instead.
 *
 * ## A cart is owned by a {@link CartOwner}, never by "a user" (#104)
 *
 * Every read and write below takes the owner VALUE, not a raw Oxy id, and the
 * predicate is derived by switching on its `kind`. That is what makes ADR 0003
 * I1 — "a guest id is never accepted where an Oxy user id is expected" —
 * enforced by the compiler at every call site rather than by convention: the
 * union has no common `id` field to alias through, exactly like `CommerceActor`
 * above it.
 *
 * There is deliberately NO legacy `findCartByUser` left beside
 * {@link findCartByOwner}. The ADR's "compatibility read" (M2) is a property of
 * the DATA, not a second function: `oxy_user_id` keeps its name, its meaning
 * and its unique index, so `findCartByOwner({kind: 'oxy_user'})` issues exactly
 * the query the old function did and every legacy cart resolves through the
 * same index. A duplicated legacy entry point would be a compatibility shim
 * with nothing to be compatible with.
 */

import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { CartLineReviewReason } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { cartItems, carts } from '../schema/buyers.js';

/**
 * Who owns a cart — the storage-facing half of `CommerceActor` (ADR 0003 D8).
 *
 * Two members, mapping one-to-one onto the two owner columns, with NO common
 * `id` field. An `anonymous` actor has no member here at all, which is the
 * type-level statement of "browsing creates no row": there is no owner value to
 * pass, so no code path can accidentally persist one.
 */
export type CartOwner =
  | { readonly kind: 'oxy_user'; readonly oxyUserId: string }
  | { readonly kind: 'guest_session'; readonly guestSessionId: string };

/** One row of `carts`. */
export type CartRow = InferSelectModel<typeof carts>;

/** One row of `cart_items`. */
export type CartItemRow = InferSelectModel<typeof cartItems>;

/** A cart with its lines attached, in the order they were added. */
export interface CartRecord extends CartRow {
  readonly items: CartItemRow[];
}

/** The `WHERE` that selects exactly this owner's cart. */
function ownerPredicate(owner: CartOwner) {
  switch (owner.kind) {
    case 'oxy_user':
      return eq(carts.oxyUserId, owner.oxyUserId);
    case 'guest_session':
      return eq(carts.guestSessionId, owner.guestSessionId);
  }
}

/** The INSERT values that give a new cart exactly one owner. */
function ownerValues(owner: CartOwner): { oxyUserId: string } | { guestSessionId: string } {
  switch (owner.kind) {
    case 'oxy_user':
      return { oxyUserId: owner.oxyUserId };
    case 'guest_session':
      return { guestSessionId: owner.guestSessionId };
  }
}

/**
 * The partial unique index a first-insert conflicts on, as the `target` +
 * `where` pair `ON CONFLICT` needs to INFER it.
 *
 * Both uniques are PARTIAL since #104, and Postgres will not pick a partial
 * index as the arbiter unless the statement repeats its predicate: an
 * `ON CONFLICT (oxy_user_id)` with no `WHERE` matches nothing and the server
 * answers `there is no unique or exclusion constraint matching the ON CONFLICT
 * specification` — turning an ordinary double-tap into exactly the 500 this
 * upsert exists to prevent. Every real-database checkout test failed on this
 * before the predicate was added, which is the argument for having them.
 */
function ownerConflictTarget(owner: CartOwner) {
  switch (owner.kind) {
    case 'oxy_user':
      return { target: carts.oxyUserId, where: isNotNull(carts.oxyUserId) };
    case 'guest_session':
      return { target: carts.guestSessionId, where: isNotNull(carts.guestSessionId) };
  }
}

/** Attach a cart's lines, oldest first — the order the embedded array had. */
async function withItems(row: CartRow, db: DatabaseOrTransaction): Promise<CartRecord> {
  const items = await db
    .select()
    .from(cartItems)
    .where(eq(cartItems.cartId, row.id))
    // `added_at` reproduces the embedded array's insertion order; `id` breaks a
    // same-millisecond tie so the cart does not reorder itself between requests.
    .orderBy(asc(cartItems.addedAt), asc(cartItems.id));
  return { ...row, items };
}

/** The owner's cart with its lines, or `null` when they have none yet. */
export async function findCartByOwner(
  owner: CartOwner,
  db: DatabaseOrTransaction = getDb(),
): Promise<CartRecord | null> {
  const [row] = await db.select().from(carts).where(ownerPredicate(owner)).limit(1);
  return row ? withItems(row, db) : null;
}

/**
 * The owner's cart with its lines, with the cart ROW locked `FOR UPDATE`.
 *
 * The merge's serialization primitive (#104 merge requirement 1). Two merges
 * targeting one authenticated cart queue behind each other here rather than
 * interleaving their reads and writes. Only usable inside a transaction —
 * outside one the lock is released at statement end and buys nothing, which is
 * why the parameter is a transaction handle by name.
 */
export async function findCartByOwnerForUpdate(
  owner: CartOwner,
  tx: DatabaseOrTransaction,
): Promise<CartRecord | null> {
  const [row] = await tx.select().from(carts).where(ownerPredicate(owner)).limit(1).for('update');
  return row ? withItems(row, tx) : null;
}

/**
 * The owner's cart, created if they have none.
 *
 * `ON CONFLICT DO NOTHING` plus a re-read rather than a find-then-insert: two
 * concurrent first-adds would both miss and the second would fail the owner's
 * unique index, turning an ordinary double-tap into a 500.
 */
export async function ensureCart(
  owner: CartOwner,
  db: DatabaseOrTransaction = getDb(),
): Promise<CartRow> {
  const [inserted] = await db
    .insert(carts)
    .values(ownerValues(owner))
    .onConflictDoNothing(ownerConflictTarget(owner))
    .returning();
  if (inserted) return inserted;

  const [existing] = await db.select().from(carts).where(ownerPredicate(owner)).limit(1);
  if (!existing) {
    // Unreachable: the insert either created the row or lost to a concurrent
    // insert of the SAME owner, which the re-read then finds. The guard exists
    // so the return type needs no non-null assertion.
    throw new Error('ensureCart found no cart after an ON CONFLICT DO NOTHING insert');
  }
  return existing;
}

/**
 * Add `quantity` of a variant, or SET an existing line to `quantity`.
 *
 * The absolute set is deliberate and matches the service it replaces: the caller
 * has already clamped the desired total against live availability and the
 * per-item maximum, so an `existing + n` here would apply the clamp to the wrong
 * number and could exceed the stock the clamp exists to respect.
 *
 * The line's merge review flag is CLEARED on every such write: setting a
 * line's quantity explicitly is the buyer acting on it, which is the
 * acknowledgement the flag was waiting for (#104 — no separate dismiss endpoint
 * exists to keep honest).
 */
export async function upsertCartItem(
  cartId: string,
  line: { listingId: string; variantId: string; quantity: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .insert(cartItems)
    .values({
      cartId,
      listingId: line.listingId,
      variantId: line.variantId,
      quantity: line.quantity,
      addedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [cartItems.cartId, cartItems.variantId],
      set: {
        quantity: line.quantity,
        listingId: line.listingId,
        mergeReviewReason: null,
        updatedAt: new Date(),
      },
    });
}

/** What {@link mergeCartItem} needs to fold ONE guest line into a target cart. */
export interface MergeCartLineInput {
  /** The variant's CURRENT owning listing — revalidated by the caller. */
  listingId: string;
  variantId: string;
  /** The guest line's quantity, already clamped by the caller to `quantityCeiling`. */
  quantity: number;
  /**
   * The ceiling the SUM may not exceed: `min(maxQuantityPerItem, live
   * available)`, floored at 1. Applied in SQL so a concurrent add from another
   * authenticated device is summed with rather than overwritten.
   *
   * The floor is deliberate. An out-of-stock variant yields a ceiling of 0, and
   * a zero-quantity line is unrepresentable (`cart_items_quantity_check`), so a
   * 0 ceiling would force the merge to DROP the line — the one thing #104
   * forbids ("no item disappears silently"). One unit, flagged
   * `listing_unavailable`, is the visible review state instead: hydration marks
   * it `stale` against the live stock and checkout refuses stale lines, so
   * nothing can be oversold by keeping it.
   */
  quantityCeiling: number;
  /**
   * The flag to write when the SUM exceeds the ceiling. Already resolved by the
   * caller against the line's own condition, so a line that is BOTH unavailable
   * and clamped keeps the more informative reason.
   */
  conflictReason: CartLineReviewReason;
  /** The flag for the no-conflict (plain insert) branch, or `null`. */
  insertReason: CartLineReviewReason | null;
  /** The guest line's `added_at`; the earliest of the two is preserved. */
  addedAt: Date;
}

/** What one merged line actually became, read back from the write itself. */
export interface MergeCartLineOutcome {
  /** `true` when the target cart already held this variant. */
  combined: boolean;
  /** The quantity the row now holds. */
  quantity: number;
  /** The review flag the row now carries — the DATABASE's verdict, not a guess. */
  reviewReason: CartLineReviewReason | null;
}

/**
 * Fold one guest line into a target cart, summing and clamping IN SQL.
 *
 * Three properties, none of which survives being computed in TypeScript first:
 *
 *  - **Concurrency (merge conflict case 7).** `LEAST(existing + incoming,
 *    ceiling)` reads `existing` at WRITE time, so a line another authenticated
 *    device added between the merge's read and its write is summed with rather
 *    than overwritten. A quantity computed in advance would silently discard it.
 *  - **`added_at` is `LEAST` of the two** — the earliest, deterministically, so
 *    the merged cart's order is stable however the two carts interleave.
 *  - **The review flag is decided by the SAME expression that applies the
 *    clamp**, so a line cannot be clamped without being flagged. The caller
 *    then counts clamps off the RETURNED flag rather than re-deriving what it
 *    believes the database did — the only version that survives the race above.
 *
 * `xmax <> 0` in `RETURNING` is how an upsert reports which branch it took: on
 * an INSERT the new tuple has no updating transaction, on a `DO UPDATE` it
 * carries the one that superseded the old version.
 */
export async function mergeCartItem(
  cartId: string,
  line: MergeCartLineInput,
  tx: DatabaseOrTransaction,
): Promise<MergeCartLineOutcome> {
  const [row] = await tx
    .insert(cartItems)
    .values({
      cartId,
      listingId: line.listingId,
      variantId: line.variantId,
      quantity: line.quantity,
      addedAt: line.addedAt,
      mergeReviewReason: line.insertReason,
    })
    .onConflictDoUpdate({
      target: [cartItems.cartId, cartItems.variantId],
      set: {
        quantity: sql`least(${cartItems.quantity} + excluded.quantity, ${line.quantityCeiling})`,
        listingId: sql`excluded.listing_id`,
        addedAt: sql`least(${cartItems.addedAt}, excluded.added_at)`,
        mergeReviewReason: sql`case
          when ${cartItems.quantity} + excluded.quantity > ${line.quantityCeiling}
            then ${line.conflictReason}
          else excluded.merge_review_reason
        end`,
        updatedAt: new Date(),
      },
    })
    .returning({
      quantity: cartItems.quantity,
      reviewReason: cartItems.mergeReviewReason,
      combined: sql<boolean>`(xmax <> 0)`,
    });

  if (!row) {
    // Both branches of an upsert return their row; an empty result would mean
    // the statement matched nothing, which this shape cannot produce.
    throw new Error('mergeCartItem returned no row');
  }
  return { combined: row.combined, quantity: row.quantity, reviewReason: row.reviewReason };
}

/** Remove one variant's line. `false` when the cart held no such line. */
export async function deleteCartItem(
  cartId: string,
  variantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(cartItems)
    .where(and(eq(cartItems.cartId, cartId), eq(cartItems.variantId, variantId)))
    .returning({ id: cartItems.id });
  return rows.length > 0;
}

/**
 * Remove a specific set of lines, leaving every other line and the pinned
 * discount codes intact — the per-seller checkout's cart cleanup.
 */
export async function deleteCartItems(
  cartId: string,
  variantIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (variantIds.length === 0) return;
  await db
    .delete(cartItems)
    .where(and(eq(cartItems.cartId, cartId), inArray(cartItems.variantId, [...variantIds])));
}

/**
 * Empty an owner's cart: every line goes, and so do the pinned discount codes —
 * they were one-shot inputs to the checkout that just consumed them. The cart row
 * itself is retained.
 *
 * A no-op when the owner has no cart, which is why it takes the owner rather
 * than a cart id: the checkout calls it without having loaded one.
 */
export async function clearCartForOwner(
  owner: CartOwner,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const run = async (tx: DatabaseOrTransaction): Promise<void> => {
    const [row] = await tx.select({ id: carts.id }).from(carts).where(ownerPredicate(owner)).limit(1);
    if (!row) return;
    await tx.delete(cartItems).where(eq(cartItems.cartId, row.id));
    await tx
      .update(carts)
      .set({ pendingDiscountCodes: sql`'{}'::text[]`, updatedAt: new Date() })
      .where(eq(carts.id, row.id));
  };
  if ('transaction' in db) await db.transaction(run);
  else await run(db);
}

/** Replace the cart's pinned discount codes (already normalized and deduped). */
export async function setPendingDiscountCodes(
  cartId: string,
  codes: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(carts)
    .set({ pendingDiscountCodes: [...codes], updatedAt: new Date() })
    .where(eq(carts.id, cartId));
}

/**
 * Delete a cart ROW outright, lines included by cascade.
 *
 * Used only by the merge, on the DRAINED guest cart. It is a delete and not a
 * clear because the owner is gone: the guest session is revoked in the same
 * transaction, so an empty cart still pointing at it would be exactly the
 * inconsistency `findConvertedSessionsWithCarts` exists to detect.
 */
export async function deleteCart(cartId: string, tx: DatabaseOrTransaction): Promise<void> {
  await tx.delete(carts).where(eq(carts.id, cartId));
}

/** Carts owned by neither column — impossible under the CHECK, counted anyway. */
export async function countOwnerlessCarts(db: DatabaseOrTransaction = getDb()): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(carts)
    .where(and(isNull(carts.oxyUserId), isNull(carts.guestSessionId)));
  return row?.count ?? 0;
}
