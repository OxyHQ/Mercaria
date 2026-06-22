import type {
  ApiResponse,
  PaginatedResponse,
  Customer,
  CreateCustomerInput,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/customers`;

/** GET customers — paginated, optionally filtered by `search`. */
export async function fetchCustomers(
  storeId: string,
  params: { search?: string } = {},
): Promise<PaginatedResponse<Customer>> {
  const { data } = await apiClient.get<PaginatedResponse<Customer>>(base(storeId), {
    params,
  });
  return data;
}

/**
 * POST a new customer. A WALK-IN is just a customer created with no `oxyUserId`
 * (the server sets `isWalkIn` automatically when none is supplied).
 */
export async function createCustomer(
  storeId: string,
  input: CreateCustomerInput,
): Promise<Customer> {
  const { data } = await apiClient.post<ApiResponse<Customer>>(base(storeId), input);
  return unwrap(data);
}
