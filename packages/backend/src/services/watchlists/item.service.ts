/**
 * Watchlist items — add, change, reorder, remove, and answer a split (#81 model
 * rules 6–10, UX rule 2, correction rules 1–3).
 *
 * ## Every mutation is one transaction and one version bump
 *
 * The item write and the list's `version` move together, so a client's next edit
 * against a copy it read before this one is refused rather than applied. The
 * bump is the FIRST statement in the transaction, deliberately: it is the one
 * that can legitimately fail, and doing it first means a stale write never
 * touches an item at all.
 *
 * ## A reorder is TOTAL or it is refused
 *
 * `PUT .../items/order` takes the complete ordered membership. A partial reorder
 * ("these three go first") is ambiguous the moment two of the rest share a
 * position, and the ambiguity is invisible: the list simply comes back in an
 * order nobody asked for. Refusing an incomplete set costs a client one extra
 * field and removes the whole class.
 *
 * ## The split answers are #80's three, for #80's reason
 *
 * `keep_both` exists because the honest reading of a split is often "these were
 * always two things and I want both", which a `move: true|false` contract cannot
 * express — and the affordance a client builds from a boolean is the one that
 * quietly loses half a buyer's list.
 */

import {
  WATCHLIST_MAX_ITEM_QUANTITY,
  type ConditionGroup,
  type CurrencyCode,
  type WatchlistItem,
  type WatchlistItemSplitResolution,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { findSplitJobById } from '../../db/curation/jobRepository.js';
import {
  applyWatchlistItemOrder,
  countWatchlistItemsAwaitingResolution,
  deleteWatchlistItem,
  findWatchlistItem,
  insertWatchlistItem,
  listWatchlistItemsForOwner,
  nextWatchlistItemPosition,
  repointWatchlistItem,
  resolveWatchlistItemAmbiguity,
  updateWatchlistItem,
} from '../../db/watchlists/watchlistItemRepository.js';
import { bumpWatchlistVersion } from '../../db/watchlists/watchlistRepository.js';
import {
  assertWatchlistHasRoom,
  projectWatchlistItem,
  requireOwnedWatchlist,
  watchlistVersionConflict,
} from './watchlist.service.js';

/** What an add accepts. */
export interface AddWatchlistItemInput {
  readonly oxyUserId: string;
  readonly watchlistId: string;
  readonly expectedVersion: number;
  readonly canonicalProductId: string;
  readonly quantity?: number;
  readonly preferredCanonicalVariantId?: string;
  readonly preferredConditionGroup?: ConditionGroup;
  readonly preferredMerchantId?: string;
  readonly targetAmount?: number;
  readonly targetCurrency?: CurrencyCode;
  readonly note?: string;
}

/**
 * Advance the list's version, or refuse.
 *
 * One statement, and it is what every mutation in this file opens with. The
 * ownership read that precedes it exists only so the refusal can name the
 * current version — the CAS itself already carries `oxy_user_id`, so a caller
 * who does not own the list can never move it.
 */
async function requireCurrentVersion(
  oxyUserId: string,
  watchlistId: string,
  expectedVersion: number,
  db: DatabaseOrTransaction,
): Promise<void> {
  const current = await requireOwnedWatchlist(oxyUserId, watchlistId);
  const bumped = await bumpWatchlistVersion(oxyUserId, watchlistId, expectedVersion, {}, db);
  if (!bumped) throw watchlistVersionConflict(watchlistId, expectedVersion, current.version);
}

/**
 * Add one product to a list, or converge on the entry already there.
 *
 * `insertWatchlistItem` is `ON CONFLICT DO NOTHING`, so a double tap and a retry
 * after a timeout the client never saw both end with ONE entry carrying the
 * quantity and preferences of the first call. `created` says which happened, so
 * a client can tell "added" from "already there" without a second read.
 */
export async function addWatchlistItem(
  input: AddWatchlistItemInput,
): Promise<{ item: WatchlistItem; created: boolean; version: number }> {
  await assertWatchlistHasRoom(input.watchlistId);

  return getDb().transaction(async (tx) => {
    await requireCurrentVersion(input.oxyUserId, input.watchlistId, input.expectedVersion, tx);

    const { item, created } = await insertWatchlistItem(
      {
        watchlistId: input.watchlistId,
        canonicalProductId: input.canonicalProductId,
        quantity: input.quantity ?? 1,
        position: await nextWatchlistItemPosition(input.watchlistId, tx),
        preferredCanonicalVariantId: input.preferredCanonicalVariantId ?? null,
        preferredConditionGroup: input.preferredConditionGroup ?? null,
        preferredMerchantId: input.preferredMerchantId ?? null,
        targetAmount: input.targetAmount ?? null,
        targetCurrency: input.targetCurrency ?? null,
        note: input.note ?? null,
      },
      tx,
    );

    return { item: projectWatchlistItem(item), created, version: input.expectedVersion + 1 };
  });
}

/** What a patch may change. `null` clears; absent leaves alone. */
export interface UpdateWatchlistItemInput {
  readonly oxyUserId: string;
  readonly watchlistId: string;
  readonly itemId: string;
  readonly expectedVersion: number;
  readonly quantity?: number;
  readonly preferredCanonicalVariantId?: string | null;
  readonly preferredConditionGroup?: ConditionGroup | null;
  readonly preferredMerchantId?: string | null;
  readonly targetAmount?: number | null;
  readonly targetCurrency?: CurrencyCode | null;
  readonly note?: string | null;
}

/**
 * Change one entry's quantity, preferences, target or note.
 *
 * A target is a PAIR: both halves move together or neither does, because an
 * amount with no currency is not a target and the CHECK would refuse it anyway.
 * Clearing is `null` for both.
 */
export async function changeWatchlistItem(
  input: UpdateWatchlistItemInput,
): Promise<{ item: WatchlistItem; version: number }> {
  if (input.quantity !== undefined) {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw validationError('A quantity must be a whole number of at least 1.');
    }
    if (input.quantity > WATCHLIST_MAX_ITEM_QUANTITY) {
      throw validationError(
        `A quantity may not exceed ${WATCHLIST_MAX_ITEM_QUANTITY}.`,
      );
    }
  }
  const amountGiven = input.targetAmount !== undefined;
  const currencyGiven = input.targetCurrency !== undefined;
  if (amountGiven !== currencyGiven) {
    throw validationError(
      'A target is an amount AND a currency. Send both to set one, or both as null to clear it.',
    );
  }
  if (amountGiven && (input.targetAmount === null) !== (input.targetCurrency === null)) {
    throw validationError('A target amount and its currency must be set or cleared together.');
  }

  return getDb().transaction(async (tx) => {
    await requireCurrentVersion(input.oxyUserId, input.watchlistId, input.expectedVersion, tx);

    const updated = await updateWatchlistItem(
      input.watchlistId,
      input.itemId,
      {
        ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
        ...(input.preferredCanonicalVariantId === undefined
          ? {}
          : { preferredCanonicalVariantId: input.preferredCanonicalVariantId }),
        ...(input.preferredConditionGroup === undefined
          ? {}
          : { preferredConditionGroup: input.preferredConditionGroup }),
        ...(input.preferredMerchantId === undefined
          ? {}
          : { preferredMerchantId: input.preferredMerchantId }),
        ...(input.targetAmount === undefined ? {} : { targetAmount: input.targetAmount }),
        ...(input.targetCurrency === undefined ? {} : { targetCurrency: input.targetCurrency }),
        ...(input.note === undefined ? {} : { note: input.note }),
      },
      tx,
    );
    if (!updated) throw notFound('No such item on that watchlist.');

    return { item: projectWatchlistItem(updated), version: input.expectedVersion + 1 };
  });
}

/**
 * Remove one entry.
 *
 * Its recorded snapshot lines survive with a NULL item pointer — that IS the
 * history, and #81 correction rule 5 keeps it. Removing an entry that is not
 * there is a 404 rather than a converged success: unlike an ADD, which a client
 * may legitimately retry blind, a delete names an id the client read, so a
 * missing one means their copy is wrong.
 */
export async function removeWatchlistItem(
  oxyUserId: string,
  watchlistId: string,
  itemId: string,
  expectedVersion: number,
): Promise<{ removed: boolean; version: number }> {
  return getDb().transaction(async (tx) => {
    await requireCurrentVersion(oxyUserId, watchlistId, expectedVersion, tx);
    const removed = await deleteWatchlistItem(watchlistId, itemId, tx);
    if (!removed) throw notFound('No such item on that watchlist.');
    return { removed: true, version: expectedVersion + 1 };
  });
}

/**
 * Apply a complete reordering (#81 UX rule 2).
 *
 * The submitted set must equal the list's membership EXACTLY — same ids, no
 * duplicates, nothing missing. The comparison is on the set rather than on the
 * count alone, because a client that sent one id twice and dropped another would
 * pass a length check and leave two entries sharing a position.
 */
export async function reorderWatchlistItems(
  oxyUserId: string,
  watchlistId: string,
  expectedVersion: number,
  orderedItemIds: readonly string[],
): Promise<{ items: readonly WatchlistItem[]; version: number }> {
  return getDb().transaction(async (tx) => {
    await requireCurrentVersion(oxyUserId, watchlistId, expectedVersion, tx);

    const current = await listWatchlistItemsForOwner(watchlistId, tx);
    const held = new Set(current.map((item) => item.id));
    const submitted = new Set(orderedItemIds);
    const complete =
      submitted.size === orderedItemIds.length &&
      submitted.size === held.size &&
      [...held].every((id) => submitted.has(id));
    if (!complete) {
      throw validationError(
        'A reorder must list every item of the watchlist exactly once. Send the whole order, ' +
          'not the part that moved.',
      );
    }

    await applyWatchlistItemOrder(watchlistId, orderedItemIds, tx);
    const reordered = await listWatchlistItemsForOwner(watchlistId, tx);
    return { items: reordered.map(projectWatchlistItem), version: expectedVersion + 1 };
  });
}

/**
 * Answer a split ambiguity for one entry (#81 correction rule 2).
 *
 * `keep_source` clears the flag and leaves the entry where it is. `move_to_target`
 * repoints it at the product the split minted — and clears any pinned variant,
 * because a configuration pinned on the source cannot be assumed to exist on the
 * target, and carrying it across would be the silent substitution correction
 * rule 3 forbids. `keep_both` clears the flag AND adds a second entry for the
 * target, which is the reading a boolean contract cannot express.
 *
 * `move_to_target` onto a product the list ALREADY holds removes the ambiguous
 * entry instead of violating the unique: the buyer's list ends with exactly one
 * entry for the destination, which is what "move it there" means when they are
 * already there (#80's answer, one domain over).
 */
export async function resolveWatchlistItemSplit(input: {
  readonly oxyUserId: string;
  readonly watchlistId: string;
  readonly itemId: string;
  readonly expectedVersion: number;
  readonly resolution: WatchlistItemSplitResolution;
}): Promise<{ items: readonly WatchlistItem[]; version: number }> {
  return getDb().transaction(async (tx) => {
    await requireCurrentVersion(input.oxyUserId, input.watchlistId, input.expectedVersion, tx);

    const item = await findWatchlistItem(input.watchlistId, input.itemId, tx);
    if (!item) throw notFound('No such item on that watchlist.');
    if (item.resolutionState !== 'ambiguous_after_split' || item.ambiguousSplitJobId === null) {
      throw conflict('That item is not waiting on a split decision.');
    }

    if (input.resolution === 'keep_source') {
      await resolveWatchlistItemAmbiguity(input.itemId, tx);
    } else {
      const job = await findSplitJobById(item.ambiguousSplitJobId, tx);
      const targetId = job?.targetEntityId ?? null;
      if (targetId === null) {
        throw conflict(
          'That split has not produced its second product yet, so there is nothing to move to.',
        );
      }

      const siblings = await listWatchlistItemsForOwner(input.watchlistId, tx);
      const alreadyHolds = siblings.some(
        (sibling) => sibling.id !== item.id && sibling.canonicalProductId === targetId,
      );

      if (input.resolution === 'move_to_target') {
        if (alreadyHolds) {
          await deleteWatchlistItem(input.watchlistId, input.itemId, tx);
        } else {
          await repointWatchlistItem(input.itemId, targetId, tx);
        }
      } else {
        await resolveWatchlistItemAmbiguity(input.itemId, tx);
        if (!alreadyHolds) {
          await assertWatchlistHasRoom(input.watchlistId);
          await insertWatchlistItem(
            {
              watchlistId: input.watchlistId,
              canonicalProductId: targetId,
              quantity: item.quantity,
              position: await nextWatchlistItemPosition(input.watchlistId, tx),
              // The preferences are NOT copied: they were expressed about the
              // source product's own configurations and sellers, and asserting
              // them over a product the buyer has not looked at yet would narrow
              // a brand-new entry to filters they never chose for it.
              note: item.note,
            },
            tx,
          );
        }
      }
    }

    const items = await listWatchlistItemsForOwner(input.watchlistId, tx);
    return { items: items.map(projectWatchlistItem), version: input.expectedVersion + 1 };
  });
}

/** How many entries across every list are waiting on this buyer to answer. */
export async function countWatchlistItemsPendingResolution(oxyUserId: string): Promise<number> {
  return countWatchlistItemsAwaitingResolution(oxyUserId);
}
