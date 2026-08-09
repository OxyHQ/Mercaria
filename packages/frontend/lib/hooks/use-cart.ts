import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
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
import {
  USES_HEADER_TRANSPORT,
  discardGuestToken,
  useGuestCredentialStore,
} from '../stores/guest-credential-store';
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
 * `enabled` differs by transport, because "do I still hold a guest credential?"
 * is answerable on native and NOT on web: the web credential is an `HttpOnly`
 * cookie this code cannot see, so web asks the server (which answers
 * `merged: false` when there is nothing to merge) and native asks its own
 * store, which avoids a pointless request on every cold start.
 */
export function useGuestCartMerge() {
  const { isAuthenticated } = useOxy();
  const queryClient = useQueryClient();
  const hydrated = useGuestCredentialStore((state) => state.hydrated);
  const nativeToken = useGuestCredentialStore((state) => state.token);

  return useQuery<CartMergeResult>({
    queryKey: queryKeys.cart.merge,
    queryFn: async () => {
      const result = await mergeGuestCart();
      // The server revoked the credential inside the merge transaction, so the
      // client must stop presenting it. Web's cookie was cleared by the same
      // response; native has nothing server-side to clear, which is exactly
      // what `guestCredentialRevoked` is the instruction for (ADR 0003 D9).
      if (result.guestCredentialRevoked) {
        discardGuestToken();
      }
      queryClient.setQueryData(queryKeys.cart.all, result.cart);
      return result;
    },
    enabled:
      isAuthenticated &&
      (USES_HEADER_TRANSPORT
        ? // Native can SEE whether it holds a credential, so it asks only when
          // there is something to merge — and only once storage has answered.
          hydrated && nativeToken !== null
        : // Web cannot: the credential is an `HttpOnly` cookie. It asks the
          // server, which answers `merged: false` when there is nothing to do.
          true),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
}
