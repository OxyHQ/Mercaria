import type {
  ApiResponse,
  Order,
  OrderSummary,
  PaginatedResponse,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Buyer orders API client.
 *
 * Backed by `/orders` (paginated summaries), `/orders/:id` (a hydrated order)
 * and `/orders/:id/cancel`. Read-only plus the buyer-side cancel transition;
 * payment is an unintegrated seam (orders are created `unpaid`).
 */

/** Fetch a page of the buyer's order summaries (newest first). */
export async function fetchOrders(
  params: { page?: number; limit?: number } = {},
): Promise<PaginatedResponse<OrderSummary>> {
  const { data } = await apiClient.get<PaginatedResponse<OrderSummary>>('/orders', {
    params,
  });
  return data;
}

/** Fetch a single hydrated order owned by the buyer. */
export async function fetchOrder(id: string): Promise<Order> {
  const { data } = await apiClient.get<ApiResponse<Order>>(`/orders/${id}`);
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load order');
  }
  return data.data;
}

/** Cancel the buyer's own order. Returns the updated order. */
export async function cancelOrder(id: string): Promise<Order> {
  const { data } = await apiClient.post<ApiResponse<Order>>(`/orders/${id}/cancel`);
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to cancel order');
  }
  return data.data;
}
