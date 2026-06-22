import type {
  ApiResponse,
  PaginatedResponse,
  Order,
  OrderSummary,
  OrderStatus,
  Refund,
  CreateRefundInput,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";
import type { StoreStats } from "./types";

const base = (storeId: string) => `/admin/stores/${storeId}/orders`;

/** Status transitions the fulfilment UI may drive (subset of `OrderStatus`). */
export type FulfillmentStatus = "processing" | "shipped" | "delivered" | "cancelled";

/** GET orders — paginated `OrderSummary` list, optionally filtered by status. */
export async function fetchOrders(
  storeId: string,
  params: { page?: number; limit?: number; status?: OrderStatus } = {},
): Promise<PaginatedResponse<OrderSummary>> {
  const { data } = await apiClient.get<PaginatedResponse<OrderSummary>>(base(storeId), { params });
  return data;
}

/** GET a single hydrated order. */
export async function fetchOrder(storeId: string, id: string): Promise<Order> {
  const { data } = await apiClient.get<ApiResponse<Order>>(`${base(storeId)}/${id}`);
  return unwrap(data);
}

/** GET the store order dashboard stats. */
export async function fetchStoreStats(storeId: string): Promise<StoreStats> {
  const { data } = await apiClient.get<ApiResponse<StoreStats>>(`${base(storeId)}/stats`);
  return unwrap(data);
}

/** PATCH an order's status (fulfilment transition + optional tracking/note). */
export async function patchOrderStatus(
  storeId: string,
  id: string,
  body: { status: FulfillmentStatus; trackingNumber?: string; note?: string },
): Promise<Order> {
  const { data } = await apiClient.patch<ApiResponse<Order>>(`${base(storeId)}/${id}/status`, body);
  return unwrap(data);
}

/** POST a refund against an order (amounts computed server-side). */
export async function createRefund(
  storeId: string,
  id: string,
  input: CreateRefundInput,
): Promise<Refund> {
  const { data } = await apiClient.post<ApiResponse<Refund>>(`${base(storeId)}/${id}/refunds`, input);
  return unwrap(data);
}

/** GET the refunds processed against an order. */
export async function fetchOrderRefunds(storeId: string, id: string): Promise<Refund[]> {
  const { data } = await apiClient.get<ApiResponse<Refund[]>>(`${base(storeId)}/${id}/refunds`);
  return unwrap(data);
}
