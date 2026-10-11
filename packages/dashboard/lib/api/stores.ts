import type {
  ApiResponse,
  Store,
  CreateStoreInput,
  UpdateStoreInput,
  UpdateStoreSettingsInput,
  TransferStoreOwnerAccountInput,
} from '@mercaria/shared-types';
import apiClient from './client';
import { unwrap } from './unwrap';

/** GET /admin/stores — every store the caller's Oxy accounts reach. */
export async function fetchMyStores(): Promise<Store[]> {
  const { data } = await apiClient.get<ApiResponse<Store[]>>('/admin/stores');
  return unwrap(data);
}

/** GET /admin/stores/:storeId — a single store the caller can act for. */
export async function fetchStore(storeId: string): Promise<Store> {
  const { data } = await apiClient.get<ApiResponse<Store>>(`/admin/stores/${storeId}`);
  return unwrap(data);
}

/**
 * POST /admin/stores — create a store, owned by the caller's current account
 * unless `oxyAccountId` names another account they own or administer.
 */
export async function createStore(input: CreateStoreInput): Promise<Store> {
  const { data } = await apiClient.post<ApiResponse<Store>>('/admin/stores', input);
  return unwrap(data);
}

/** PATCH /admin/stores/:storeId — update the store's core profile. */
export async function updateStore(storeId: string, input: UpdateStoreInput): Promise<Store> {
  const { data } = await apiClient.patch<ApiResponse<Store>>(`/admin/stores/${storeId}`, input);
  return unwrap(data);
}

/** PATCH /admin/stores/:storeId/settings — policies / notifications / tax. */
export async function updateStoreSettings(
  storeId: string,
  input: UpdateStoreSettingsInput,
): Promise<Store> {
  const { data } = await apiClient.patch<ApiResponse<Store>>(
    `/admin/stores/${storeId}/settings`,
    input,
  );
  return unwrap(data);
}

/**
 * PATCH /admin/stores/:storeId/owner-account — move the store to another Oxy
 * account (the last step of "convert to organization"). Needs `store:manage`
 * here and owner/admin of the target account.
 */
export async function transferStoreOwnerAccount(
  storeId: string,
  input: TransferStoreOwnerAccountInput,
): Promise<Store> {
  const { data } = await apiClient.patch<ApiResponse<Store>>(
    `/admin/stores/${storeId}/owner-account`,
    input,
  );
  return unwrap(data);
}
