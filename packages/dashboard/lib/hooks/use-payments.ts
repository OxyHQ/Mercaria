import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SellerPaymentSettings } from "@mercaria/shared-types";
import { createOnboardingLink, fetchPaymentSettings } from "../api/payments";
import { queryKeys } from "../queryKeys";

/** The store's payment standing, plus what this deployment can onboard. */
export function usePaymentSettings(storeId: string) {
  return useQuery<SellerPaymentSettings>({
    queryKey: queryKeys.payments(storeId),
    queryFn: () => fetchPaymentSettings(storeId),
    enabled: Boolean(storeId),
  });
}

/**
 * Mint a hosted-onboarding link. Resolves with the URL; the caller opens it in
 * the SYSTEM browser and refetches once the browser closes.
 *
 * Deliberately does NOT invalidate on its own — the same reasoning as
 * `useConnectChannel`. Onboarding finishes out of band, and readiness comes from
 * Stripe's `account.updated` webhook rather than from the browser coming back,
 * so invalidating here would refetch a state that has not changed yet and make
 * a stale render look authoritative.
 */
export function useCreateOnboardingLink(storeId: string) {
  return useMutation({
    mutationFn: (input: { country?: string }) => createOnboardingLink(storeId, input.country),
  });
}

/** Refetch the payment standing — used after the hosted browser closes. */
export function useRefreshPaymentSettings(storeId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.payments(storeId) });
}
