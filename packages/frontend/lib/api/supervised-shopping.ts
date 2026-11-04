import type { PurchaseApproval } from '@oxy.so/contracts';
import type {
  ApiResponse,
  CheckoutInput,
  CheckoutPaymentHandoff,
  CheckoutPaymentStatus,
  ReviewedShoppingCart,
  ReviewedShoppingListing,
} from '@mercaria/shared-types';
import apiClient from './client';

export interface SupervisedCheckout {
  checkoutGroupId: string;
  purchaseApproval: PurchaseApproval;
  payment?: CheckoutPaymentHandoff;
  paymentStatus?: CheckoutPaymentStatus;
}
function unwrap<T>(response: ApiResponse<T>): T {
  if (!response.success || !response.data) throw new Error(response.message ?? response.error);
  return response.data;
}
export async function supervisedCatalog(cursor?: string) {
  const { data } = await apiClient.get<
    ApiResponse<{ items: ReviewedShoppingListing[]; nextCursor: string | null }>
  >('/supervised-shopping/catalog', { params: cursor ? { cursor } : {} });
  return unwrap(data);
}
export async function supervisedCart() {
  return unwrap(
    (await apiClient.get<ApiResponse<ReviewedShoppingCart>>('/supervised-shopping/cart')).data,
  );
}
export async function addSupervisedItem(input: {
  listingId: string;
  variantId: string;
  quantity: number;
}) {
  return unwrap(
    (
      await apiClient.post<ApiResponse<ReviewedShoppingCart>>(
        '/supervised-shopping/cart/items',
        input,
      )
    ).data,
  );
}
export async function removeSupervisedItem(variantId: string) {
  return unwrap(
    (
      await apiClient.delete<ApiResponse<ReviewedShoppingCart>>(
        `/supervised-shopping/cart/items/${variantId}`,
      )
    ).data,
  );
}
export async function prepareSupervisedPurchase(input: CheckoutInput, key: string) {
  return unwrap(
    (
      await apiClient.post<ApiResponse<SupervisedCheckout>>(
        '/supervised-shopping/checkout',
        input,
        { headers: { 'Idempotency-Key': key } },
      )
    ).data,
  );
}
export async function supervisedPurchase(id: string) {
  return unwrap(
    (await apiClient.get<ApiResponse<SupervisedCheckout>>(`/supervised-shopping/checkout/${id}`))
      .data,
  );
}
export async function resumeSupervisedPurchase(id: string) {
  return unwrap(
    (
      await apiClient.post<ApiResponse<SupervisedCheckout>>(
        `/supervised-shopping/checkout/${id}/resume`,
      )
    ).data,
  );
}
