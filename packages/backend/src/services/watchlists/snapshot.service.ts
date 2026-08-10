/**
 * Recording and reading a list's evaluations (#81 "List snapshots").
 *
 * ## Evaluating is a READ; recording is a WRITE, and they are separate calls
 *
 * `GET /watchlists/:id/basket` evaluates and writes nothing — a GET that wrote
 * would make "when was this list last measured" answer "whenever somebody last
 * looked at it", and would put a row in a durable table on every page refresh.
 * `POST /watchlists/:id/snapshots` records one, deduplicated.
 *
 * ## The evaluation happens OUTSIDE the transaction, and the write refuses a
 * stale one
 *
 * A comparison per item is several round trips; holding a row lock across them
 * would make one buyer's slow list block their own next write for its duration.
 * So the basket is computed first, and the transaction then locks the list,
 * confirms its version has not moved, and inserts. A list edited mid-evaluation
 * is refused rather than recorded — a snapshot describing a membership that no
 * longer exists is worse than no snapshot, because a later diff would blame the
 * items for a change the buyer made themselves.
 *
 * ## The lock is what makes deduplication correct
 *
 * Two concurrent evaluations of one list would otherwise both read the same
 * predecessor, both decide they differ from it, and both insert — producing two
 * "changes" from one. `lockWatchlistForOwner` serializes them on the list's own
 * row, which is the cheapest correct answer: a lock somebody else holds is a
 * lock on their own list.
 */

import {
  hasKnownBasketTotal,
  hasKnownDelivery,
  type WatchlistBasket,
  type WatchlistSnapshot,
  type WatchlistSnapshotDetail,
  type WatchlistSnapshotDiff,
  type WatchlistSnapshotLine,
  type WatchlistSnapshotSelection,
  type WatchlistSnapshotWriteResult,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { RETENTION_SECONDS } from '../../db/expiryTargets.js';
import {
  findLatestWatchlistSnapshot,
  findWatchlistSnapshot,
  insertWatchlistSnapshot,
  listWatchlistSnapshotLines,
  listWatchlistSnapshots,
  type NewWatchlistSnapshotLine,
  type WatchlistSnapshotItemRow,
  type WatchlistSnapshotRow,
} from '../../db/watchlists/watchlistSnapshotRepository.js';
import {
  lockWatchlistForOwner,
  stampWatchlistEvaluated,
} from '../../db/watchlists/watchlistRepository.js';
import {
  listWatchlistItemFacts,
  listWatchlistItemsForOwner,
} from '../../db/watchlists/watchlistItemRepository.js';
import { diffWatchlistSnapshots, type DiffSide } from './diff.js';
import { evaluateWatchlistBasket } from './evaluation.service.js';
import { deriveMaterialChanges, watchlistContentDigest } from './snapshot-content.js';
import {
  projectWatchlistItem,
  requireOwnedWatchlist,
  watchlistVersionConflict,
} from './watchlist.service.js';

/** One stored snapshot header, projected. Names every field. */
export function projectWatchlistSnapshot(row: WatchlistSnapshotRow): WatchlistSnapshot {
  return {
    id: row.id,
    watchlistId: row.watchlistId,
    listVersion: row.listVersion,
    rankingPolicyVersions: row.rankingPolicyVersions,
    displayCurrency: row.displayCurrency,
    ...(row.market === null ? {} : { market: row.market }),
    total:
      row.completeness === 'unknown' || row.totalAmount === null || row.basis === null
        ? { known: false, completeness: 'unknown' }
        : {
            known: true,
            completeness: row.completeness === 'complete' ? 'complete' : 'partial',
            basis: row.basis,
            amount: { amount: row.totalAmount, currency: row.displayCurrency },
            includedItems: row.pricedItemCount,
            excludedItems: row.unresolvedItemCount,
          },
    itemCount: row.itemCount,
    pricedItemCount: row.pricedItemCount,
    unresolvedItemCount: row.unresolvedItemCount,
    materialChanges: row.materialChanges,
    ...(row.previousSnapshotId === null ? {} : { previousSnapshotId: row.previousSnapshotId }),
    evaluatedAt: row.evaluatedAt.toISOString(),
  };
}

/**
 * One stored snapshot line, projected.
 *
 * It carries a note nowhere, because there is none stored — the evaluation reads
 * items through `publicColumns`, so a note has no path into this table at all
 * (#81 privacy rules 2 and 4).
 */
function projectSnapshotLine(row: WatchlistSnapshotItemRow): WatchlistSnapshotLine {
  const selection: WatchlistSnapshotSelection | undefined =
    row.state === 'priced' &&
    row.selectedOfferId !== null &&
    row.selectedAvailability !== null &&
    row.rankingPolicyVersion !== null &&
    row.unitItemPriceAmount !== null &&
    row.unitItemPriceCurrency !== null &&
    row.lineItemPriceAmount !== null
      ? {
          offerId: row.selectedOfferId,
          ...(row.selectedCanonicalVariantId === null
            ? {}
            : { canonicalVariantId: row.selectedCanonicalVariantId }),
          availability: row.selectedAvailability,
          rankingPolicyVersion: row.rankingPolicyVersion,
          unitItemPrice: { amount: row.unitItemPriceAmount, currency: row.unitItemPriceCurrency },
          lineItemPrice: { amount: row.lineItemPriceAmount, currency: row.unitItemPriceCurrency },
          ...(row.unitDeliveryAmount === null || row.lineDeliveryAmount === null
            ? {}
            : {
                unitDelivery: {
                  amount: row.unitDeliveryAmount,
                  currency: row.unitItemPriceCurrency,
                },
                lineDelivery: {
                  amount: row.lineDeliveryAmount,
                  currency: row.unitItemPriceCurrency,
                },
              }),
          ...(row.fxRate === null ||
          row.fxFrom === null ||
          row.fxTo === null ||
          row.fxProvider === null ||
          row.fxAsOf === null
            ? {}
            : {
                fx: {
                  from: row.fxFrom,
                  to: row.fxTo,
                  rate: row.fxRate,
                  provider: row.fxProvider,
                  asOf: row.fxAsOf.toISOString(),
                },
              }),
        }
      : undefined;

  return {
    // A removed item leaves its line standing with a NULL pointer — that IS the
    // history (#81 correction rule 5). The empty string says "this line no
    // longer names a live entry" without inventing an id that would resolve to
    // somebody's current item.
    itemId: row.watchlistItemId ?? '',
    canonicalProductId: row.canonicalProductId,
    ...(row.preferredCanonicalVariantId === null
      ? {}
      : { preferredCanonicalVariantId: row.preferredCanonicalVariantId }),
    quantity: row.quantity,
    position: row.position,
    state: row.state === 'priced' ? 'priced' : 'unresolved',
    ...(row.unresolvedReason === null ? {} : { unresolvedReason: row.unresolvedReason }),
    ...(selection === undefined ? {} : { selection }),
  };
}

/** Turn one evaluated basket into the rows a snapshot is made of. */
function composeSnapshotLines(basket: WatchlistBasket): NewWatchlistSnapshotLine[] {
  return basket.lines.map((line) => {
    if (line.evaluation.state === 'unresolved') {
      return {
        watchlistItemId: line.item.id,
        canonicalProductId: line.item.canonicalProductId,
        preferredCanonicalVariantId: line.item.preferredCanonicalVariantId ?? null,
        quantity: line.item.quantity,
        position: line.item.position,
        state: 'unresolved' as const,
        unresolvedReason: line.evaluation.reason,
        selectedOfferId: null,
        selectedCanonicalVariantId: null,
        selectedAvailability: null,
        rankingPolicyVersion: null,
        unitItemPriceAmount: null,
        unitItemPriceCurrency: null,
        lineItemPriceAmount: null,
        unitDeliveryAmount: null,
        lineDeliveryAmount: null,
        nativeCurrency: null,
        fxRate: null,
        fxFrom: null,
        fxTo: null,
        fxProvider: null,
        fxAsOf: null,
      };
    }

    const selection = line.evaluation.selection;
    const converted = selection.unitItemPriceFx.from !== selection.unitItemPriceFx.to;
    return {
      watchlistItemId: line.item.id,
      canonicalProductId: line.item.canonicalProductId,
      preferredCanonicalVariantId: line.item.preferredCanonicalVariantId ?? null,
      quantity: line.item.quantity,
      position: line.item.position,
      state: 'priced' as const,
      unresolvedReason: null,
      selectedOfferId: selection.offerId,
      selectedCanonicalVariantId: selection.canonicalVariantId,
      selectedAvailability: selection.availability,
      rankingPolicyVersion: selection.rankingPolicyVersion,
      unitItemPriceAmount: selection.unitItemPrice.amount,
      unitItemPriceCurrency: selection.unitItemPrice.currency,
      lineItemPriceAmount: selection.lineItemPrice.amount,
      unitDeliveryAmount: hasKnownDelivery(selection.delivery)
        ? selection.delivery.unit.amount
        : null,
      lineDeliveryAmount: hasKnownDelivery(selection.delivery)
        ? selection.delivery.line.amount
        : null,
      // The offer's OWN currency is the quote's `from` when a conversion
      // happened, and the display currency itself when none did. Storing it
      // either way is what makes the FX biconditional checkable at the row.
      nativeCurrency: converted ? selection.unitItemPriceFx.from : selection.unitItemPrice.currency,
      fxRate: converted ? selection.unitItemPriceFx.rate : null,
      fxFrom: converted ? selection.unitItemPriceFx.from : null,
      fxTo: converted ? selection.unitItemPriceFx.to : null,
      fxProvider: converted ? selection.unitItemPriceFx.provider : null,
      fxAsOf: converted ? new Date(selection.unitItemPriceFx.asOf) : null,
    };
  });
}

/** Evaluate one list without recording anything. */
export async function readWatchlistBasket(
  oxyUserId: string,
  watchlistId: string,
): Promise<WatchlistBasket> {
  const watchlist = await requireOwnedWatchlist(oxyUserId, watchlistId);
  const [facts, owned, latest] = await Promise.all([
    listWatchlistItemFacts(watchlistId),
    listWatchlistItemsForOwner(watchlistId),
    findLatestWatchlistSnapshot(watchlistId),
  ]);
  const priorLines = latest ? await listWatchlistSnapshotLines([latest.id]) : [];

  return evaluateWatchlistBasket({
    watchlist,
    items: facts,
    projected: owned.map(projectWatchlistItem),
    ...(latest
      ? {
          prior: {
            id: latest.id,
            displayCurrency: latest.displayCurrency,
            rankingPolicyVersions: latest.rankingPolicyVersions,
            evaluatedAt: latest.evaluatedAt,
            lines: priorLines,
          },
        }
      : {}),
  });
}

/**
 * Evaluate one list and record the result, unless it is identical to the
 * previous recording.
 *
 * A dedupe is a SUCCESS and says so (`deduplicated`): #81 asks for unchanged
 * snapshots to be deduplicated, so an evaluation that changed nothing returns
 * the snapshot it matched rather than growing the table. `last_evaluated_at`
 * moves either way, because the list WAS evaluated — that is the fact the column
 * records.
 */
export async function recordWatchlistSnapshot(
  oxyUserId: string,
  watchlistId: string,
): Promise<WatchlistSnapshotWriteResult> {
  const basket = await readWatchlistBasket(oxyUserId, watchlistId);
  const digest = watchlistContentDigest(basket);
  const evaluatedAt = new Date(basket.evaluatedAt);

  return getDb().transaction(async (tx) => {
    const locked = await lockWatchlistForOwner(oxyUserId, watchlistId, tx);
    if (!locked) throw notFound('No such watchlist.');
    if (locked.version !== basket.listVersion) {
      // The list changed while it was being evaluated. Recording the basket
      // anyway would attach a membership nobody has to a version somebody does.
      throw watchlistVersionConflict(watchlistId, basket.listVersion, locked.version);
    }

    const latest = await findLatestWatchlistSnapshot(watchlistId, tx);
    if (latest && latest.contentDigest === digest) {
      await stampWatchlistEvaluated(watchlistId, evaluatedAt, tx);
      return {
        outcome: 'deduplicated' as const,
        snapshot: projectWatchlistSnapshot(latest),
        basket,
      };
    }

    const priorLines = latest ? await listWatchlistSnapshotLines([latest.id], tx) : [];
    const materialChanges = deriveMaterialChanges(
      basket,
      latest
        ? {
            displayCurrency: latest.displayCurrency,
            market: latest.market,
            basis: latest.basis,
            completeness: latest.completeness,
            totalAmount: latest.totalAmount,
            rankingPolicyVersions: latest.rankingPolicyVersions,
            lines: priorLines,
          }
        : undefined,
    );

    const total = basket.total;
    const snapshot = await insertWatchlistSnapshot(
      {
        watchlistId,
        listVersion: basket.listVersion,
        rankingPolicyVersions: basket.rankingPolicyVersions,
        displayCurrency: basket.displayCurrency,
        market: basket.market ?? null,
        completeness: hasKnownBasketTotal(total) ? total.completeness : 'unknown',
        basis: hasKnownBasketTotal(total) ? total.basis : null,
        totalAmount: hasKnownBasketTotal(total) ? total.amount.amount : null,
        materialChanges,
        previousSnapshotId: latest?.id ?? null,
        contentDigest: digest,
        evaluatedAt,
        retentionExpiresAt: new Date(
          evaluatedAt.getTime() + RETENTION_SECONDS.watchlistSnapshot * 1000,
        ),
      },
      composeSnapshotLines(basket),
      basket.lines.length,
      tx,
    );

    await stampWatchlistEvaluated(watchlistId, evaluatedAt, tx);
    return { outcome: 'recorded' as const, snapshot: projectWatchlistSnapshot(snapshot), basket };
  });
}

/** One list's recorded history, newest first. */
export async function readWatchlistSnapshots(
  oxyUserId: string,
  watchlistId: string,
  limit?: number,
): Promise<readonly WatchlistSnapshot[]> {
  await requireOwnedWatchlist(oxyUserId, watchlistId);
  const rows = await listWatchlistSnapshots(
    watchlistId,
    Math.min(limit ?? config.watchlists.snapshotPageSize, config.watchlists.snapshotPageSize),
  );
  return rows.map(projectWatchlistSnapshot);
}

/** One recorded evaluation with its lines. */
export async function readWatchlistSnapshotDetail(
  oxyUserId: string,
  watchlistId: string,
  snapshotId: string,
): Promise<WatchlistSnapshotDetail> {
  await requireOwnedWatchlist(oxyUserId, watchlistId);
  const row = await findWatchlistSnapshot(watchlistId, snapshotId);
  if (!row) throw notFound('No such snapshot on that watchlist.');
  const lines = await listWatchlistSnapshotLines([row.id]);
  return { snapshot: projectWatchlistSnapshot(row), lines: lines.map(projectSnapshotLine) };
}

/** Both sides of a diff, as `diff.ts` expects them. */
function diffSide(row: WatchlistSnapshotRow, lines: readonly WatchlistSnapshotItemRow[]): DiffSide {
  return {
    snapshotId: row.id,
    displayCurrency: row.displayCurrency,
    basis: row.basis,
    totalAmount: row.totalAmount,
    rankingPolicyVersions: row.rankingPolicyVersions,
    lines: lines
      .filter((line) => line.snapshotId === row.id)
      .map((line) => ({
        watchlistItemId: line.watchlistItemId,
        canonicalProductId: line.canonicalProductId,
        state: line.state,
        quantity: line.quantity,
        selectedOfferId: line.selectedOfferId,
        unitItemPriceAmount: line.unitItemPriceAmount,
        lineItemPriceAmount: line.lineItemPriceAmount,
      })),
  };
}

/**
 * Which items drove the change between one snapshot and its predecessor (#81
 * basket rule 4).
 *
 * The baseline is the snapshot's OWN recorded predecessor rather than "the one
 * before it by time": a snapshot that names its predecessor names the comparison
 * that produced its `material_changes`, and reading a different baseline would
 * explain a change with evidence from another pair.
 */
export async function readWatchlistSnapshotDiff(
  oxyUserId: string,
  watchlistId: string,
  snapshotId: string,
): Promise<WatchlistSnapshotDiff> {
  await requireOwnedWatchlist(oxyUserId, watchlistId);
  const current = await findWatchlistSnapshot(watchlistId, snapshotId);
  if (!current) throw notFound('No such snapshot on that watchlist.');
  if (current.previousSnapshotId === null) {
    return { comparable: false, reason: 'no_prior_snapshot' };
  }

  const baseline = await findWatchlistSnapshot(watchlistId, current.previousSnapshotId);
  if (!baseline) {
    // The predecessor was swept by retention. Its absence is not an error and
    // not a comparison — the honest answer is the one a first snapshot gets.
    return { comparable: false, reason: 'no_prior_snapshot' };
  }

  const lines = await listWatchlistSnapshotLines([baseline.id, current.id]);
  return diffWatchlistSnapshots(diffSide(baseline, lines), diffSide(current, lines));
}
