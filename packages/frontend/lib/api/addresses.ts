import type {
  Address,
  ApiResponse,
  CreateAddressInput,
  UpdateAddressInput,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Addresses API client — the buyer's saved shipping addresses.
 *
 * Backed by `/addresses` (list/create/update/delete). The single-default
 * invariant is enforced server-side; the list route returns every address.
 */

/** Fetch the authenticated buyer's saved addresses. */
export async function fetchAddresses(): Promise<Address[]> {
  const { data } = await apiClient.get<ApiResponse<Address[]>>('/addresses');
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load addresses');
  }
  return data.data;
}

/** Create a new shipping address. Returns the created address. */
export async function createAddress(input: CreateAddressInput): Promise<Address> {
  const { data } = await apiClient.post<ApiResponse<Address>>('/addresses', input);
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to create address');
  }
  return data.data;
}

/** Partially update an address (incl. promoting it to default). */
export async function updateAddress(
  id: string,
  input: UpdateAddressInput,
): Promise<Address> {
  const { data } = await apiClient.patch<ApiResponse<Address>>(`/addresses/${id}`, input);
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to update address');
  }
  return data.data;
}

/** Delete a saved address. */
export async function deleteAddress(id: string): Promise<void> {
  const { data } = await apiClient.delete<ApiResponse<{ id: string }>>(`/addresses/${id}`);
  if (!data.success) {
    throw new Error(data.error ?? data.message ?? 'Failed to delete address');
  }
}
