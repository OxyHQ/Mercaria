import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import type {
  PaginatedResponse,
  Customer,
  CreateCustomerInput,
} from "@mercaria/shared-types";
import { fetchCustomers, createCustomer } from "../api/customers";
import { queryKeys } from "../queryKeys";

/** The store's customers, optionally filtered by a search term. */
export function useCustomers(storeId: string, search: string) {
  return useQuery<PaginatedResponse<Customer>>({
    queryKey: queryKeys.customers.list(storeId, search),
    queryFn: () =>
      fetchCustomers(storeId, {
        ...(search ? { search } : {}),
      }),
    enabled: Boolean(storeId),
    placeholderData: keepPreviousData,
  });
}

/** Create a customer (a walk-in is just one with no `oxyUserId`). */
export function useCreateCustomer(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomerInput) => createCustomer(storeId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stores", storeId, "customers"] });
    },
  });
}
