import type {
  ApiResponse,
  CheckoutInput,
  CheckoutResult,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Checkout API client — turn the buyer's cart into orders.
 *
 * `POST /checkout` places orders (one per seller). `input.sellerKeys` narrows
 * the checkout to specific seller groups (the rest stay in the cart); omitting
 * it checks out the whole cart. The caller passes a per-attempt
 * `Idempotency-Key` so a retry converges on the original orders.
 */
export async function postCheckout(
  input: CheckoutInput,
  idempotencyKey: string,
): Promise<CheckoutResult> {
  const { data } = await apiClient.post<ApiResponse<CheckoutResult>>('/checkout', input, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Checkout failed');
  }
  return data.data;
}
