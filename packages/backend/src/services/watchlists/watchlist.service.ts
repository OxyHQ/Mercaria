/**
 * Watchlists — create, read, rename, duplicate, delete (#81 model rules 1–5 and
 * 11, UX rules 1 and 7).
 *
 * ## Opening a list never evaluates it
 *
 * {@link readWatchlist} reads two tables and calls nothing else. That is #81
 * acceptance 7 in the call graph rather than in a `try`: if the offer
 * comparison, the FX provider or the catalogue is having a bad day, a buyer can
 * still open their list, reorder it, change a quantity and add an item — because
 * none of those paths can reach a module that could fail on their behalf. The
 * basket is a SEPARATE read, and its failures are per item (`evaluation.service`).
 *
 * ## Every mutation carries `expectedVersion`, including the ones about items
 *
 * The list is the concurrency unit (#81 acceptance 4): a client holds and
 * renders a whole list, so a reorder computed against one membership must not be
 * applied to another. `bumpWatchlistVersion` is the compare-and-swap and it is
 * one statement — there is no read-then-write anywhere in this domain, because
 * a read-then-write is exactly what the second client defeats.
 *
 * ## The limits refuse BEFORE the write, and the error names the limit
 *
 * #81 privacy rule 3. A cross-row limit cannot be a CHECK, so it is a count plus
 * a refusal — and the refusal says which limit and what it is, because "cannot
 * add item" with no number is a dead end for whoever hits it.
 */

import {
  WATCHLIST_ITEM_PRICE_ALERT_SEAM,
  WATCHLIST_MAX_ITEMS_PER_LIST,
  WATCHLIST_MAX_LISTS_PER_OWNER,
  type CurrencyCode,
  type Watchlist,
  type WatchlistDetail,
  type WatchlistItem,
  type WatchlistItemResolution,
  type WatchlistTemplateKey,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  conflict,
  MercariaError,
  notFound,
  validationError,
} from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';
import {
  bumpWatchlistVersion,
  countWatchlistsForOwner,
  deleteWatchlist,
  findWatchlistForOwner,
  insertWatchlist,
  listWatchlistsForOwner,
  type WatchlistHeaderPatch,
  type WatchlistRow,
} from '../../db/watchlists/watchlistRepository.js';
import {
  countWatchlistItems,
  insertWatchlistItem,
  listWatchlistItemsForOwner,
  type WatchlistItemRow,
} from '../../db/watchlists/watchlistItemRepository.js';
import { WATCHLIST_TEMPLATES } from './templates.js';

/**
 * A stale-version refusal (#81 acceptance 4).
 *
 * Its own error code rather than a bare 409: "somebody else edited this list"
 * and "you asked for something contradictory" need different client behaviour —
 * the first is re-read, re-apply, retry — and message matching is not a
 * contract. The CURRENT version travels in the message so a human reading a log
 * can see the gap; a client re-reads rather than parsing it.
 */
export function watchlistVersionConflict(
  watchlistId: string,
  expectedVersion: number,
  currentVersion: number,
): MercariaError {
  return new MercariaError({
    code: ErrorCodes.WATCHLIST_VERSION_CONFLICT,
    message:
      `This list changed while you were editing it (you have version ${expectedVersion}, it is ` +
      `now version ${currentVersion}). Reload it and try again.`,
    httpStatus: 409,
  });
}

/** The projection of one list header. Names every field — no spread of a row. */
export function projectWatchlist(row: WatchlistRow, itemCount: number): Watchlist {
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.icon === null ? {} : { icon: row.icon }),
    visibility: row.visibility,
    displayCurrency: row.displayCurrency,
    ...(row.market === null ? {} : { market: row.market }),
    ...(row.templateKey === null ? {} : { templateKey: row.templateKey }),
    version: row.version,
    itemCount,
    ...(row.lastEvaluatedAt === null
      ? {}
      : { lastEvaluatedAt: row.lastEvaluatedAt.toISOString() }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * One item's split resolution, derived from the two stored columns.
 *
 * The target candidate is deliberately NOT resolved here: it lives on the split
 * job and the buyer's answer names it, so a projection that fetched it would put
 * a curation read on every list open for a state most items are never in.
 */
function projectResolution(row: WatchlistItemRow): WatchlistItemResolution {
  if (row.resolutionState !== 'ambiguous_after_split' || row.ambiguousSplitJobId === null) {
    return { state: 'resolved' };
  }
  return {
    state: 'ambiguous_after_split',
    splitJobId: row.ambiguousSplitJobId,
    sourceCanonicalProductId: row.canonicalProductId,
  };
}

/** The projection of one item. The ONE place a private note is emitted. */
export function projectWatchlistItem(row: WatchlistItemRow): WatchlistItem {
  return {
    id: row.id,
    canonicalProductId: row.canonicalProductId,
    ...(row.preferredCanonicalVariantId === null
      ? {}
      : { preferredCanonicalVariantId: row.preferredCanonicalVariantId }),
    ...(row.preferredConditionGroup === null
      ? {}
      : { preferredConditionGroup: row.preferredConditionGroup }),
    ...(row.preferredMerchantId === null ? {} : { preferredMerchantId: row.preferredMerchantId }),
    quantity: row.quantity,
    position: row.position,
    ...(row.targetAmount === null || row.targetCurrency === null
      ? {}
      : { target: { amount: row.targetAmount, currency: row.targetCurrency } }),
    ...(row.note === null ? {} : { note: row.note }),
    resolution: projectResolution(row),
    priceAlert: WATCHLIST_ITEM_PRICE_ALERT_SEAM,
    addedAt: row.addedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every list this account owns, with its item count. */
export async function listWatchlists(oxyUserId: string): Promise<readonly Watchlist[]> {
  const rows = await listWatchlistsForOwner(oxyUserId);
  return Promise.all(
    rows.map(async (row) => projectWatchlist(row, await countWatchlistItems(row.id))),
  );
}

/** The list a caller owns, or a 404 that says nothing about whether it exists. */
export async function requireOwnedWatchlist(
  oxyUserId: string,
  watchlistId: string,
): Promise<WatchlistRow> {
  const row = await findWatchlistForOwner(oxyUserId, watchlistId);
  // One indistinguishable answer for "no such list" and "not yours" (#92's rule,
  // and #81 privacy rule 1): a distinguishable response is an oracle that
  // confirms somebody else's list exists.
  if (!row) throw notFound('No such watchlist.');
  return row;
}

/** One list with its items, in order. Reads two tables and nothing else. */
export async function readWatchlist(
  oxyUserId: string,
  watchlistId: string,
): Promise<WatchlistDetail> {
  const row = await requireOwnedWatchlist(oxyUserId, watchlistId);
  const items = await listWatchlistItemsForOwner(watchlistId);
  return {
    watchlist: projectWatchlist(row, items.length),
    items: items.map(projectWatchlistItem),
  };
}

/** What a create accepts. */
export interface CreateWatchlistInput {
  readonly oxyUserId: string;
  readonly displayCurrency: CurrencyCode;
  readonly name?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly market?: string;
  readonly templateKey?: WatchlistTemplateKey;
}

/**
 * Create one list, optionally from a template.
 *
 * A template supplies DEFAULTS, so anything the caller stated wins: somebody who
 * names their PC build "Kid's first PC" gets that name and still gets the
 * template's icon. The template can never affect visibility, which has one
 * member.
 */
export async function createWatchlist(input: CreateWatchlistInput): Promise<Watchlist> {
  const existing = await countWatchlistsForOwner(input.oxyUserId);
  if (existing >= WATCHLIST_MAX_LISTS_PER_OWNER) {
    throw validationError(
      `You already have ${existing} watchlists, which is the maximum of ` +
        `${WATCHLIST_MAX_LISTS_PER_OWNER}. Delete one to create another.`,
    );
  }

  const template = input.templateKey ? WATCHLIST_TEMPLATES[input.templateKey] : undefined;
  const name = input.name ?? template?.name;
  if (name === undefined) {
    throw validationError('A watchlist needs a name, or a template to take one from.');
  }

  const row = await insertWatchlist({
    oxyUserId: input.oxyUserId,
    name,
    displayCurrency: input.displayCurrency,
    description: input.description ?? template?.description ?? null,
    icon: input.icon ?? template?.icon ?? null,
    market: input.market ?? null,
    templateKey: input.templateKey ?? null,
  });
  return projectWatchlist(row, 0);
}

/** Rename, re-describe, re-icon, or change the display currency or market. */
export async function updateWatchlist(
  oxyUserId: string,
  watchlistId: string,
  expectedVersion: number,
  patch: WatchlistHeaderPatch,
): Promise<Watchlist> {
  const current = await requireOwnedWatchlist(oxyUserId, watchlistId);
  const updated = await bumpWatchlistVersion(oxyUserId, watchlistId, expectedVersion, patch);
  if (!updated) throw watchlistVersionConflict(watchlistId, expectedVersion, current.version);
  return projectWatchlist(updated, await countWatchlistItems(watchlistId));
}

/** Remove a list. Its items and its recorded evaluations go with it. */
export async function removeWatchlist(
  oxyUserId: string,
  watchlistId: string,
  expectedVersion: number,
): Promise<{ removed: boolean }> {
  const current = await requireOwnedWatchlist(oxyUserId, watchlistId);
  const removed = await deleteWatchlist(oxyUserId, watchlistId, expectedVersion);
  if (!removed) throw watchlistVersionConflict(watchlistId, expectedVersion, current.version);
  return { removed: true };
}

/**
 * Duplicate a list (#81 UX rule 7).
 *
 * The copy carries the items, their quantities, their preferences, their targets
 * and their notes — everything the buyer put there — and NONE of the history:
 * snapshots are recorded evaluations of a specific list at specific moments, and
 * copying them would attribute one list's past to another that did not exist
 * then. `last_evaluated_at` is likewise not copied, for the same reason.
 *
 * An AMBIGUOUS item is copied as ambiguous, naming the same split job. The
 * alternative — resolving it silently in the copy — would answer a question on
 * the buyer's behalf at the one moment they were not being asked it.
 */
export async function duplicateWatchlist(
  oxyUserId: string,
  watchlistId: string,
  name: string | undefined,
): Promise<WatchlistDetail> {
  const source = await requireOwnedWatchlist(oxyUserId, watchlistId);
  const sourceItems = await listWatchlistItemsForOwner(watchlistId);

  const existing = await countWatchlistsForOwner(oxyUserId);
  if (existing >= WATCHLIST_MAX_LISTS_PER_OWNER) {
    throw validationError(
      `You already have ${existing} watchlists, which is the maximum of ` +
        `${WATCHLIST_MAX_LISTS_PER_OWNER}. Delete one to duplicate this list.`,
    );
  }

  return getDb().transaction(async (tx) => {
    const copy = await insertWatchlist(
      {
        oxyUserId,
        name: name ?? `${source.name} (copy)`,
        displayCurrency: source.displayCurrency,
        description: source.description,
        icon: source.icon,
        market: source.market,
        templateKey: source.templateKey,
      },
      tx,
    );

    const copied: WatchlistItemRow[] = [];
    for (const item of sourceItems) {
      const { item: inserted } = await insertWatchlistItem(
        {
          watchlistId: copy.id,
          canonicalProductId: item.canonicalProductId,
          quantity: item.quantity,
          position: item.position,
          preferredCanonicalVariantId: item.preferredCanonicalVariantId,
          preferredConditionGroup: item.preferredConditionGroup,
          preferredMerchantId: item.preferredMerchantId,
          targetAmount: item.targetAmount,
          targetCurrency: item.targetCurrency,
          note: item.note,
        },
        tx,
      );
      copied.push(inserted);
    }

    return {
      watchlist: projectWatchlist(copy, copied.length),
      items: copied.map(projectWatchlistItem),
    };
  });
}

/**
 * Refuse a list that is already full.
 *
 * Exported because both the add path and the split's `keep_both` answer create
 * an item, and a limit enforced in one of them is a limit somebody can walk
 * around by taking the other route.
 */
export async function assertWatchlistHasRoom(watchlistId: string): Promise<void> {
  const held = await countWatchlistItems(watchlistId);
  if (held >= WATCHLIST_MAX_ITEMS_PER_LIST) {
    throw conflict(
      `This watchlist already holds ${held} items, which is the maximum of ` +
        `${WATCHLIST_MAX_ITEMS_PER_LIST}. Remove one to add another.`,
    );
  }
}
