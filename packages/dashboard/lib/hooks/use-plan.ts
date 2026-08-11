import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MerchantPlanCatalogEntry, MerchantPlanStatusView } from "@mercaria/shared-types";
import { cancelPlan, fetchPlanCatalog, fetchPlanStatus, openBillingPortal, startPlanCheckout } from "../api/plan";
import { queryKeys } from "../queryKeys";

/** This store's plan, effective entitlements and usage. */
export function usePlanStatus(storeId: string) {
  return useQuery<MerchantPlanStatusView>({
    queryKey: queryKeys.plan(storeId),
    queryFn: () => fetchPlanStatus(storeId),
    enabled: Boolean(storeId),
  });
}

/** The plan comparison, with exact current capabilities. */
export function usePlanCatalog(storeId: string) {
  return useQuery<MerchantPlanCatalogEntry[]>({
    queryKey: queryKeys.planCatalog(storeId),
    queryFn: () => fetchPlanCatalog(storeId),
    enabled: Boolean(storeId),
  });
}

/**
 * Start a paid plan. Resolves with a hosted URL; the caller opens it in the
 * SYSTEM browser.
 *
 * Deliberately does NOT invalidate on its own, exactly like
 * `useCreateOnboardingLink`: the subscription is created from a provider event,
 * not from the browser coming back, so invalidating here would refetch a state
 * that has not changed yet and make a stale render look authoritative.
 */
export function useStartPlanCheckout(storeId: string) {
  return useMutation({
    mutationFn: (input: { planId: string; interval: "monthly" | "annual"; currency: string }) =>
      startPlanCheckout(storeId, input),
  });
}

/** Open the hosted billing portal — invoices, payment method, cancellation. */
export function useOpenBillingPortal(storeId: string) {
  return useMutation({ mutationFn: () => openBillingPortal(storeId) });
}

/**
 * Cancel at the end of the paid period.
 *
 * This one DOES invalidate: the rail is asked synchronously and Mercaria applies
 * what it answers, so the response already carries the new state rather than a
 * prediction of one.
 */
export function useCancelPlan(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => cancelPlan(storeId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.plan(storeId) }),
  });
}

/** Refetch the plan — used after the hosted browser closes. */
export function useRefreshPlan(storeId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.plan(storeId) });
}
