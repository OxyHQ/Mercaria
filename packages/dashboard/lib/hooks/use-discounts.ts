import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Discount,
  CreateDiscountInput,
  UpdateDiscountInput,
} from "@mercaria/shared-types";
import {
  fetchDiscounts,
  fetchDiscount,
  createDiscount,
  updateDiscount,
  deleteDiscount,
} from "../api/discounts";
import { queryKeys } from "../queryKeys";

/** The store's discounts. */
export function useDiscounts(storeId: string) {
  return useQuery<Discount[]>({
    queryKey: queryKeys.discounts.list(storeId),
    queryFn: () => fetchDiscounts(storeId),
    enabled: Boolean(storeId),
  });
}

/** A single discount. */
export function useDiscount(storeId: string, id: string) {
  return useQuery<Discount>({
    queryKey: queryKeys.discounts.detail(storeId, id),
    queryFn: () => fetchDiscount(storeId, id),
    enabled: Boolean(storeId) && Boolean(id),
  });
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>, storeId: string) {
  queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list(storeId) });
}

/** Create a discount. */
export function useCreateDiscount(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDiscountInput) => createDiscount(storeId, input),
    onSuccess: () => invalidate(queryClient, storeId),
  });
}

/** Update a discount. */
export function useUpdateDiscount(storeId: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDiscountInput) => updateDiscount(storeId, id, input),
    onSuccess: () => {
      invalidate(queryClient, storeId);
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.detail(storeId, id) });
    },
  });
}

/** Delete a discount. */
export function useDeleteDiscount(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteDiscount(storeId, id),
    onSuccess: () => invalidate(queryClient, storeId),
  });
}
