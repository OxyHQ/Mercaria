import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CheckoutPaymentStatus,
  CheckoutInput,
  CheckoutResult,
  CurrencyCode,
} from '@mercaria/shared-types';
import { getCheckoutPaymentStatus, postCheckout } from '../api/checkout';
import { queryKeys } from './query-keys';

/** What a checkout submission carries, plus the key that makes it replayable. */
export interface CheckoutSubmission extends CheckoutInput {
  /**
   * The `Idempotency-Key` for THIS attempt.
   *
   * Supplied by the caller and STABLE across retries, which is the entire point:
   * a key minted inside the mutation would be new on every retry, so a request
   * that timed out after the server had already placed the orders would place
   * them a second time — the exact failure the header exists to prevent. The
   * screen holds one key per "place order" press and mints a new one only once a
   * checkout has completed.
   */
  idempotencyKey: string;
  /**
   * The presentment currency this checkout is priced in — a GUEST's.
   *
   * Sent as a query parameter rather than in the body (see `postCheckout`), and
   * ignored server-side for a signed-in buyer.
   */
  currency?: CurrencyCode;
}

/**
 * Place orders from the buyer's cart.
 *
 * On success the cart (now emptied of the placed lines) and the order lists are
 * invalidated. The response may carry a payment handoff — see the payment step.
 */
export function useCheckout() {
  const queryClient = useQueryClient();
  return useMutation<CheckoutResult, Error, CheckoutSubmission>({
    mutationFn: ({ idempotencyKey, currency, ...input }) =>
      postCheckout(input, idempotencyKey, currency),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cart.all });
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] });
    },
  });
}

/** How often the client re-asks what happened while a payment is in flight. */
const PAYMENT_POLL_INTERVAL_MS = 2_000;

/**
 * Watch a checkout group's payment until it settles.
 *
 * Polling, and deliberately not the payment sheet's own result: the sheet says
 * what the BUYER did, while `paid` is a fact only a verified webhook can
 * establish. Polling stops as soon as the payment reaches a state nothing
 * further will move it out of, so a completed purchase does not leave a request
 * every two seconds running behind the confirmation screen.
 */
export function useCheckoutPaymentStatus(checkoutGroupId: string | undefined, enabled: boolean) {
  return useQuery<CheckoutPaymentStatus>({
    queryKey: ['checkout', 'payment-status', checkoutGroupId],
    queryFn: () => getCheckoutPaymentStatus(checkoutGroupId ?? ''),
    enabled: enabled && Boolean(checkoutGroupId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === undefined) return PAYMENT_POLL_INTERVAL_MS;
      return isSettledPaymentStatus(status) ? false : PAYMENT_POLL_INTERVAL_MS;
    },
  });
}

/** Whether a payment has reached a state the buyer's client should stop watching. */
export function isSettledPaymentStatus(status: CheckoutPaymentStatus['status']): boolean {
  return (
    status === 'succeeded' ||
    status === 'canceled' ||
    status === 'refunded' ||
    status === 'partially_refunded'
  );
}
