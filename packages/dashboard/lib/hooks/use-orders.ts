import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import type {
  PaginatedResponse,
  Order,
  OrderSummary,
  OrderStatus,
  Refund,
  CreateRefundInput,
} from "@mercaria/shared-types";
import {
  fetchOrders,
  fetchOrder,
  fetchStoreStats,
  patchOrderStatus,
  createRefund,
  fetchOrderRefunds,
  type FulfillmentStatus,
} from "../api/orders";
import { queryKeys } from "../queryKeys";
import type { StoreStats } from "../api/types";

const PAGE_LIMIT = 20;

/** Paginated order list (optionally filtered by status). */
export function useOrders(storeId: string, page: number, status: OrderStatus | "all") {
  return useQuery<PaginatedResponse<OrderSummary>>({
    queryKey: queryKeys.orders.list(storeId, page, status),
    queryFn: () =>
      fetchOrders(storeId, {
        page,
        limit: PAGE_LIMIT,
        ...(status !== "all" ? { status } : {}),
      }),
    enabled: Boolean(storeId),
    placeholderData: keepPreviousData,
  });
}

/** A single hydrated order. */
export function useOrder(storeId: string, orderId: string) {
  return useQuery<Order>({
    queryKey: queryKeys.orders.detail(storeId, orderId),
    queryFn: () => fetchOrder(storeId, orderId),
    enabled: Boolean(storeId) && Boolean(orderId),
  });
}

/** The store order dashboard stats. */
export function useStoreStats(storeId: string) {
  return useQuery<StoreStats>({
    queryKey: queryKeys.orders.stats(storeId),
    queryFn: () => fetchStoreStats(storeId),
    enabled: Boolean(storeId),
  });
}

/** Refunds processed against an order. */
export function useOrderRefunds(storeId: string, orderId: string) {
  return useQuery<Refund[]>({
    queryKey: queryKeys.orders.refunds(storeId, orderId),
    queryFn: () => fetchOrderRefunds(storeId, orderId),
    enabled: Boolean(storeId) && Boolean(orderId),
  });
}

function invalidateOrders(
  queryClient: ReturnType<typeof useQueryClient>,
  storeId: string,
  orderId: string,
) {
  queryClient.invalidateQueries({ queryKey: ["stores", storeId, "orders"] });
  queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(storeId, orderId) });
}

/** Drive an order status transition (fulfilment). */
export function usePatchOrderStatus(storeId: string, orderId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { status: FulfillmentStatus; trackingNumber?: string; note?: string }) =>
      patchOrderStatus(storeId, orderId, body),
    onSuccess: () => invalidateOrders(queryClient, storeId, orderId),
  });
}

/** Process a refund against an order. */
export function useCreateRefund(storeId: string, orderId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRefundInput) => createRefund(storeId, orderId, input),
    onSuccess: () => {
      invalidateOrders(queryClient, storeId, orderId);
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.refunds(storeId, orderId) });
    },
  });
}
