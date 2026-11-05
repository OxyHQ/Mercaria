import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ReplenishmentPlan,
  ReplenishmentSettingValues,
  ReplenishmentSettingsView,
  UpsertReplenishmentOverrideInput,
} from '@mercaria/shared-types';
import {
  deleteReplenishmentOverride,
  fetchReplenishmentPlan,
  fetchReplenishmentSettings,
  saveReplenishmentOverride,
  saveReplenishmentSettings,
  type ReplenishmentPlanFilters,
} from '../api/replenishment';
import { queryKeys } from '../queryKeys';

/** The store's saved planning settings and overrides. */
export function useReplenishmentSettings(storeId: string) {
  return useQuery<ReplenishmentSettingsView>({
    queryKey: queryKeys.replenishment.settings(storeId),
    queryFn: () => fetchReplenishmentSettings(storeId),
    enabled: Boolean(storeId),
  });
}

/** The prioritised plan for one location (or all) and one status (or all). */
export function useReplenishmentPlan(storeId: string, filters: ReplenishmentPlanFilters) {
  return useQuery<ReplenishmentPlan>({
    queryKey: queryKeys.replenishment.plan(storeId, filters.locationId, filters.status),
    queryFn: () => fetchReplenishmentPlan(storeId, filters),
    enabled: Boolean(storeId),
    placeholderData: (previous) => previous,
  });
}

/** Every settings write refreshes the settings AND every plan computed with them. */
function useInvalidateReplenishment(storeId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.replenishment.all(storeId) });
}

export function useSaveReplenishmentSettings(storeId: string) {
  const invalidate = useInvalidateReplenishment(storeId);
  return useMutation({
    mutationFn: (values: ReplenishmentSettingValues) => saveReplenishmentSettings(storeId, values),
    onSuccess: invalidate,
  });
}

export function useSaveReplenishmentOverride(storeId: string) {
  const invalidate = useInvalidateReplenishment(storeId);
  return useMutation({
    mutationFn: (input: { variantId: string; values: UpsertReplenishmentOverrideInput }) =>
      saveReplenishmentOverride(storeId, input.variantId, input.values),
    onSuccess: invalidate,
  });
}

export function useDeleteReplenishmentOverride(storeId: string) {
  const invalidate = useInvalidateReplenishment(storeId);
  return useMutation({
    mutationFn: (variantId: string) => deleteReplenishmentOverride(storeId, variantId),
    onSuccess: invalidate,
  });
}
