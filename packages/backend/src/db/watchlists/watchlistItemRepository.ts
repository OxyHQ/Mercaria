/**
 * `watchlist_items` — the only writer of a watchlist entry (#81).
 *
 * ## The note is read only where a caller NAMES it
 *
 * `watchlist_items.note` is in `PROTECTED_COLUMNS`, so `publicColumns(...)`
 * withholds it at runtime AND at the type level. Every read in this file except
 * {@link listWatchlistItemsForOwner} therefore CANNOT carry a note — including
 * the read the basket evaluation makes, which is the one that writes durable
 * snapshot rows from what it read (#81 privacy rules 2 and 4). The owner's own
 * list projection asks for it explicitly, which is what the registry's opt-in is
 * for and what makes that one read visibly different from every other.
 *
 * ## Idempotence is `ON CONFLICT DO NOTHING`, and the conflict is the point
 *
 * `watchlist_items_watchlist_id_canonical_product_id_key` is what makes an add
 * converge under a double tap, and what a product MERGE rehomes against. `DO
 * NOTHING` rather than `DO UPDATE`: a second add of a product already in the
 * list must not overwrite the quantity, preferences or note the buyer set on the
 * first, and must not move `added_at`, which is a tiebreaker in the list's own
 * order.
 */

import { and, asc, count, eq, inArray, max, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import type { ConditionGroup, CurrencyCode } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { watchlistItems, watchlists } from '../schema/watchlists.js';

/** One row of `watchlist_items`, note included. Only the owner's own read sees this. */
export type WatchlistItemRow = InferSelectModel<typeof watchlistItems>;

/**
 * Everything but the note — what every read that is not the owner's own list
 * gets, and what the evaluation is handed.
 */
const PUBLIC_ITEM_COLUMNS = publicColumns(watchlistItems, PROTECTED_COLUMNS);

/** One row without its note. The evaluation's input type. */
export type WatchlistItemFactsRow = Omit<WatchlistItemRow, 'note'>;

/**
 * Every column INCLUDING the note, named explicitly.
 *
 * The owner's own reads legitimately return their own note, and the protected
 * registry's rule is that such a path NAMES what it wants — a bare
 * `.select().from(watchlistItems)` is refused by
 * `schema-conventions.test.ts`'s implicit-whole-row gate precisely so this
 * choice is visible in a diff rather than inherited by every later read that
 * copies the line above it.
 */
const OWNER_ITEM_COLUMNS = {
  id: watchlistItems.id,
  watchlistId: watchlistItems.watchlistId,
  canonicalProductId: watchlistItems.canonicalProductId,
  preferredCanonicalVariantId: watchlistItems.preferredCanonicalVariantId,
  preferredConditionGroup: watchlistItems.preferredConditionGroup,
  preferredMerchantId: watchlistItems.preferredMerchantId,
  quantity: watchlistItems.quantity,
  position: watchlistItems.position,
  targetAmount: watchlistItems.targetAmount,
  targetCurrency: watchlistItems.targetCurrency,
  note: watchlistItems.note,
  resolutionState: watchlistItems.resolutionState,
  ambiguousSplitJobId: watchlistItems.ambiguousSplitJobId,
  addedAt: watchlistItems.addedAt,
  updatedAt: watchlistItems.updatedAt,
} as const;

/** Everything a caller may supply when adding an entry. */
export interface NewWatchlistItem {
  readonly watchlistId: string;
  readonly canonicalProductId: string;
  readonly quantity: number;
  readonly position: number;
  readonly preferredCanonicalVariantId?: string | null;
  readonly preferredConditionGroup?: ConditionGroup | null;
  readonly preferredMerchantId?: string | null;
  readonly targetAmount?: number | null;
  readonly targetCurrency?: CurrencyCode | null;
  readonly note?: string | null;
}

/** The fields an item patch may change. Absent means "leave it alone". */
export interface WatchlistItemPatch {
  readonly quantity?: number;
  readonly preferredCanonicalVariantId?: string | null;
  readonly preferredConditionGroup?: ConditionGroup | null;
  readonly preferredMerchantId?: string | null;
  readonly targetAmount?: number | null;
  readonly targetCurrency?: CurrencyCode | null;
  readonly note?: string | null;
}

/**
 * Add an entry, or leave the existing one exactly as it is.
 *
 * Returns the row that survived either way plus whether this call created it,
 * which is what makes the HTTP response identical on the first tap and the
 * fifth. The `DO NOTHING` branch returns no row, so the existing one is read
 * back — in the SAME transaction, so the read cannot see a state the insert did
 * not.
 */
export async function insertWatchlistItem(
  input: NewWatchlistItem,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ item: WatchlistItemRow; created: boolean }> {
  const inserted = await db
    .insert(watchlistItems)
    .values({
      watchlistId: input.watchlistId,
      canonicalProductId: input.canonicalProductId,
      quantity: input.quantity,
      position: input.position,
      preferredCanonicalVariantId: input.preferredCanonicalVariantId ?? null,
      preferredConditionGroup: input.preferredConditionGroup ?? null,
      preferredMerchantId: input.preferredMerchantId ?? null,
      targetAmount: input.targetAmount ?? null,
      targetCurrency: input.targetCurrency ?? null,
      note: input.note ?? null,
    })
    .onConflictDoNothing({
      target: [watchlistItems.watchlistId, watchlistItems.canonicalProductId],
    })
    .returning();

  const created = inserted[0];
  if (created) return { item: created, created: true };

  const [existing] = await db
    .select(OWNER_ITEM_COLUMNS)
    .from(watchlistItems)
    .where(
      and(
        eq(watchlistItems.watchlistId, input.watchlistId),
        eq(watchlistItems.canonicalProductId, input.canonicalProductId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error('Failed to add the watchlist item.');
  return { item: existing, created: false };
}

/** The owner's own read — the ONE place a note is returned. */
export async function listWatchlistItemsForOwner(
  watchlistId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<WatchlistItemRow[]> {
  return db
    .select(OWNER_ITEM_COLUMNS)
    .from(watchlistItems)
    .where(eq(watchlistItems.watchlistId, watchlistId))
    .orderBy(asc(watchlistItems.position), asc(watchlistItems.addedAt), asc(watchlistItems.id));
}

/**
 * The evaluation's read — every item, WITHOUT its note.
 *
 * The evaluation writes `watchlist_snapshot_items` rows from what this returns,
 * so the withholding is what makes "a note never enters a durable record"
 * structural instead of remembered.
 */
export async function listWatchlistItemFacts(
  watchlistId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<WatchlistItemFactsRow[]> {
  return db
    .select(PUBLIC_ITEM_COLUMNS)
    .from(watchlistItems)
    .where(eq(watchlistItems.watchlistId, watchlistId))
    .orderBy(asc(watchlistItems.position), asc(watchlistItems.addedAt), asc(watchlistItems.id));
}

/** One entry, by id, scoped to the list it must belong to. */
export async function findWatchlistItem(
  watchlistId: string,
  itemId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<WatchlistItemRow | undefined> {
  const [row] = await db
    .select(OWNER_ITEM_COLUMNS)
    .from(watchlistItems)
    .where(and(eq(watchlistItems.id, itemId), eq(watchlistItems.watchlistId, watchlistId)))
    .limit(1);
  return row;
}

/** How many entries the list already holds — the per-list limit's input. */
export async function countWatchlistItems(
  watchlistId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(watchlistItems)
    .where(eq(watchlistItems.watchlistId, watchlistId));
  return Number(row?.total ?? 0);
}

/**
 * The next position to append at.
 *
 * `max(position) + 1`, coerced explicitly: postgres.js decodes an aggregate over
 * an integer column faithfully, but the house rule is to coerce at the boundary
 * rather than trust an inferred type — the `bigint`-through-an-aggregate finding
 * cost a real bug elsewhere in this schema and the discipline is cheap.
 */
export async function nextWatchlistItemPosition(
  watchlistId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ highest: max(watchlistItems.position) })
    .from(watchlistItems)
    .where(eq(watchlistItems.watchlistId, watchlistId));
  const highest = row?.highest;
  return highest === null || highest === undefined ? 0 : Number(highest) + 1;
}

/** Apply a patch to one entry. */
export async function updateWatchlistItem(
  watchlistId: string,
  itemId: string,
  patch: WatchlistItemPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<WatchlistItemRow | undefined> {
  const [row] = await db
    .update(watchlistItems)
    .set({
      ...(patch.quantity === undefined ? {} : { quantity: patch.quantity }),
      ...(patch.preferredCanonicalVariantId === undefined
        ? {}
        : { preferredCanonicalVariantId: patch.preferredCanonicalVariantId }),
      ...(patch.preferredConditionGroup === undefined
        ? {}
        : { preferredConditionGroup: patch.preferredConditionGroup }),
      ...(patch.preferredMerchantId === undefined
        ? {}
        : { preferredMerchantId: patch.preferredMerchantId }),
      ...(patch.targetAmount === undefined ? {} : { targetAmount: patch.targetAmount }),
      ...(patch.targetCurrency === undefined ? {} : { targetCurrency: patch.targetCurrency }),
      ...(patch.note === undefined ? {} : { note: patch.note }),
    })
    .where(and(eq(watchlistItems.id, itemId), eq(watchlistItems.watchlistId, watchlistId)))
    .returning();
  return row;
}

/** Remove one entry. Its snapshot lines survive with a NULL item pointer. */
export async function deleteWatchlistItem(
  watchlistId: string,
  itemId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const removed = await db
    .delete(watchlistItems)
    .where(and(eq(watchlistItems.id, itemId), eq(watchlistItems.watchlistId, watchlistId)))
    .returning({ id: watchlistItems.id });
  return removed.length > 0;
}

/**
 * Apply a complete reordering.
 *
 * The caller has already checked that `orderedItemIds` is exactly the list's own
 * membership — a PARTIAL reorder is refused rather than applied, because "these
 * five come first and the rest keep whatever they had" is ambiguous the moment
 * two of the rest shared a position. One `UPDATE … FROM (VALUES …)` so the whole
 * reorder is one statement and one visible state.
 */
export async function applyWatchlistItemOrder(
  watchlistId: string,
  orderedItemIds: readonly string[],
  db: DatabaseOrTransaction,
): Promise<number> {
  if (orderedItemIds.length === 0) return 0;

  const values = sql.join(
    orderedItemIds.map((itemId, index) => sql`(${itemId}, ${index})`),
    sql`, `,
  );

  const updated = await db
    .update(watchlistItems)
    .set({ position: sql`ordering.position` })
    .from(sql`(values ${values}) as ordering(item_id, position)`)
    .where(
      and(
        eq(watchlistItems.watchlistId, watchlistId),
        sql`${watchlistItems.id} = ordering.item_id`,
      ),
    )
    .returning({ id: watchlistItems.id });

  return updated.length;
}

/**
 * Mark every RESOLVED entry of a split product ambiguous, naming the job (#81
 * correction rule 2).
 *
 * Idempotent by PREDICATE rather than by a phase record — #80's device, for its
 * reason: the marking only touches `resolved` rows, so a resumed split job
 * re-runs it as a no-op AND an entry already made ambiguous by an EARLIER split
 * keeps naming that earlier job. Retargeting an unanswered question at a newer
 * job would destroy the pair of candidates the buyer was being asked about.
 */
export async function markWatchlistItemsAmbiguousAfterSplit(
  sourceCanonicalProductId: string,
  splitJobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const marked = await db
    .update(watchlistItems)
    .set({ resolutionState: 'ambiguous_after_split', ambiguousSplitJobId: splitJobId })
    .where(
      and(
        eq(watchlistItems.canonicalProductId, sourceCanonicalProductId),
        eq(watchlistItems.resolutionState, 'resolved'),
      ),
    )
    .returning({ id: watchlistItems.id });
  return marked.length;
}

/** Clear one entry's ambiguity — the buyer answered. */
export async function resolveWatchlistItemAmbiguity(
  itemId: string,
  db: DatabaseOrTransaction,
): Promise<void> {
  await db
    .update(watchlistItems)
    .set({ resolutionState: 'resolved', ambiguousSplitJobId: null })
    .where(eq(watchlistItems.id, itemId));
}

/** Point one entry at a different canonical product — the `move_to_target` answer. */
export async function repointWatchlistItem(
  itemId: string,
  canonicalProductId: string,
  db: DatabaseOrTransaction,
): Promise<void> {
  await db
    .update(watchlistItems)
    .set({
      canonicalProductId,
      resolutionState: 'resolved',
      ambiguousSplitJobId: null,
      // A configuration pinned on the SOURCE product cannot be assumed to exist
      // on the target: a split moves variants between two identities, and
      // carrying a pin across would be exactly the "pick another variant
      // silently" #81 correction rule 3 forbids.
      preferredCanonicalVariantId: null,
    })
    .where(eq(watchlistItems.id, itemId));
}

/** How many of this owner's entries are waiting on them across every list. */
export async function countWatchlistItemsAwaitingResolution(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(watchlistItems)
    .innerJoin(watchlists, eq(watchlists.id, watchlistItems.watchlistId))
    .where(
      and(
        eq(watchlists.oxyUserId, oxyUserId),
        eq(watchlistItems.resolutionState, 'ambiguous_after_split'),
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * Every entry of one owner's lists that points at a product in `productIds`.
 *
 * The duplicate-detection read: after a merge leaves a loser-side entry on a
 * tombstone, the evaluation needs to know whether the SAME list also holds the
 * winner. Scoped to one list, because that is the only grain at which the
 * question means anything.
 */
export async function findWatchlistItemsByProducts(
  watchlistId: string,
  canonicalProductIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<{ id: string; canonicalProductId: string }[]> {
  if (canonicalProductIds.length === 0) return [];
  return db
    .select({ id: watchlistItems.id, canonicalProductId: watchlistItems.canonicalProductId })
    .from(watchlistItems)
    .where(
      and(
        eq(watchlistItems.watchlistId, watchlistId),
        inArray(watchlistItems.canonicalProductId, [...canonicalProductIds]),
      ),
    );
}
