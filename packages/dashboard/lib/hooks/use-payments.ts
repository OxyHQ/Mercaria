import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SellerPaymentSettings } from '@mercaria/shared-types';
import {
  createOnboardingLink,
  fetchPaymentSettings,
  refreshPaymentSettings,
} from '../api/payments';
import { queryKeys } from '../queryKeys';

/** The store's payment standing, plus whether this deployment can onboard. */
export function usePaymentSettings(storeId: string) {
  return useQuery<SellerPaymentSettings>({
    queryKey: queryKeys.payments(storeId),
    queryFn: () => fetchPaymentSettings(storeId),
    enabled: Boolean(storeId),
  });
}

/**
 * Mint a hosted-onboarding link. Resolves with the URL; the caller opens it in
 * the SYSTEM browser and refreshes once the browser closes.
 *
 * Deliberately does NOT invalidate on its own: onboarding finishes out of band,
 * and readiness comes from a read of the account rather than from the browser
 * coming back.
 */
export function useCreateOnboardingLink(storeId: string) {
  return useMutation({
    mutationFn: (input: { country?: string }) => createOnboardingLink(storeId, input.country),
  });
}

/**
 * Ask Peable to re-read the account now and put the answer in the cache. Used
 * when the hosted browser closes — the read is the gateway's, so what renders
 * is what the acquirer reports, not what the browser implied.
 */
export function useRefreshPaymentSettings(storeId: string) {
  const queryClient = useQueryClient();
  return async () => {
    const settings = await refreshPaymentSettings(storeId);
    queryClient.setQueryData(queryKeys.payments(storeId), settings);
  };
}
