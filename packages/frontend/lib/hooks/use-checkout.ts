import { useMutation, useQueryClient } from '@tanstack/react-query';
import { nanoid } from 'nanoid/non-secure';
import type { CheckoutInput, CheckoutResult } from '@mercaria/shared-types';
import { postCheckout } from '../api/checkout';
import { queryKeys } from './query-keys';

/**
 * Place orders from the buyer's cart.
 *
 * A fresh `Idempotency-Key` is minted per attempt so a network retry of the
 * SAME submission converges on the original orders rather than double-charging.
 * On success the cart (now emptied of the placed lines) and the order lists are
 * invalidated.
 */
export function useCheckout() {
  const queryClient = useQueryClient();
  return useMutation<CheckoutResult, Error, CheckoutInput>({
    mutationFn: (input) => postCheckout(input, nanoid()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cart.all });
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] });
    },
  });
}
