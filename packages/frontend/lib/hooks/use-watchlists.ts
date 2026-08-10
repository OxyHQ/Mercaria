import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Watchlist,
  WatchlistBasket,
  WatchlistDetail,
  WatchlistItemSplitResolution,
  WatchlistSnapshot,
} from '@mercaria/shared-types';
import { useOxy } from '@oxyhq/services';
import {
  addWatchlistItem,
  createWatchlist,
  deleteWatchlist,
  duplicateWatchlist,
  fetchWatchlist,
  fetchWatchlistBasket,
  fetchWatchlistSnapshots,
  fetchWatchlists,
  recordWatchlistSnapshot,
  removeWatchlistItem,
  reorderWatchlistItems,
  resolveWatchlistItemSplit,
  updateWatchlistItem,
  type AddWatchlistItemInput,
  type CreateWatchlistInput,
} from '../api/watchlists';
import { queryKeys } from './query-keys';

/**
 * Watchlists (#81) — the buyer's private lists and their basket.
 *
 * ## The list and the basket are two queries, and that is #81 acceptance 7
 *
 * `useWatchlist` reads the list; `useWatchlistBasket` prices it. They are
 * separate keys with separate error states, so a comparison that is down
 * renders a basket card saying so beside a list somebody can still edit — where
 * one combined query would put the whole screen into an error state and take
 * the editing with it.
 *
 * ## Every mutation adopts the version the SERVER returned
 *
 * A stale `expectedVersion` comes back as `WATCHLIST_VERSION_CONFLICT`, so each
 * mutation invalidates the list rather than patching a cached copy: after a
 * conflict the client's copy is wrong by definition, and re-reading is the only
 * thing that can make the next edit succeed.
 *
 * ## Everything is gated on `canUsePrivateApi`, not on `isAuthenticated`
 *
 * The device-first cold boot can take seconds to restore a session and every
 * call here is user-delegated, so until it settles there is no session to make
 * the request under — the gate `useSavedItems` and the cart hooks use.
 */

/** Ten seconds — a personal surface that re-reads cheaply. */
const STALE_TIME = 1000 * 10;

/**
 * A basket is expensive to compute (one offer comparison per item), so it is
 * held longer than the list it belongs to. It is still re-fetched on demand:
 * the button that records a snapshot invalidates it.
 */
const BASKET_STALE_TIME = 1000 * 60;

export function useWatchlists() {
  const { canUsePrivateApi } = useOxy();

  return useQuery<readonly Watchlist[]>({
    queryKey: queryKeys.watchlists.all,
    enabled: canUsePrivateApi,
    staleTime: STALE_TIME,
    queryFn: fetchWatchlists,
  });
}

export function useWatchlist(watchlistId: string | undefined) {
  const { canUsePrivateApi } = useOxy();

  return useQuery<WatchlistDetail>({
    queryKey: queryKeys.watchlists.detail(watchlistId ?? ''),
    enabled: canUsePrivateApi && Boolean(watchlistId),
    staleTime: STALE_TIME,
    queryFn: () => fetchWatchlist(watchlistId ?? ''),
  });
}

/**
 * The evaluated basket.
 *
 * `retry: false` is deliberate: a per-item failure already comes back INSIDE
 * the basket as that item's reason, so a request-level error means something
 * broader, and retrying it three times only delays the honest empty state.
 */
export function useWatchlistBasket(watchlistId: string | undefined) {
  const { canUsePrivateApi } = useOxy();

  return useQuery<WatchlistBasket>({
    queryKey: queryKeys.watchlists.basket(watchlistId ?? ''),
    enabled: canUsePrivateApi && Boolean(watchlistId),
    staleTime: BASKET_STALE_TIME,
    retry: false,
    queryFn: () => fetchWatchlistBasket(watchlistId ?? ''),
  });
}

export function useWatchlistSnapshots(watchlistId: string | undefined) {
  const { canUsePrivateApi } = useOxy();

  return useQuery<readonly WatchlistSnapshot[]>({
    queryKey: queryKeys.watchlists.snapshots(watchlistId ?? ''),
    enabled: canUsePrivateApi && Boolean(watchlistId),
    staleTime: STALE_TIME,
    queryFn: () => fetchWatchlistSnapshots(watchlistId ?? ''),
  });
}

export function useCreateWatchlist() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateWatchlistInput) => createWatchlist(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.watchlists.all });
    },
  });
}

export function useDeleteWatchlist() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { watchlistId: string; expectedVersion: number }) =>
      deleteWatchlist(input.watchlistId, input.expectedVersion),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.watchlists.all });
    },
  });
}

export function useDuplicateWatchlist() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { watchlistId: string; name?: string }) =>
      duplicateWatchlist(input.watchlistId, input.name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.watchlists.all });
    },
  });
}

/** Invalidate one list, its basket and its history — every write changes all three. */
function invalidateWatchlist(
  queryClient: ReturnType<typeof useQueryClient>,
  watchlistId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.watchlists.detail(watchlistId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.watchlists.basket(watchlistId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.watchlists.all });
}

export function useAddWatchlistItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { watchlistId: string } & AddWatchlistItemInput) => {
      const { watchlistId, ...body } = input;
      return addWatchlistItem(watchlistId, body);
    },
    onSuccess: (_result, input) => invalidateWatchlist(queryClient, input.watchlistId),
  });
}

export function useUpdateWatchlistItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      watchlistId: string;
      itemId: string;
      expectedVersion: number;
      quantity?: number;
      note?: string | null;
      targetAmount?: number | null;
      targetCurrency?: import('@mercaria/shared-types').CurrencyCode | null;
    }) => {
      const { watchlistId, itemId, ...body } = input;
      return updateWatchlistItem(watchlistId, itemId, body);
    },
    onSuccess: (_result, input) => invalidateWatchlist(queryClient, input.watchlistId),
  });
}

export function useRemoveWatchlistItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { watchlistId: string; itemId: string; expectedVersion: number }) =>
      removeWatchlistItem(input.watchlistId, input.itemId, input.expectedVersion),
    onSuccess: (_result, input) => invalidateWatchlist(queryClient, input.watchlistId),
  });
}

export function useReorderWatchlistItems() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      watchlistId: string;
      expectedVersion: number;
      itemIds: readonly string[];
    }) => reorderWatchlistItems(input.watchlistId, input.expectedVersion, input.itemIds),
    onSuccess: (_result, input) => invalidateWatchlist(queryClient, input.watchlistId),
  });
}

export function useResolveWatchlistSplit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      watchlistId: string;
      itemId: string;
      expectedVersion: number;
      resolution: WatchlistItemSplitResolution;
    }) =>
      resolveWatchlistItemSplit(
        input.watchlistId,
        input.itemId,
        input.expectedVersion,
        input.resolution,
      ),
    onSuccess: (_result, input) => invalidateWatchlist(queryClient, input.watchlistId),
  });
}

/** Record the current evaluation. A dedupe is a success and says so. */
export function useRecordWatchlistSnapshot() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { watchlistId: string }) => recordWatchlistSnapshot(input.watchlistId),
    onSuccess: (_result, input) => {
      invalidateWatchlist(queryClient, input.watchlistId);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.watchlists.snapshots(input.watchlistId),
      });
    },
  });
}
