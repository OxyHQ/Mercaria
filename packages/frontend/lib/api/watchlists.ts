import type {
  ApiResponse,
  ConditionGroup,
  CurrencyCode,
  Watchlist,
  WatchlistBasket,
  WatchlistDetail,
  WatchlistItem,
  WatchlistItemSplitResolution,
  WatchlistSnapshot,
  WatchlistSnapshotDetail,
  WatchlistSnapshotDiff,
  WatchlistSnapshotWriteResult,
  WatchlistTemplate,
  WatchlistTemplateKey,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Watchlists API client (#81).
 *
 * ## Every write carries the version the client HAS
 *
 * `expectedVersion` is what this client last read, never what it wants the list
 * to become: the server advances the version itself, and a mismatch comes back
 * as `WATCHLIST_VERSION_CONFLICT` rather than being applied over somebody
 * else's edit. Each mutation returns the version it produced, so the caller
 * updates its copy from the RESPONSE instead of guessing `version + 1`.
 *
 * ## The basket is a separate call from the list, deliberately
 *
 * `fetchWatchlist` reads the list and its items and never prices anything, so a
 * failing comparison cannot stop somebody opening or editing their list (#81
 * acceptance 7). `fetchWatchlistBasket` is the one that costs money to compute,
 * and its per-item failures come back as reasons on the items rather than as an
 * error on the request.
 */

/**
 * Unwrap the Mercaria envelope, or throw with whatever the server said.
 *
 * Throwing is what React Query turns into an error state; returning a
 * half-built object would render an empty list that looks like "you have no
 * watchlists" — which is exactly the silent-emptying failure #81 is about.
 */
function unwrap<T>(body: ApiResponse<T>, fallback: string): T {
  if (!body.success || body.data === undefined) {
    throw new Error(body.error ?? body.message ?? fallback);
  }
  return body.data;
}

/** Every list this account owns. */
export async function fetchWatchlists(): Promise<readonly Watchlist[]> {
  const { data } = await apiClient.get<ApiResponse<{ watchlists: Watchlist[] }>>('/watchlists');
  return unwrap(data, 'Failed to load your watchlists').watchlists;
}

/** The starting shapes a create screen may offer (#81 UX rule 8). */
export async function fetchWatchlistTemplates(): Promise<readonly WatchlistTemplate[]> {
  const { data } =
    await apiClient.get<ApiResponse<{ templates: WatchlistTemplate[] }>>('/watchlists/templates');
  return unwrap(data, 'Failed to load the templates').templates;
}

/** One list and its items, in order. Prices nothing. */
export async function fetchWatchlist(watchlistId: string): Promise<WatchlistDetail> {
  const { data } = await apiClient.get<ApiResponse<WatchlistDetail>>(`/watchlists/${watchlistId}`);
  return unwrap(data, 'Failed to load that watchlist');
}

/** Evaluate one list. Records nothing — see the module docblock. */
export async function fetchWatchlistBasket(watchlistId: string): Promise<WatchlistBasket> {
  const { data } = await apiClient.get<ApiResponse<{ basket: WatchlistBasket }>>(
    `/watchlists/${watchlistId}/basket`,
  );
  return unwrap(data, 'Failed to price that watchlist').basket;
}

export interface CreateWatchlistInput {
  name?: string;
  displayCurrency: CurrencyCode;
  description?: string;
  icon?: string;
  market?: string;
  templateKey?: WatchlistTemplateKey;
}

export async function createWatchlist(input: CreateWatchlistInput): Promise<Watchlist> {
  const { data } = await apiClient.post<ApiResponse<{ watchlist: Watchlist }>>(
    '/watchlists',
    input,
  );
  return unwrap(data, 'Failed to create that watchlist').watchlist;
}

export async function renameWatchlist(
  watchlistId: string,
  expectedVersion: number,
  patch: { name?: string; description?: string | null; icon?: string | null },
): Promise<Watchlist> {
  const { data } = await apiClient.patch<ApiResponse<{ watchlist: Watchlist }>>(
    `/watchlists/${watchlistId}`,
    { expectedVersion, ...patch },
  );
  return unwrap(data, 'Failed to update that watchlist').watchlist;
}

export async function deleteWatchlist(
  watchlistId: string,
  expectedVersion: number,
): Promise<void> {
  const { data } = await apiClient.delete<ApiResponse<{ removed: boolean }>>(
    `/watchlists/${watchlistId}`,
    { data: { expectedVersion } },
  );
  unwrap(data, 'Failed to delete that watchlist');
}

/** Copy a list, with its items, quantities, preferences and notes (#81 UX rule 7). */
export async function duplicateWatchlist(
  watchlistId: string,
  name?: string,
): Promise<WatchlistDetail> {
  const { data } = await apiClient.post<ApiResponse<WatchlistDetail>>(
    `/watchlists/${watchlistId}/duplicate`,
    name === undefined ? {} : { name },
  );
  return unwrap(data, 'Failed to duplicate that watchlist');
}

export interface AddWatchlistItemInput {
  expectedVersion: number;
  canonicalProductId: string;
  quantity?: number;
  preferredCanonicalVariantId?: string;
  preferredConditionGroup?: ConditionGroup;
  preferredMerchantId?: string;
  targetAmount?: number;
  targetCurrency?: CurrencyCode;
  note?: string;
}

export async function addWatchlistItem(
  watchlistId: string,
  input: AddWatchlistItemInput,
): Promise<{ item: WatchlistItem; created: boolean; version: number }> {
  const { data } = await apiClient.post<
    ApiResponse<{ item: WatchlistItem; created: boolean; version: number }>
  >(`/watchlists/${watchlistId}/items`, input);
  return unwrap(data, 'Failed to add that item');
}

export async function updateWatchlistItem(
  watchlistId: string,
  itemId: string,
  input: {
    expectedVersion: number;
    quantity?: number;
    preferredCanonicalVariantId?: string | null;
    preferredConditionGroup?: ConditionGroup | null;
    preferredMerchantId?: string | null;
    targetAmount?: number | null;
    targetCurrency?: CurrencyCode | null;
    note?: string | null;
  },
): Promise<{ item: WatchlistItem; version: number }> {
  const { data } = await apiClient.patch<ApiResponse<{ item: WatchlistItem; version: number }>>(
    `/watchlists/${watchlistId}/items/${itemId}`,
    input,
  );
  return unwrap(data, 'Failed to update that item');
}

export async function removeWatchlistItem(
  watchlistId: string,
  itemId: string,
  expectedVersion: number,
): Promise<{ removed: boolean; version: number }> {
  const { data } = await apiClient.delete<ApiResponse<{ removed: boolean; version: number }>>(
    `/watchlists/${watchlistId}/items/${itemId}`,
    { data: { expectedVersion } },
  );
  return unwrap(data, 'Failed to remove that item');
}

/**
 * Reorder — the COMPLETE membership, in the order it should have.
 *
 * A partial list is refused by the server: "these three go first" is ambiguous
 * the moment two of the rest share a position, and the ambiguity is invisible.
 */
export async function reorderWatchlistItems(
  watchlistId: string,
  expectedVersion: number,
  itemIds: readonly string[],
): Promise<{ items: WatchlistItem[]; version: number }> {
  const { data } = await apiClient.put<ApiResponse<{ items: WatchlistItem[]; version: number }>>(
    `/watchlists/${watchlistId}/items/order`,
    { expectedVersion, itemIds },
  );
  return unwrap(data, 'Failed to reorder that watchlist');
}

/** Answer a split ambiguity for one entry (#81 correction rule 2). */
export async function resolveWatchlistItemSplit(
  watchlistId: string,
  itemId: string,
  expectedVersion: number,
  resolution: WatchlistItemSplitResolution,
): Promise<{ items: WatchlistItem[]; version: number }> {
  const { data } = await apiClient.post<ApiResponse<{ items: WatchlistItem[]; version: number }>>(
    `/watchlists/${watchlistId}/items/${itemId}/resolve-split`,
    { expectedVersion, resolution },
  );
  return unwrap(data, 'Failed to resolve that item');
}

/** Record one evaluation. An unchanged one is DEDUPLICATED, which is a success. */
export async function recordWatchlistSnapshot(
  watchlistId: string,
): Promise<WatchlistSnapshotWriteResult> {
  const { data } = await apiClient.post<ApiResponse<WatchlistSnapshotWriteResult>>(
    `/watchlists/${watchlistId}/snapshots`,
    {},
  );
  return unwrap(data, 'Failed to save that measurement');
}

export async function fetchWatchlistSnapshots(
  watchlistId: string,
): Promise<readonly WatchlistSnapshot[]> {
  const { data } = await apiClient.get<ApiResponse<{ snapshots: WatchlistSnapshot[] }>>(
    `/watchlists/${watchlistId}/snapshots`,
  );
  return unwrap(data, 'Failed to load that history').snapshots;
}

export async function fetchWatchlistSnapshot(
  watchlistId: string,
  snapshotId: string,
): Promise<WatchlistSnapshotDetail> {
  const { data } = await apiClient.get<ApiResponse<WatchlistSnapshotDetail>>(
    `/watchlists/${watchlistId}/snapshots/${snapshotId}`,
  );
  return unwrap(data, 'Failed to load that measurement');
}

/** Which items drove the change since this snapshot's own predecessor. */
export async function fetchWatchlistSnapshotDiff(
  watchlistId: string,
  snapshotId: string,
): Promise<WatchlistSnapshotDiff> {
  const { data } = await apiClient.get<ApiResponse<{ diff: WatchlistSnapshotDiff }>>(
    `/watchlists/${watchlistId}/snapshots/${snapshotId}/diff`,
  );
  return unwrap(data, 'Failed to explain that change').diff;
}
