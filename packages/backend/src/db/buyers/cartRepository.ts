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
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { cartItems, carts } from '../schema/buyers.js';

/** One row of `carts`. */
export type CartRow = InferSelectModel<typeof carts>;

/** One row of `cart_items`. */
export type CartItemRow = InferSelectModel<typeof cartItems>;

/** A cart with its lines attached, in the order they were added. */
export interface CartRecord extends CartRow {
  readonly items: CartItemRow[];
}

/** Attach a cart's lines, oldest first — the order the embedded array had. */
async function withItems(
  row: CartRow,
  db: DatabaseOrTransaction,
): Promise<CartRecord> {
  const items = await db
    .select()
    .from(cartItems)
    .where(eq(cartItems.cartId, row.id))
    // `added_at` reproduces the embedded array's insertion order; `id` breaks a
    // same-millisecond tie so the cart does not reorder itself between requests.
    .orderBy(asc(cartItems.addedAt), asc(cartItems.id));
  return { ...row, items };
}

/** The buyer's cart with its lines, or `null` when they have none yet. */
export async function findCartByUser(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CartRecord | null> {
  const [row] = await db
    .select()
    .from(carts)
    .where(eq(carts.oxyUserId, oxyUserId))
    .limit(1);
  return row ? withItems(row, db) : null;
}

/**
 * The buyer's cart, created if they have none.
 *
 * `ON CONFLICT DO NOTHING` plus a re-read rather than a find-then-insert: two
 * concurrent first-adds would both miss and the second would fail
 * `carts_oxy_user_id_key`, turning an ordinary double-tap into a 500.
 */
export async function ensureCart(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CartRow> {
  const [inserted] = await db
    .insert(carts)
    .values({ oxyUserId })
    .onConflictDoNothing({ target: carts.oxyUserId })
    .returning();
  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(carts)
    .where(eq(carts.oxyUserId, oxyUserId))
    .limit(1);
  return existing;
}

/**
 * Add `quantity` of a variant, or SET an existing line to `quantity`.
 *
 * The absolute set is deliberate and matches the service it replaces: the caller
 * has already clamped the desired total against live availability and the
 * per-item maximum, so an `existing + n` here would apply the clamp to the wrong
 * number and could exceed the stock the clamp exists to respect.
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
      set: { quantity: line.quantity, updatedAt: new Date() },
    });
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
 * Empty a buyer's cart: every line goes, and so do the pinned discount codes —
 * they were one-shot inputs to the checkout that just consumed them. The cart row
 * itself is retained.
 *
 * A no-op when the buyer has no cart, which is why it takes the user id rather
 * than a cart id: the checkout calls it without having loaded one.
 */
export async function clearCartForUser(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const run = async (tx: DatabaseOrTransaction): Promise<void> => {
    const [row] = await tx
      .select({ id: carts.id })
      .from(carts)
      .where(eq(carts.oxyUserId, oxyUserId))
      .limit(1);
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
