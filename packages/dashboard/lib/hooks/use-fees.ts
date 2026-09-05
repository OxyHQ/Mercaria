import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AcceptFeeScheduleInput,
  FeePreview,
  FeePreviewInput,
  StoreFeeScheduleView,
} from "@mercaria/shared-types";
import { acceptFeeSchedule, fetchFeeSchedule, previewFee } from "../api/fees";
import { queryKeys } from "../queryKeys";

/** The schedule applicable to this store right now, and whether it accepted it. */
export function useFeeSchedule(storeId: string) {
  return useQuery<StoreFeeScheduleView>({
    queryKey: queryKeys.feeSchedule(storeId),
    queryFn: () => fetchFeeSchedule(storeId),
    enabled: Boolean(storeId),
  });
}

/**
 * Record the owner's acceptance, then refetch.
 *
 * Invalidating here is right — unlike payout onboarding, which finishes out of
 * band at Stripe — because the acceptance IS the write: the row exists the
 * moment this resolves, and the refetch reads back the server's own record of
 * it rather than a state the client assumed.
 *
 * A stale screen resolves as a REJECTION (409 naming the current version), so
 * the caller refetches on failure too and shows the terms actually in force.
 */
export function useAcceptFeeSchedule(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AcceptFeeScheduleInput) => acceptFeeSchedule(storeId, input),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.feeSchedule(storeId) }),
  });
}

/**
 * Quote the fee on a hypothetical subtotal.
 *
 * A mutation rather than a query although it reads nothing: it is driven by a
 * button, its input is not a cache key anybody would revisit, and caching a
 * quote against a schedule that can be superseded underneath it would show a
 * merchant a figure Mercaria no longer charges.
 */
export function usePreviewFee(storeId: string) {
  return useMutation<FeePreview, Error, FeePreviewInput>({
    mutationFn: (input: FeePreviewInput) => previewFee(storeId, input),
  });
}
