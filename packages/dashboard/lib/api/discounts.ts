import type {
  ApiResponse,
  Discount,
  CreateDiscountInput,
  UpdateDiscountInput,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/discounts`;

/** GET the store's discounts. */
export async function fetchDiscounts(storeId: string): Promise<Discount[]> {
  const { data } = await apiClient.get<ApiResponse<Discount[]>>(base(storeId));
  return unwrap(data);
}

/** GET a single discount. */
export async function fetchDiscount(storeId: string, id: string): Promise<Discount> {
  const { data } = await apiClient.get<ApiResponse<Discount>>(`${base(storeId)}/${id}`);
  return unwrap(data);
}

/** POST a new discount. */
export async function createDiscount(
  storeId: string,
  input: CreateDiscountInput,
): Promise<Discount> {
  const { data } = await apiClient.post<ApiResponse<Discount>>(base(storeId), input);
  return unwrap(data);
}

/** PATCH a discount. */
export async function updateDiscount(
  storeId: string,
  id: string,
  input: UpdateDiscountInput,
): Promise<Discount> {
  const { data } = await apiClient.patch<ApiResponse<Discount>>(`${base(storeId)}/${id}`, input);
  return unwrap(data);
}

/** DELETE a discount. */
export async function deleteDiscount(
  storeId: string,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const { data } = await apiClient.delete<ApiResponse<{ id: string; deleted: boolean }>>(
    `${base(storeId)}/${id}`,
  );
  return unwrap(data);
}
