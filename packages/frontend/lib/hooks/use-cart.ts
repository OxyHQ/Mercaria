import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type {
  AddCartItemInput,
  Cart,
  UpdateCartItemInput,
} from '@mercaria/shared-types';
import {
  fetchCart,
  addCartItem,
  updateCartItem,
  removeCartItem,
  applyDiscount,
  removeDiscount,
} from '../api/cart';
import { queryKeys } from './query-keys';

/** One minute — cart freshness window (balanced against mutation optimism). */
const STALE_TIME = 1000 * 60;

/** Fetch the authenticated buyer's cart. Gated on auth — returns undefined when signed out. */
export function useCart() {
  const { isAuthenticated } = useOxy();
  return useQuery<Cart>({
    queryKey: queryKeys.cart.all,
    queryFn: fetchCart,
    enabled: isAuthenticated,
    staleTime: STALE_TIME,
    retry: 2,
  });
}

/** Add (or increment) a variant. The mutation response is the full fresh cart. */
export function useAddCartItem() {
  const queryClient = useQueryClient();
  return useMutation<Cart, Error, AddCartItemInput>({
    mutationFn: (input) => addCartItem(input),
    onSuccess: (cart) => {
      queryClient.setQueryData(queryKeys.cart.all, cart);
    },
  });
}

/** Update the absolute quantity of a cart line. */
export function useUpdateCartItem() {
  const queryClient = useQueryClient();
  return useMutation<Cart, Error, { variantId: string; input: UpdateCartItemInput }>({
    mutationFn: ({ variantId, input }) => updateCartItem(variantId, input),
    onSuccess: (cart) => {
      queryClient.setQueryData(queryKeys.cart.all, cart);
    },
  });
}

/** Remove a variant line from the cart. */
export function useRemoveCartItem() {
  const queryClient = useQueryClient();
  return useMutation<Cart, Error, string>({
    mutationFn: (variantId) => removeCartItem(variantId),
    onSuccess: (cart) => {
      queryClient.setQueryData(queryKeys.cart.all, cart);
    },
  });
}

/** Apply a discount code to the cart. */
export function useApplyDiscount() {
  const queryClient = useQueryClient();
  return useMutation<Cart, Error, string>({
    mutationFn: (code) => applyDiscount(code),
    onSuccess: (cart) => {
      queryClient.setQueryData(queryKeys.cart.all, cart);
    },
  });
}

/** Remove a discount code from the cart. */
export function useRemoveDiscount() {
  const queryClient = useQueryClient();
  return useMutation<Cart, Error, string>({
    mutationFn: (code) => removeDiscount(code),
    onSuccess: (cart) => {
      queryClient.setQueryData(queryKeys.cart.all, cart);
    },
  });
}
