import type {
  AddCartItemInput,
  ApiResponse,
  ApplyCartDiscountInput,
  Cart,
  CartMergeResult,
  UpdateCartItemInput,
} from '@mercaria/shared-types';
import apiClient, { apiErrorMessage } from './client';

/**
 * Cart API client.
 *
 * Every mutation route returns the full fresh `Cart` wrapped in `ApiResponse<Cart>`.
 * We set the query-cache directly from the mutation response (no invalidation needed).
 *
 * The cart belongs to whoever the SERVER resolves the caller to be — an Oxy
 * account or a guest session (#104). No function here names an owner, because
 * a client that could name one could name someone else's; the credential rides
 * on `apiClient` and the server decides.
 */

/**
 * Fetch the caller's current cart — signed in or signed out.
 *
 * A caller with no credential at all gets an EMPTY cart rather than a 401, and
 * no guest session is created to answer it (ADR 0003 T10): a page view must
 * never mint a credential.
 */
export async function fetchCart(): Promise<Cart> {
  try {
    const { data } = await apiClient.get<ApiResponse<Cart>>('/cart');
    if (!data.success || !data.data) {
      throw new Error(data.error ?? data.message ?? 'Failed to load cart');
    }
    return data.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error, 'Failed to load cart'));
  }
}

/** Add (or increment) a variant in the cart. Returns the updated cart. */
export async function addCartItem(input: AddCartItemInput): Promise<Cart> {
  try {
    const { data } = await apiClient.post<ApiResponse<Cart>>('/cart/items', input);
    if (!data.success || !data.data) {
      throw new Error(data.error ?? data.message ?? 'Failed to add item to cart');
    }
    return data.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error, 'Failed to add item to cart'));
  }
}

/** Set the absolute quantity of a variant in the cart. Returns the updated cart. */
export async function updateCartItem(
  variantId: string,
  input: UpdateCartItemInput,
): Promise<Cart> {
  try {
    const { data } = await apiClient.patch<ApiResponse<Cart>>(
      `/cart/items/${variantId}`,
      input,
    );
    if (!data.success || !data.data) {
      throw new Error(data.error ?? data.message ?? 'Failed to update cart item');
    }
    return data.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error, 'Failed to update cart item'));
  }
}

/** Remove a variant line from the cart. Returns the updated cart. */
export async function removeCartItem(variantId: string): Promise<Cart> {
  try {
    const { data } = await apiClient.delete<ApiResponse<Cart>>(
      `/cart/items/${variantId}`,
    );
    if (!data.success || !data.data) {
      throw new Error(data.error ?? data.message ?? 'Failed to remove cart item');
    }
    return data.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error, 'Failed to remove cart item'));
  }
}

/** Apply a discount code to the cart. Returns the updated cart. */
export async function applyDiscount(code: string): Promise<Cart> {
  const body: ApplyCartDiscountInput = { code };
  try {
    const { data } = await apiClient.post<ApiResponse<Cart>>('/cart/discount', body);
    if (!data.success || !data.data) {
      throw new Error(data.error ?? data.message ?? 'Failed to apply discount');
    }
    return data.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error, 'Failed to apply discount'));
  }
}

/** Remove a discount code from the cart. Returns the updated cart. */
export async function removeDiscount(code: string): Promise<Cart> {
  try {
    const { data } = await apiClient.delete<ApiResponse<Cart>>(
      `/cart/discount/${code}`,
    );
    if (!data.success || !data.data) {
      throw new Error(data.error ?? data.message ?? 'Failed to remove discount');
    }
    return data.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error, 'Failed to remove discount'));
  }
}

/**
 * Fold the guest cart into the signed-in account's cart (#104).
 *
 * Takes NO arguments, deliberately: the guest session is the one the server
 * already verified from the credential on this request, never one the client
 * names. Safe to call whenever a signed-in person might still hold a guest
 * credential — with none, it answers `merged: false` and the current cart; with
 * one, `UNIQUE(cart_merges.guest_session_id)` makes a repeat converge on the
 * first merge's result rather than merging twice.
 */
export async function mergeGuestCart(): Promise<CartMergeResult> {
  try {
    const { data } = await apiClient.post<ApiResponse<CartMergeResult>>('/cart/merge');
    if (!data.success || !data.data) {
      throw new Error(data.error ?? data.message ?? 'Failed to merge your guest cart');
    }
    return data.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error, 'Failed to merge your guest cart'));
  }
}
