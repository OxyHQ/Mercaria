import type {
  ApiResponse,
  TaxRate,
  CreateTaxRateInput,
  UpdateTaxRateInput,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/tax-rates`;

/** GET the store's tax rates. */
export async function fetchTaxRates(storeId: string): Promise<TaxRate[]> {
  const { data } = await apiClient.get<ApiResponse<TaxRate[]>>(base(storeId));
  return unwrap(data);
}

/** POST a new tax rate. */
export async function createTaxRate(
  storeId: string,
  input: CreateTaxRateInput,
): Promise<TaxRate> {
  const { data } = await apiClient.post<ApiResponse<TaxRate>>(base(storeId), input);
  return unwrap(data);
}

/** PATCH a tax rate. */
export async function updateTaxRate(
  storeId: string,
  id: string,
  input: UpdateTaxRateInput,
): Promise<TaxRate> {
  const { data } = await apiClient.patch<ApiResponse<TaxRate>>(`${base(storeId)}/${id}`, input);
  return unwrap(data);
}

/** DELETE a tax rate. */
export async function deleteTaxRate(
  storeId: string,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const { data } = await apiClient.delete<ApiResponse<{ id: string; deleted: boolean }>>(
    `${base(storeId)}/${id}`,
  );
  return unwrap(data);
}
