import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type { Order, OrderSummary, PaginatedResponse } from '@mercaria/shared-types';
import { fetchOrders, fetchOrder, cancelOrder } from '../api/orders';
import { queryKeys } from './query-keys';

/** Thirty seconds — orders can transition (status, payment) between views. */
const STALE_TIME = 1000 * 30;

/** Fetch a page of the buyer's order summaries. Gated on auth. */
export function useOrders(page = 1) {
  const { isAuthenticated } = useOxy();
  return useQuery<PaginatedResponse<OrderSummary>>({
    queryKey: queryKeys.orders.list(page),
    queryFn: () => fetchOrders({ page }),
    enabled: isAuthenticated,
    staleTime: STALE_TIME,
    placeholderData: keepPreviousData,
  });
}

/** Fetch a single hydrated order. Gated on auth + a present id. */
export function useOrder(id: string | undefined) {
  const { isAuthenticated } = useOxy();
  return useQuery<Order>({
    queryKey: queryKeys.orders.detail(id ?? ''),
    queryFn: () => fetchOrder(id as string),
    enabled: isAuthenticated && Boolean(id),
    staleTime: STALE_TIME,
  });
}

/** Cancel an order; writes the fresh order into the cache and refreshes lists. */
export function useCancelOrder() {
  const queryClient = useQueryClient();
  return useMutation<Order, Error, string>({
    mutationFn: (id) => cancelOrder(id),
    onSuccess: (order) => {
      queryClient.setQueryData(queryKeys.orders.detail(order.id), order);
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] });
    },
  });
}
