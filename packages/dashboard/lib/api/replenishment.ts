import type {
  ApiResponse,
  ReplenishmentPlan,
  ReplenishmentRowStatus,
  ReplenishmentSettingValues,
  ReplenishmentSettingsView,
  UpsertReplenishmentOverrideInput,
} from '@mercaria/shared-types';
import apiClient from './client';
import { unwrap } from './unwrap';

const base = (storeId: string) => `/admin/stores/${storeId}/replenishment`;

/** The plan's filters; `null` means "all". */
export interface ReplenishmentPlanFilters {
  locationId: string | null;
  status: ReplenishmentRowStatus | null;
}

function planParams(filters: ReplenishmentPlanFilters): Record<string, string> {
  return {
    ...(filters.locationId ? { locationId: filters.locationId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
}

/** GET the saved settings and overrides. Readable without the plan. */
export async function fetchReplenishmentSettings(
  storeId: string,
): Promise<ReplenishmentSettingsView> {
  const { data } = await apiClient.get<ApiResponse<ReplenishmentSettingsView>>(
    `${base(storeId)}/settings`,
  );
  return unwrap(data);
}

/** PUT the store's settings. */
export async function saveReplenishmentSettings(
  storeId: string,
  values: ReplenishmentSettingValues,
): Promise<ReplenishmentSettingsView> {
  const { data } = await apiClient.put<ApiResponse<ReplenishmentSettingsView>>(
    `${base(storeId)}/settings`,
    values,
  );
  return unwrap(data);
}

/** PUT one variant's override; a `null` field inherits the store's value. */
export async function saveReplenishmentOverride(
  storeId: string,
  variantId: string,
  input: UpsertReplenishmentOverrideInput,
): Promise<ReplenishmentSettingsView> {
  const { data } = await apiClient.put<ApiResponse<ReplenishmentSettingsView>>(
    `${base(storeId)}/overrides/${variantId}`,
    input,
  );
  return unwrap(data);
}

/** DELETE one variant's override. */
export async function deleteReplenishmentOverride(
  storeId: string,
  variantId: string,
): Promise<ReplenishmentSettingsView> {
  const { data } = await apiClient.delete<ApiResponse<ReplenishmentSettingsView>>(
    `${base(storeId)}/overrides/${variantId}`,
  );
  return unwrap(data);
}

/** GET the prioritised plan. */
export async function fetchReplenishmentPlan(
  storeId: string,
  filters: ReplenishmentPlanFilters,
): Promise<ReplenishmentPlan> {
  const { data } = await apiClient.get<ApiResponse<ReplenishmentPlan>>(`${base(storeId)}/plan`, {
    params: planParams(filters),
  });
  return unwrap(data);
}

/** GET the whole plan as CSV text, with the same filters. */
export async function fetchReplenishmentCsv(
  storeId: string,
  filters: ReplenishmentPlanFilters,
): Promise<string> {
  const { data } = await apiClient.get<string>(`${base(storeId)}/plan`, {
    params: { ...planParams(filters), format: 'csv' },
    responseType: 'text',
  });
  return data;
}
