import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type {
  BuyerOrderView,
  Order,
  OrderSummary,
  PaginatedResponse,
} from '@mercaria/shared-types';
import { fetchOrders, fetchOrder, cancelOrder } from '../api/orders';
import { queryKeys } from './query-keys';

/** Thirty seconds — orders can transition (status, payment) between views. */
const STALE_TIME = 1000 * 30;

/** Fetch a page of the buyer's order summaries. Gated on auth. */
export function useOrders(page = 1, view: BuyerOrderView = 'active') {
  const { isAuthenticated, canUsePrivateApi, user } = useOxy();
  const userId = user?.id ?? '';
  return useQuery<PaginatedResponse<OrderSummary>>({
    queryKey: queryKeys.orders.list(page, view, userId),
    queryFn: () => fetchOrders({ page, view }),
    enabled: isAuthenticated && canUsePrivateApi && Boolean(userId),
    staleTime: STALE_TIME,
    // Retain a page only within this account and view. A new tab/account must
    // never display the preceding tab/account's orders while its request loads.
    placeholderData: (previous, previousQuery) => {
      const key = previousQuery?.queryKey;
      return key?.[2] === userId && key?.[3] === view ? previous : undefined;
    },
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
