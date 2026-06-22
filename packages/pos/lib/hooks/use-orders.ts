import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type {
  PaginatedResponse,
  Order,
  OrderSummary,
} from "@mercaria/shared-types";
import { fetchOrders, fetchOrder } from "../api/orders";
import { queryKeys } from "../queryKeys";

/** Page size for the sales (recent orders) list. */
const PAGE_LIMIT = 20;

/** Paginated recent-orders list for the sales screen. */
export function useOrders(storeId: string, page: number) {
  return useQuery<PaginatedResponse<OrderSummary>>({
    queryKey: queryKeys.orders.list(storeId, page),
    queryFn: () => fetchOrders(storeId, { page, limit: PAGE_LIMIT }),
    enabled: Boolean(storeId),
    placeholderData: keepPreviousData,
  });
}

/** A single hydrated order (the receipt). */
export function useOrder(storeId: string, id: string) {
  return useQuery<Order>({
    queryKey: queryKeys.orders.detail(storeId, id),
    queryFn: () => fetchOrder(storeId, id),
    enabled: Boolean(storeId) && Boolean(id),
  });
}
