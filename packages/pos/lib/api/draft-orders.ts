import type {
  ApiResponse,
  DraftOrder,
  CreateDraftOrderInput,
  AddDraftLineInput,
  Order,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/draft-orders`;

/** POST — open a new draft order (optionally attaching a location/customer). */
export async function createDraftOrder(
  storeId: string,
  input: CreateDraftOrderInput,
): Promise<DraftOrder> {
  const { data } = await apiClient.post<ApiResponse<DraftOrder>>(base(storeId), input);
  return unwrap(data);
}

/** POST /:id/lines — add a line to the draft (re-prices the draft). */
export async function addDraftLine(
  storeId: string,
  draftId: string,
  input: AddDraftLineInput,
): Promise<DraftOrder> {
  const { data } = await apiClient.post<ApiResponse<DraftOrder>>(
    `${base(storeId)}/${draftId}/lines`,
    input,
  );
  return unwrap(data);
}

/** POST /:id/discounts — replace the draft's applied discount codes. */
export async function applyDraftDiscounts(
  storeId: string,
  draftId: string,
  codes: string[],
): Promise<DraftOrder> {
  const { data } = await apiClient.post<ApiResponse<DraftOrder>>(
    `${base(storeId)}/${draftId}/discounts`,
    { codes },
  );
  return unwrap(data);
}

/** POST /:id/customer — attach a customer to the draft. */
export async function setDraftCustomer(
  storeId: string,
  draftId: string,
  customerId: string,
): Promise<DraftOrder> {
  const { data } = await apiClient.post<ApiResponse<DraftOrder>>(
    `${base(storeId)}/${draftId}/customer`,
    { customerId },
  );
  return unwrap(data);
}

/** POST /:id/complete — take the sale; converts the draft into a paid `Order`. */
export async function completeDraftOrder(
  storeId: string,
  draftId: string,
): Promise<Order> {
  const { data } = await apiClient.post<ApiResponse<Order>>(
    `${base(storeId)}/${draftId}/complete`,
    {},
  );
  return unwrap(data);
}

/** DELETE /:id — cancel the open draft (best-effort cleanup on a failed sale). */
export async function cancelDraftOrder(
  storeId: string,
  draftId: string,
): Promise<DraftOrder> {
  const { data } = await apiClient.delete<ApiResponse<DraftOrder>>(
    `${base(storeId)}/${draftId}`,
  );
  return unwrap(data);
}
