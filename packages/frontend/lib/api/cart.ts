import type {
  AddCartItemInput,
  ApiResponse,
  ApplyCartDiscountInput,
  Cart,
  UpdateCartItemInput,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Cart API client.
 *
 * Every mutation route returns the full fresh `Cart` wrapped in `ApiResponse<Cart>`.
 * We set the query-cache directly from the mutation response (no invalidation needed).
 */

/** Fetch the authenticated buyer's current cart. */
export async function fetchCart(): Promise<Cart> {
  const { data } = await apiClient.get<ApiResponse<Cart>>('/cart');
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load cart');
  }
  return data.data;
}

/** Add (or increment) a variant in the cart. Returns the updated cart. */
export async function addCartItem(input: AddCartItemInput): Promise<Cart> {
  const { data } = await apiClient.post<ApiResponse<Cart>>('/cart/items', input);
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to add item to cart');
  }
  return data.data;
}

/** Set the absolute quantity of a variant in the cart. Returns the updated cart. */
export async function updateCartItem(
  variantId: string,
  input: UpdateCartItemInput,
): Promise<Cart> {
  const { data } = await apiClient.patch<ApiResponse<Cart>>(
    `/cart/items/${variantId}`,
    input,
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to update cart item');
  }
  return data.data;
}

/** Remove a variant line from the cart. Returns the updated cart. */
export async function removeCartItem(variantId: string): Promise<Cart> {
  const { data } = await apiClient.delete<ApiResponse<Cart>>(
    `/cart/items/${variantId}`,
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to remove cart item');
  }
  return data.data;
}

/** Apply a discount code to the cart. Returns the updated cart. */
export async function applyDiscount(code: string): Promise<Cart> {
  const body: ApplyCartDiscountInput = { code };
  const { data } = await apiClient.post<ApiResponse<Cart>>('/cart/discount', body);
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to apply discount');
  }
  return data.data;
}

/** Remove a discount code from the cart. Returns the updated cart. */
export async function removeDiscount(code: string): Promise<Cart> {
  const { data } = await apiClient.delete<ApiResponse<Cart>>(
    `/cart/discount/${code}`,
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to remove discount');
  }
  return data.data;
}
