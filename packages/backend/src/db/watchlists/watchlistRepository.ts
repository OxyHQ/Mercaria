/**
 * `watchlists` — the only writer of a watchlist header (#81).
 *
 * ## Every mutation is a compare-and-swap on `version`
 *
 * #81 model rule 11 and acceptance 4. `bumpWatchlistVersion` is the ONE place
 * the version moves, and it moves it as part of the same statement that reads
 * it: `UPDATE … WHERE id = $1 AND oxy_user_id = $2 AND version = $3 RETURNING`.
 * An empty `RETURNING` set IS the refusal — there is no read-then-write anywhere
 * in this file, because a read-then-write is exactly what a concurrent client
 * defeats, and the whole point of the token is to catch that client.
 *
 * The `oxy_user_id` predicate is in the SAME statement as the id, deliberately:
 * "is this my list" and "is my copy current" are one question at the database,
 * so there is no window in which a list is found and then checked. A caller that
 * asks about somebody else's list gets the same empty set as one holding a stale
 * version, and the service turns the two into different answers only after
 * establishing ownership through {@link findWatchlistForOwner}.
 */

import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { CurrencyCode, WatchlistTemplateKey } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { watchlists } from '../schema/watchlists.js';

/** One row of `watchlists`. */
export type WatchlistRow = InferSelectModel<typeof watchlists>;

/** Everything a caller may supply when creating a list. */
export interface NewWatchlist {
  readonly oxyUserId: string;
  readonly name: string;
  readonly displayCurrency: CurrencyCode;
  readonly description?: string | null;
  readonly icon?: string | null;
  readonly market?: string | null;
  readonly templateKey?: WatchlistTemplateKey | null;
}

/** The fields a rename may change. Absent means "leave it alone". */
export interface WatchlistHeaderPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly icon?: string | null;
  readonly displayCurrency?: CurrencyCode;
  readonly market?: string | null;
}

/** Create one list. The caller has already checked the per-owner limit. */
export async function insertWatchlist(
  input: NewWatchlist,
  db: DatabaseOrTransaction = getDb(),
): Promise<WatchlistRow> {
  const [row] = await db
    .insert(watchlists)
    .values({
      oxyUserId: input.oxyUserId,
      name: input.name,
      displayCurrency: input.displayCurrency,
      description: input.description ?? null,
      icon: input.icon ?? null,
      market: input.market ?? null,
      templateKey: input.templateKey ?? null,
    })
    .returning();
  if (!row) throw new Error('Failed to create the watchlist.');
  return row;
}

/** One list, if it belongs to this owner. Ownership is part of the predicate. */
export async function findWatchlistForOwner(
  oxyUserId: string,
  watchlistId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<WatchlistRow | undefined> {
  const [row] = await db
    .select()
    .from(watchlists)
    .where(and(eq(watchlists.id, watchlistId), eq(watchlists.oxyUserId, oxyUserId)))
    .limit(1);
  return row;
}

/**
 * One list, locked for the duration of the transaction.
 *
 * The snapshot write takes this so two concurrent evaluations of one list
 * cannot both decide they differ from the same predecessor and both insert.
 * Serializing on the list row is the cheapest correct answer: snapshots are one
 * per list and a lock somebody else holds is a lock on their own list.
 */
export async function lockWatchlistForOwner(
  oxyUserId: string,
  watchlistId: string,
  db: DatabaseOrTransaction,
): Promise<WatchlistRow | undefined> {
  const [row] = await db
    .select()
    .from(watchlists)
    .where(and(eq(watchlists.id, watchlistId), eq(watchlists.oxyUserId, oxyUserId)))
    .limit(1)
    .for('update');
  return row;
}

/** This owner's lists, newest first. */
export async function listWatchlistsForOwner(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<WatchlistRow[]> {
  return db
    .select()
    .from(watchlists)
    .where(eq(watchlists.oxyUserId, oxyUserId))
    .orderBy(desc(watchlists.createdAt), desc(watchlists.id));
}

/** How many lists this owner already has — the per-owner limit's input. */
export async function countWatchlistsForOwner(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(watchlists)
    .where(eq(watchlists.oxyUserId, oxyUserId));
  return Number(row?.total ?? 0);
}

/**
 * Advance the version, optionally applying a header patch, IF the caller's copy
 * is current.
 *
 * The single statement is the whole mechanism (#81 acceptance 4). Every item
 * mutation calls this too — with no patch — so a reorder computed against one
 * membership can never be applied to another: the list is the concurrency unit
 * because the list is what a client holds.
 *
 * Returns the new row, or `undefined` when the version did not match. The caller
 * distinguishes "not yours" from "stale" by having already read the list.
 */
export async function bumpWatchlistVersion(
  oxyUserId: string,
  watchlistId: string,
  expectedVersion: number,
  patch: WatchlistHeaderPatch = {},
  db: DatabaseOrTransaction = getDb(),
): Promise<WatchlistRow | undefined> {
  const [row] = await db
    .update(watchlists)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.icon === undefined ? {} : { icon: patch.icon }),
      ...(patch.displayCurrency === undefined ? {} : { displayCurrency: patch.displayCurrency }),
      ...(patch.market === undefined ? {} : { market: patch.market }),
      version: sql`${watchlists.version} + 1`,
    })
    .where(
      and(
        eq(watchlists.id, watchlistId),
        eq(watchlists.oxyUserId, oxyUserId),
        eq(watchlists.version, expectedVersion),
      ),
    )
    .returning();
  return row;
}

/**
 * Record that an evaluation was persisted.
 *
 * Deliberately NOT a version bump: recording a snapshot does not change what the
 * list IS, so it must not invalidate a client's copy — otherwise opening the
 * basket would make every editor's next write conflict.
 */
export async function stampWatchlistEvaluated(
  watchlistId: string,
  evaluatedAt: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(watchlists)
    .set({ lastEvaluatedAt: evaluatedAt })
    .where(eq(watchlists.id, watchlistId));
}

/** Remove one list. Items and snapshots CASCADE; nothing else references it. */
export async function deleteWatchlist(
  oxyUserId: string,
  watchlistId: string,
  expectedVersion: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const removed = await db
    .delete(watchlists)
    .where(
      and(
        eq(watchlists.id, watchlistId),
        eq(watchlists.oxyUserId, oxyUserId),
        eq(watchlists.version, expectedVersion),
      ),
    )
    .returning({ id: watchlists.id });
  return removed.length > 0;
}
