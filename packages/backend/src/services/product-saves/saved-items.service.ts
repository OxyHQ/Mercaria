/**
 * The merged saved-items list — product saves and listing saves in ONE
 * keyset-paginated stream (#80 API rules 3, 4 and 7, acceptance 8).
 *
 * ## One list, one cursor
 *
 * The two kinds live in two tables, and a response with two cursors is not a
 * paginated list — a client cannot interleave them by time without holding both
 * and re-sorting, which breaks the moment a page boundary falls between two
 * items saved a second apart. Both tables are therefore read with the SAME
 * ordering, `(created_at desc, id desc)`, and merged here: taking the top `n`
 * of each and merging yields exactly the top `n` of the union, and the cursor
 * is the `(created_at, id)` of the last item emitted. Ids are uuid v7 and are
 * used purely as a TIEBREAKER — uuid v7 is not monotonic within a millisecond
 * (`~/Oxy/AGENTS.md`), so nothing here reads id order as creation order.
 *
 * ## The read mode is the rollback, and `on` still returns listing saves
 *
 * - `off` — listing saves only. Exactly what a deployment served before #80,
 *   whatever product saves exist. This is the lever an incident pulls.
 * - `dual` — both, so the two can be compared under real traffic.
 * - `on` — product saves, plus the listing saves NO product save represents,
 *   plus every explicit PIN.
 *
 * That last clause is #80 acceptance 3 ("unmatched P2P favorites continue to
 * work") surviving the deploy that finishes the rollout. Representation is
 * DERIVED at read time from the migration record joined back to a save that
 * still exists — never stored — so a buyer who un-saves the product sees the
 * listing reappear in the statement that removed it, rather than losing both.
 */

import type {
  ListingSaveIntent,
  SavedItem,
  SavedItemsPage,
  SavedItemsReadMode,
  SavedListingEntry,
  SavedProductEntry,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { findFavoritePage, type FavoriteRecord } from '../../db/buyers/favoriteRepository.js';
import { findListingsByIds } from '../../db/catalog/listingRepository.js';
import {
  findProductSavePage,
  type ProductSaveRow,
} from '../../db/productSaves/productSaveRepository.js';
import { findRepresentedFavoriteIds } from '../../db/productSaves/productSaveSourceRepository.js';
import { hydrateListings } from '../catalog-hydration.service.js';
import { validationError } from '../../lib/errors/error-codes.js';
import { PRODUCT_SAVE_MIGRATION_VERSION } from './mapping-version.js';
import { projectSavedProducts } from './saved-product-view.js';

/** The `(created_at, id)` pair a page resumes from. */
interface SavedCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * `<epoch millis>:<id>` — opaque to the client and deliberately not base64.
 *
 * The `listOffers` cursor's reasoning: an encoding that only LOOKS opaque
 * invites somebody to decode and hand-craft one, and every part is validated
 * here anyway. Milliseconds rather than an ISO string so the separator can be a
 * character no id contains.
 */
function encodeCursor(item: { createdAt: Date; id: string }): string {
  return `${item.createdAt.getTime()}:${item.id}`;
}

function decodeCursor(cursor: string): SavedCursor {
  const separator = cursor.indexOf(':');
  if (separator < 0) throw validationError('Malformed cursor');
  const millis = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (!Number.isInteger(millis) || id === '') throw validationError('Malformed cursor');
  return { createdAt: new Date(millis), id };
}

/** Newest first, `id` descending as the tiebreaker. Both halves, always. */
function newerFirst(
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
): number {
  const byTime = right.createdAt.getTime() - left.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
}

/** Which kinds this deployment's read mode admits. */
function kindsForMode(mode: SavedItemsReadMode): { products: boolean; listings: boolean } {
  switch (mode) {
    case 'off':
      return { products: false, listings: true };
    case 'dual':
      return { products: true, listings: true };
    case 'on':
      return { products: true, listings: true };
  }
}

export interface SavedItemsQuery {
  readonly oxyUserId: string;
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * One page of a buyer's saved items.
 *
 * `limit + 1` is fetched from each side so the merge always has enough to fill
 * the page AND to know whether there is more — and, in `on` mode, enough to
 * survive listing saves being dropped as represented. The extra rows are
 * discarded; their existence is what produces the cursor.
 */
export async function listSavedItems(query: SavedItemsQuery): Promise<SavedItemsPage> {
  const mode = config.productSaves.readMode;
  const kinds = kindsForMode(mode);
  const after = query.cursor ? decodeCursor(query.cursor) : undefined;
  const db = getDb();
  const scan = query.limit + 1;

  const [saveRows, favoriteRows] = await Promise.all([
    kinds.products ? findProductSavePage(query.oxyUserId, scan, after, db) : Promise.resolve([]),
    kinds.listings ? findFavoritePage(query.oxyUserId, scan, after, db) : Promise.resolve([]),
  ]);

  const visibleFavorites = mode === 'on' ? await dropRepresented(favoriteRows) : favoriteRows;

  const [productEntries, listingEntries] = await Promise.all([
    projectSavedProducts(saveRows),
    projectSavedListings(visibleFavorites, mode),
  ]);

  const merged = mergeByRecency(saveRows, visibleFavorites, productEntries, listingEntries);
  const page = merged.slice(0, query.limit);
  const last = merged[query.limit - 1];

  return {
    readMode: mode,
    items: page.map((entry) => entry.item),
    ...(merged.length > query.limit && last ? { nextCursor: encodeCursor(last) } : {}),
  };
}

/**
 * In `on` mode, drop the listing saves a product save already stands for.
 *
 * A PIN is never dropped, whatever the migration recorded: the buyer said they
 * meant this exact listing, and hiding it behind the model is the one thing #80
 * listing rule 4 exists to prevent.
 */
async function dropRepresented(favorites: readonly FavoriteRecord[]): Promise<FavoriteRecord[]> {
  const candidates = favorites.filter((row) => row.saveIntent !== 'listing_pin');
  if (candidates.length === 0) return [...favorites];
  const represented = await findRepresentedFavoriteIds(
    candidates.map((row) => row.id),
    PRODUCT_SAVE_MIGRATION_VERSION,
  );
  return favorites.filter((row) => !represented.has(row.id));
}

/** One sortable record per emitted entry, so the merge sorts once. */
interface MergedEntry {
  readonly createdAt: Date;
  readonly id: string;
  readonly item: SavedItem;
}

function mergeByRecency(
  saveRows: readonly ProductSaveRow[],
  favoriteRows: readonly FavoriteRecord[],
  productEntries: ReadonlyMap<string, SavedProductEntry>,
  listingEntries: ReadonlyMap<string, SavedListingEntry>,
): MergedEntry[] {
  const entries: MergedEntry[] = [];
  for (const row of saveRows) {
    const item = productEntries.get(row.id);
    // A save whose canonical product has been merged away is skipped, and that
    // is exactly safe rather than lossy: the merge's `repoint_if_absent`
    // disposition leaves a save on a tombstone ONLY when the same buyer already
    // has one on the winner, so the twin is in this very page.
    if (item) entries.push({ createdAt: row.createdAt, id: row.id, item });
  }
  for (const row of favoriteRows) {
    const item = listingEntries.get(row.id);
    if (item) entries.push({ createdAt: row.createdAt, id: row.id, item });
  }
  return entries.sort(newerFirst);
}

/**
 * Listing saves → DTOs, through the SAME hydration path `/favorites` uses.
 *
 * `hydrateListings` is the catalogue's one projection of a listing, so a saved
 * item and a search result cannot disagree about a price or an image. A listing
 * the favorite points at that no longer exists is skipped — unreachable, since
 * `favorites.listing_id` cascades, and handled rather than asserted because a
 * saved list must not 500 on one missing row.
 */
async function projectSavedListings(
  favorites: readonly FavoriteRecord[],
  mode: SavedItemsReadMode,
): Promise<Map<string, SavedListingEntry>> {
  if (favorites.length === 0) return new Map();

  const listingIds = favorites.map((row) => row.listingId);
  const rows = await findListingsByIds(listingIds);
  const listings = await hydrateListings(rows);
  const byId = new Map(listings.map((listing) => [listing.id, listing]));

  // In `dual` mode both kinds are shown, so a listing the migration covered has
  // to SAY so — that is the whole point of the comparison window, and a buyer
  // seeing the same thing twice with no explanation is the bug it would
  // otherwise surface as. In `off` mode nothing is represented, by definition.
  const represented =
    mode === 'dual'
      ? await findRepresentedFavoriteIds(
          favorites.map((row) => row.id),
          PRODUCT_SAVE_MIGRATION_VERSION,
        )
      : new Set<string>();

  const entries = new Map<string, SavedListingEntry>();
  for (const favorite of favorites) {
    const listing = byId.get(favorite.listingId);
    if (!listing) continue;
    const intent: ListingSaveIntent = favorite.saveIntent;
    entries.set(favorite.id, {
      kind: 'listing',
      favoriteId: favorite.id,
      listingId: favorite.listingId,
      intent,
      title: listing.title,
      price: listing.price,
      ...(listing.images[0]?.fileId ? { imageFileId: listing.images[0].fileId } : {}),
      available: listing.status === 'active',
      representedByProductSave: represented.has(favorite.id),
      savedAt: favorite.createdAt.toISOString(),
    });
  }
  return entries;
}
