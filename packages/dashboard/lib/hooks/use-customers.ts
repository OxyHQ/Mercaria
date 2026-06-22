import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import type {
  PaginatedResponse,
  Customer,
  OrderSummary,
  CreateCustomerInput,
  UpdateCustomerInput,
} from "@mercaria/shared-types";
import {
  fetchCustomers,
  fetchCustomer,
  fetchCustomerOrders,
  createCustomer,
  updateCustomer,
} from "../api/customers";
import { queryKeys } from "../queryKeys";

const PAGE_LIMIT = 20;

/** Paginated customer list (optionally search-filtered). */
export function useCustomers(storeId: string, page: number, search: string) {
  return useQuery<PaginatedResponse<Customer>>({
    queryKey: queryKeys.customers.list(storeId, page, search),
    queryFn: () =>
      fetchCustomers(storeId, {
        page,
        limit: PAGE_LIMIT,
        ...(search ? { search } : {}),
      }),
    enabled: Boolean(storeId),
    placeholderData: keepPreviousData,
  });
}

/** A single customer. */
export function useCustomer(storeId: string, id: string) {
  return useQuery<Customer>({
    queryKey: queryKeys.customers.detail(storeId, id),
    queryFn: () => fetchCustomer(storeId, id),
    enabled: Boolean(storeId) && Boolean(id),
  });
}

/** A customer's order history. */
export function useCustomerOrders(storeId: string, id: string) {
  return useQuery<OrderSummary[]>({
    queryKey: queryKeys.customers.orders(storeId, id),
    queryFn: () => fetchCustomerOrders(storeId, id),
    enabled: Boolean(storeId) && Boolean(id),
  });
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>, storeId: string) {
  queryClient.invalidateQueries({ queryKey: ["stores", storeId, "customers"] });
}

/** Create a customer. */
export function useCreateCustomer(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomerInput) => createCustomer(storeId, input),
    onSuccess: () => invalidate(queryClient, storeId),
  });
}

/** Update a customer. */
export function useUpdateCustomer(storeId: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCustomerInput) => updateCustomer(storeId, id, input),
    onSuccess: () => {
      invalidate(queryClient, storeId);
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.detail(storeId, id) });
    },
  });
}
