import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import type { SellerPaymentSettings } from '@mercaria/shared-types';
import {
  createSellerOnboardingLink,
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
