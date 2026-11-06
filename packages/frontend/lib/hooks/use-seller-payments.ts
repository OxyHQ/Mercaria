import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import type {
  AcceptFeeScheduleInput,
  SellerFeeScheduleView,
  SellerPaymentSettings,
} from '@mercaria/shared-types';
import {
  acceptSellerFeeSchedule,
  createSellerOnboardingLink,
  fetchSellerFeeSchedule,
  fetchSellerPaymentSettings,
  refreshSellerPaymentSettings,
} from '../api/seller-payments';
import { queryKeys } from './query-keys';

/** The signed-in seller's payment standing. Gated on auth. */
export function useSellerPaymentSettings() {
  const { isAuthenticated } = useOxy();
  return useQuery<SellerPaymentSettings>({
    queryKey: queryKeys.sellerPayments.all,
    queryFn: fetchSellerPaymentSettings,
    enabled: isAuthenticated,
  });
}

/**
 * Mint a hosted-onboarding link. Deliberately does NOT invalidate: onboarding
 * finishes out of band, and readiness comes from a read of the account rather
 * than from the browser coming back.
 */
export function useCreateSellerOnboardingLink() {
  return useMutation({
    mutationFn: (input: { country?: string }) => createSellerOnboardingLink(input.country),
  });
}

/** Ask Peable to re-read the account and put its answer in the cache. */
export function useRefreshSellerPaymentSettings() {
  const queryClient = useQueryClient();
  return async () => {
    const settings = await refreshSellerPaymentSettings();
    queryClient.setQueryData(queryKeys.sellerPayments.all, settings);
  };
}

/** The marketplace fee the seller's card sales are charged under, and their acceptance. */
export function useSellerFeeSchedule() {
  const { isAuthenticated } = useOxy();
  return useQuery<SellerFeeScheduleView>({
    queryKey: queryKeys.sellerPayments.feeSchedule,
    queryFn: fetchSellerFeeSchedule,
    enabled: isAuthenticated,
  });
}

/**
 * Accept the fee terms. Invalidates on SETTLE, not only on success: a conflict
 * means the schedule moved, and the seller must read the current terms before
 * pressing again.
 */
export function useAcceptSellerFeeSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AcceptFeeScheduleInput) => acceptSellerFeeSchedule(input),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.sellerPayments.feeSchedule }),
  });
}
