import type {
  ApiResponse,
  PaginatedResponse,
  Customer,
  CreateCustomerInput,
  UpdateCustomerInput,
  OrderSummary,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/customers`;

/** GET customers — paginated, optionally filtered by `search`. */
export async function fetchCustomers(
  storeId: string,
  params: { page?: number; limit?: number; search?: string } = {},
): Promise<PaginatedResponse<Customer>> {
  const { data } = await apiClient.get<PaginatedResponse<Customer>>(base(storeId), { params });
  return data;
}

/** GET a single customer. */
export async function fetchCustomer(storeId: string, id: string): Promise<Customer> {
  const { data } = await apiClient.get<ApiResponse<Customer>>(`${base(storeId)}/${id}`);
  return unwrap(data);
}

/** GET a customer's order history. */
export async function fetchCustomerOrders(storeId: string, id: string): Promise<OrderSummary[]> {
  const { data } = await apiClient.get<ApiResponse<OrderSummary[]>>(`${base(storeId)}/${id}/orders`);
  return unwrap(data);
}

/** POST a new customer. */
export async function createCustomer(
  storeId: string,
  input: CreateCustomerInput,
): Promise<Customer> {
  const { data } = await apiClient.post<ApiResponse<Customer>>(base(storeId), input);
  return unwrap(data);
}

/** PATCH a customer. */
export async function updateCustomer(
  storeId: string,
  id: string,
  input: UpdateCustomerInput,
): Promise<Customer> {
  const { data } = await apiClient.patch<ApiResponse<Customer>>(`${base(storeId)}/${id}`, input);
  return unwrap(data);
}
