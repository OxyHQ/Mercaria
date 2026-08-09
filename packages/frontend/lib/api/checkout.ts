import type {
  ApiResponse,
  CheckoutInput,
  CheckoutPaymentStatus,
  CheckoutResult,
  CurrencyCode,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Checkout API client — turn the buyer's cart into orders.
 *
 * `POST /checkout` places orders (one per seller). `input.sellerKeys` narrows
 * the checkout to specific seller groups (the rest stay in the cart); omitting
 * it checks out the whole cart. The caller passes a per-attempt
 * `Idempotency-Key` so a retry converges on the original orders.
 *
 * `currency` rides the QUERY STRING, exactly as it does on `/cart`, and not the
 * body: the checkout body refuses `amount`, `paid`, `paymentStatus` and
 * `currency` alike, because a body able to carry any of them is the surface on
 * which one would eventually be trusted. It is a GUEST's presentment currency
 * and is ignored server-side for a signed-in buyer, whose stored preference
 * stays the authority — which is why it is sent unconditionally rather than
 * behind a branch this client would have to keep in step with the server's.
 */
export async function postCheckout(
  input: CheckoutInput,
  idempotencyKey: string,
  currency?: CurrencyCode,
): Promise<CheckoutResult> {
  const { data } = await apiClient.post<ApiResponse<CheckoutResult>>('/checkout', input, {
    headers: { 'Idempotency-Key': idempotencyKey },
    ...(currency ? { params: { currency } } : {}),
  });
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Checkout failed');
  }
  return data.data;
}

/**
 * What actually happened to a checkout group's payment.
 *
 * The client asks HERE after a payment sheet closes, instead of reporting the
 * outcome itself: a sheet's own result is a UI event, while `paid` is a fact
 * only a verified provider webhook can establish. Polling this is the whole of
 * the client's role in confirming a payment.
 */
export async function getCheckoutPaymentStatus(
  checkoutGroupId: string,
): Promise<CheckoutPaymentStatus> {
  const { data } = await apiClient.get<ApiResponse<CheckoutPaymentStatus>>(
    `/checkout/${checkoutGroupId}/payment-status`,
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Could not read the payment status');
  }
  return data.data;
}
