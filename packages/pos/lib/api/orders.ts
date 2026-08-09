import type {
  ApiResponse,
  PaginatedResponse,
  MerchantOrder,
  MerchantOrderSummary,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/orders`;

/**
 * GET orders — a paginated `OrderSummary` list for the store. There is no
 * server-side `sourceChannel` filter, so this returns ALL recent store orders;
 * the sales screen surfaces POS orders by inspecting the full order's
 * `sourceChannel` where needed.
 */
export async function fetchOrders(
  storeId: string,
  params: { page?: number; limit?: number } = {},
): Promise<PaginatedResponse<MerchantOrderSummary>> {
  const { data } = await apiClient.get<PaginatedResponse<MerchantOrderSummary>>(base(storeId), {
    params,
  });
  return data;
}

/** GET a single hydrated order. */
export async function fetchOrder(storeId: string, id: string): Promise<MerchantOrder> {
  const { data } = await apiClient.get<ApiResponse<MerchantOrder>>(`${base(storeId)}/${id}`);
  return unwrap(data);
}
