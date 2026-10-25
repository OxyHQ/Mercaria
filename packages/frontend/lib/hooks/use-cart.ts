import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import type {
  AddCartItemInput,
  Cart,
  CartMergeResult,
  UpdateCartItemInput,
} from '@mercaria/shared-types';
import {
  fetchCart,
  addCartItem,
  updateCartItem,
  removeCartItem,
  applyDiscount,
  removeDiscount,
  mergeGuestCart,
} from '../api/cart';
import { useGuestCredentialStore } from '../stores/guest-credential-store';
import { queryKeys } from './query-keys';

/** One minute — cart freshness window (balanced against mutation optimism). */
const STALE_TIME = 1000 * 60;

/**
 * The buyer's cart — signed in OR signed out (#104).
 *
 * The `enabled: isAuthenticated` gate that used to live here was the single
 * switch that made the whole cart invisible to a guest: the query never ran, so
 * the cart screen, the home shelf and the tab badge all saw `undefined` and the
 * screen had nowhere to go but "sign in to start adding items". The server now
 * answers a cart for either actor, and an anonymous visitor who has never
 * written gets an empty one without a session being created for them — so
 * running this query unconditionally costs a signed-out visitor one cheap read
 * and creates nothing.
 */
export function useCart() {
  return useQuery<Cart>({
    queryKey: queryKeys.cart.all,
    queryFn: fetchCart,
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

/**
 * Merge the guest cart into the account's cart when someone signs in (#104).
 *
 * ## Why this is a QUERY and not a mutation, and why there is no `useEffect`
 *
 * The trigger is a state TRANSITION — `isAuthenticated` flipping true while a
 * guest credential is still held — and the reflex is an effect watching it.
 * React Query already models exactly this: `enabled` turning true runs the
 * function once, deduplicates concurrent mounts, retries a failure and, with an
 * infinite `staleTime`, never re-runs on its own. That is precisely the
 * semantics wanted, so an effect would be a second, worse scheduler.
 *
 * Calling it twice would be harmless anyway — `UNIQUE(cart_merges.guest_session_id)`
 * plus the merge's row locks make a repeat converge on the first result — which
 * is what lets the client be this relaxed about when it fires.
 *
 * All platforms wait for credential hydration before attempting the merge.
 */
export function useGuestCartMerge(enabled = true) {
  const { isAuthenticated, user } = useOxy();
  const queryClient = useQueryClient();
  const hydrated = useGuestCredentialStore((state) => state.hydrated);
  const guestToken = useGuestCredentialStore((state) => state.token);

  return useQuery<CartMergeResult>({
    queryKey: [...queryKeys.cart.merge, user?.id],
    queryFn: async () => {
      const result = await mergeGuestCart();
      // The transport applies the response's revocation header with its request fence.
      queryClient.setQueryData(queryKeys.cart.all, result.cart);
      return result;
    },
    enabled: enabled && isAuthenticated && hydrated && guestToken !== null,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
}
