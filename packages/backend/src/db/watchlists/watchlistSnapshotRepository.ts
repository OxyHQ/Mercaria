/**
 * `watchlist_snapshots` and `watchlist_snapshot_items` — the only writer of a
 * recorded evaluation (#81 snapshot rules 1–6).
 *
 * ## The counters are checked against the LINES before any SQL is issued
 *
 * `watchlist_snapshots_item_counts_check` states the arithmetic at the row
 * (`item_count = priced + unresolved`, equality), and that is the half a service
 * bug cannot walk around. What a CHECK cannot see is whether those counters
 * describe the lines actually being inserted — that is cross-row — so
 * {@link insertWatchlistSnapshot} refuses a mismatch itself, the
 * `insertRetailCostQuote` device (#120). Both layers exist because they fail on
 * different mistakes: the CHECK catches a hand-written INSERT and a replay, the
 * service catches a composition that dropped a line.
 *
 * ## Nothing here UPDATES a snapshot, and DELETE is permitted
 *
 * A recorded evaluation is what a buyer was shown; rewriting one is how a price
 * history stops being evidence, and there is no function in this file that
 * could. DELETE is left available because erasure on a schedule is the retention
 * policy — a trigger refusing it would make the shared expiry sweep fail
 * silently on every row it was meant to remove (`analytics_events`'
 * `offer_price_snapshots`' posture).
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  CurrencyCode,
  OfferAvailability,
  WatchlistBasketBasis,
  WatchlistBasketCompleteness,
  WatchlistItemUnresolvedReason,
  WatchlistSnapshotChangeKind,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { watchlistSnapshotItems, watchlistSnapshots } from '../schema/watchlists.js';

/** One row of `watchlist_snapshots`. */
export type WatchlistSnapshotRow = InferSelectModel<typeof watchlistSnapshots>;
/** One row of `watchlist_snapshot_items`. */
export type WatchlistSnapshotItemRow = InferSelectModel<typeof watchlistSnapshotItems>;

/** One line of a snapshot, as the writer is handed it. */
export interface NewWatchlistSnapshotLine {
  readonly watchlistItemId: string | null;
  readonly canonicalProductId: string;
  readonly preferredCanonicalVariantId: string | null;
  readonly quantity: number;
  readonly position: number;
  readonly state: 'priced' | 'unresolved';
  readonly unresolvedReason: WatchlistItemUnresolvedReason | null;
  readonly selectedOfferId: string | null;
  readonly selectedCanonicalVariantId: string | null;
  readonly selectedAvailability: OfferAvailability | null;
  readonly rankingPolicyVersion: string | null;
  readonly unitItemPriceAmount: number | null;
  readonly unitItemPriceCurrency: CurrencyCode | null;
  readonly lineItemPriceAmount: number | null;
  readonly unitDeliveryAmount: number | null;
  readonly lineDeliveryAmount: number | null;
  readonly nativeCurrency: CurrencyCode | null;
  readonly fxRate: number | null;
  readonly fxFrom: CurrencyCode | null;
  readonly fxTo: CurrencyCode | null;
  readonly fxProvider: string | null;
  readonly fxAsOf: Date | null;
}

/** One snapshot header, as the writer is handed it. */
export interface NewWatchlistSnapshot {
  readonly watchlistId: string;
  readonly listVersion: number;
  readonly rankingPolicyVersions: readonly string[];
  readonly displayCurrency: CurrencyCode;
  readonly market: string | null;
  readonly completeness: WatchlistBasketCompleteness;
  readonly basis: WatchlistBasketBasis | null;
  readonly totalAmount: number | null;
  readonly materialChanges: readonly WatchlistSnapshotChangeKind[];
  readonly previousSnapshotId: string | null;
  readonly contentDigest: string;
  readonly evaluatedAt: Date;
  readonly retentionExpiresAt: Date;
}

/**
 * Record one evaluation, header and lines, in the caller's transaction.
 *
 * The counters are DERIVED from the lines here rather than accepted from the
 * caller: a parameter for a number the rows already answer is a second
 * representation of one fact, and the failure mode is a snapshot that says it
 * measured eleven items while carrying ten. What the caller still owes is the
 * lines themselves, and the refusal below is what catches a caller that composed
 * fewer than the list holds.
 */
export async function insertWatchlistSnapshot(
  input: NewWatchlistSnapshot,
  lines: readonly NewWatchlistSnapshotLine[],
  expectedItemCount: number,
  db: DatabaseOrTransaction,
): Promise<WatchlistSnapshotRow> {
  if (lines.length !== expectedItemCount) {
    throw new Error(
      `Refusing to record a watchlist snapshot: the list holds ${expectedItemCount} item(s) and ` +
        `${lines.length} line(s) were composed. A snapshot that measured fewer items than the ` +
        'list contains reads exactly like a clean one.',
    );
  }

  const priced = lines.filter((line) => line.state === 'priced').length;
  const unresolved = lines.length - priced;

  const [snapshot] = await db
    .insert(watchlistSnapshots)
    .values({
      watchlistId: input.watchlistId,
      listVersion: input.listVersion,
      rankingPolicyVersions: [...input.rankingPolicyVersions],
      displayCurrency: input.displayCurrency,
      market: input.market,
      completeness: input.completeness,
      basis: input.basis,
      totalAmount: input.totalAmount,
      itemCount: lines.length,
      pricedItemCount: priced,
      unresolvedItemCount: unresolved,
      materialChanges: [...input.materialChanges],
      previousSnapshotId: input.previousSnapshotId,
      contentDigest: input.contentDigest,
      evaluatedAt: input.evaluatedAt,
      retentionExpiresAt: input.retentionExpiresAt,
    })
    .returning();
  if (!snapshot) throw new Error('Failed to record the watchlist snapshot.');

  if (lines.length > 0) {
    await db.insert(watchlistSnapshotItems).values(
      lines.map((line) => ({
        snapshotId: snapshot.id,
        watchlistItemId: line.watchlistItemId,
        canonicalProductId: line.canonicalProductId,
        preferredCanonicalVariantId: line.preferredCanonicalVariantId,
        quantity: line.quantity,
        position: line.position,
        state: line.state,
        unresolvedReason: line.unresolvedReason,
        selectedOfferId: line.selectedOfferId,
        selectedCanonicalVariantId: line.selectedCanonicalVariantId,
        selectedAvailability: line.selectedAvailability,
        rankingPolicyVersion: line.rankingPolicyVersion,
        unitItemPriceAmount: line.unitItemPriceAmount,
        unitItemPriceCurrency: line.unitItemPriceCurrency,
        lineItemPriceAmount: line.lineItemPriceAmount,
        unitDeliveryAmount: line.unitDeliveryAmount,
        lineDeliveryAmount: line.lineDeliveryAmount,
        nativeCurrency: line.nativeCurrency,
        fxRate: line.fxRate,
        fxFrom: line.fxFrom,
        fxTo: line.fxTo,
        fxProvider: line.fxProvider,
        fxAsOf: line.fxAsOf,
      })),
    );
  }

  return snapshot;
}

/** The most recent snapshot of one list — what a dedupe compares against. */
export async function findLatestWatchlistSnapshot(
  watchlistId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<WatchlistSnapshotRow | undefined> {
  const [row] = await db
    .select()
    .from(watchlistSnapshots)
    .where(eq(watchlistSnapshots.watchlistId, watchlistId))
    .orderBy(desc(watchlistSnapshots.evaluatedAt), desc(watchlistSnapshots.id))
    .limit(1);
  return row;
}

/** One list's history, newest first, bounded by the caller. */
export async function listWatchlistSnapshots(
  watchlistId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<WatchlistSnapshotRow[]> {
  return db
    .select()
    .from(watchlistSnapshots)
    .where(eq(watchlistSnapshots.watchlistId, watchlistId))
    .orderBy(desc(watchlistSnapshots.evaluatedAt), desc(watchlistSnapshots.id))
    .limit(limit);
}

/** One snapshot, scoped to the list it must belong to. */
export async function findWatchlistSnapshot(
  watchlistId: string,
  snapshotId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<WatchlistSnapshotRow | undefined> {
  const [row] = await db
    .select()
    .from(watchlistSnapshots)
    .where(
      and(
        eq(watchlistSnapshots.id, snapshotId),
        eq(watchlistSnapshots.watchlistId, watchlistId),
      ),
    )
    .limit(1);
  return row;
}

/** Every line of one or more snapshots, in list order. */
export async function listWatchlistSnapshotLines(
  snapshotIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<WatchlistSnapshotItemRow[]> {
  if (snapshotIds.length === 0) return [];
  return db
    .select()
    .from(watchlistSnapshotItems)
    .where(inArray(watchlistSnapshotItems.snapshotId, [...snapshotIds]))
    .orderBy(watchlistSnapshotItems.snapshotId, watchlistSnapshotItems.position);
}
