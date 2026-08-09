import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConditionGroup,
  ListingSaveContext,
  ProductSaveSourceContext,
  ProductSaveSplitResolution,
  SavedItemsPage,
} from '@mercaria/shared-types';
import { useOxy } from '@oxyhq/services';
import {
  fetchListingSaveContext,
  fetchSavedItems,
  resolveSplitAmbiguity,
  saveListing,
  saveProduct,
  unsaveListing,
  unsaveProduct,
  updateProductSave,
} from '../api/saves';
import { queryKeys } from './query-keys';

/**
 * Saves (#80) — the buyer's canonical product saves and exact listing saves.
 *
 * ## Everything is gated on `canUsePrivateApi`, not on `isAuthenticated`
 *
 * The device-first cold boot can take seconds to restore a session, and every
 * call here is user-delegated. Until it settles there is no session to make the
 * request under, so the hooks render nothing rather than firing a call that
 * would 401 — the same gate `useSellerFollowTarget` and the cart hooks use.
 *
 * ## Invalidation reaches the LIST, not one entry
 *
 * A save, an un-save and a split resolution all change what the merged saved
 * list contains, and in `on` read mode a product save also changes whether a
 * LISTING save is still shown (it becomes represented). One prefix key covers
 * every page of that list, so each mutation invalidates it whole rather than
 * trying to patch a page it may not be holding.
 */

/** Ten seconds — a saved list is a personal surface and re-reads cheaply. */
const STALE_TIME = 1000 * 10;

/** The merged saved list, keyset-paginated (#80 API rules 3, 4 and 7). */
export function useSavedItems(limit = 20) {
  const { canUsePrivateApi } = useOxy();

  return useInfiniteQuery<SavedItemsPage>({
    queryKey: queryKeys.saves.savedItems,
    enabled: canUsePrivateApi,
    staleTime: STALE_TIME,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchSavedItems({ limit, ...(pageParam ? { cursor: pageParam as string } : {}) }),
    // The server decides when there is more, by returning a cursor. A client
    // that inferred it from `items.length === limit` would ask for one page too
    // many on every list whose size is a multiple of the page size.
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/**
 * The two-button context of one listing page.
 *
 * A QUERY rather than something derived from the listing DTO: the canonical
 * mapping is not a field of a listing, and putting one there would make every
 * consumer of a listing reason about the canonical graph.
 */
export function useListingSaveContext(listingId: string | undefined) {
  const { canUsePrivateApi } = useOxy();

  return useQuery<ListingSaveContext>({
    queryKey: queryKeys.saves.listingContext(listingId ?? ''),
    enabled: canUsePrivateApi && Boolean(listingId),
    staleTime: STALE_TIME,
    queryFn: () => fetchListingSaveContext(listingId ?? ''),
  });
}

export interface ToggleProductSaveInput {
  canonicalProductId: string;
  saved: boolean;
  sourceContext: ProductSaveSourceContext;
  listingId?: string;
}

/**
 * Save or un-save a canonical product.
 *
 * The mutation takes the CURRENT state and sends the opposite, rather than
 * toggling server-side: a retry of a toggle flips twice, while a retry of "make
 * it saved" converges — which is what #80 acceptance 5 asks for on a flaky
 * connection, and why the API has explicit POST and DELETE rather than one
 * toggle route.
 */
export function useToggleProductSave() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ToggleProductSaveInput) => {
      if (input.saved) {
        await unsaveProduct(input.canonicalProductId);
        return;
      }
      await saveProduct({
        canonicalProductId: input.canonicalProductId,
        sourceContext: input.sourceContext,
      });
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.saves.savedItems });
      if (input.listingId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.saves.listingContext(input.listingId),
        });
      }
    },
  });
}

export interface ToggleListingSaveInput {
  listingId: string;
  saved: boolean;
  /** `listing_pin` when the buyer chose the exact listing over the product. */
  pin?: boolean;
}

/** Save or un-save an exact listing. */
export function useToggleListingSave() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ToggleListingSaveInput) => {
      if (input.saved) {
        await unsaveListing(input.listingId);
        return;
      }
      await saveListing(input.listingId, input.pin ? 'listing_pin' : undefined);
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.saves.savedItems });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.saves.listingContext(input.listingId),
      });
    },
  });
}

/** Change a saved product's preferred configuration, condition segment or seller. */
export function useUpdateProductSave() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      canonicalProductId: string;
      preferredCanonicalVariantId?: string | null;
      preferredConditionGroup?: ConditionGroup | null;
      preferredMerchantId?: string | null;
    }) => {
      const { canonicalProductId, ...preferences } = input;
      return updateProductSave(canonicalProductId, preferences);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.saves.savedItems });
    },
  });
}

/** Answer a split ambiguity (#80 migration rule 8). */
export function useResolveSplitAmbiguity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { saveId: string; resolution: ProductSaveSplitResolution }) =>
      resolveSplitAmbiguity(input.saveId, input.resolution),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.saves.savedItems });
    },
  });
}
