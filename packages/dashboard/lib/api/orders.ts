import type {
  ApiResponse,
  PaginatedResponse,
  MerchantOrder,
  MerchantOrderSummary,
  OrderStatus,
  Refund,
  CreateRefundInput,
  CancelPickupInput,
  CollectPickupInput,
  MarkPickupReadyInput,
  OrderPickup,
  PickupCollectionCode,
  PickupCollectionEvent,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";
import type { StoreStats } from "./types";

const base = (storeId: string) => `/admin/stores/${storeId}/orders`;

/** Status transitions the fulfilment UI may drive (subset of `OrderStatus`). */
export type FulfillmentStatus = "processing" | "shipped" | "delivered" | "cancelled";

/** GET orders — paginated `OrderSummary` list, optionally filtered by status. */
export async function fetchOrders(
  storeId: string,
  params: { page?: number; limit?: number; status?: OrderStatus } = {},
): Promise<PaginatedResponse<MerchantOrderSummary>> {
  const { data } = await apiClient.get<PaginatedResponse<MerchantOrderSummary>>(base(storeId), { params });
  return data;
}

/** GET a single hydrated order. */
export async function fetchOrder(storeId: string, id: string): Promise<MerchantOrder> {
  const { data } = await apiClient.get<ApiResponse<MerchantOrder>>(`${base(storeId)}/${id}`);
  return unwrap(data);
}

/** GET the store order dashboard stats. */
export async function fetchStoreStats(storeId: string): Promise<StoreStats> {
  const { data } = await apiClient.get<ApiResponse<StoreStats>>(`${base(storeId)}/stats`);
  return unwrap(data);
}

/** PATCH an order's status (fulfilment transition + optional tracking/note). */
export async function patchOrderStatus(
  storeId: string,
  id: string,
  body: { status: FulfillmentStatus; trackingNumber?: string; note?: string },
): Promise<MerchantOrder> {
  const { data } = await apiClient.patch<ApiResponse<MerchantOrder>>(`${base(storeId)}/${id}/status`, body);
  return unwrap(data);
}

/** POST a refund against an order (amounts computed server-side). */
export async function createRefund(
  storeId: string,
  id: string,
  input: CreateRefundInput,
): Promise<Refund> {
  const { data } = await apiClient.post<ApiResponse<Refund>>(`${base(storeId)}/${id}/refunds`, input);
  return unwrap(data);
}

/** GET the refunds processed against an order. */
export async function fetchOrderRefunds(storeId: string, id: string): Promise<Refund[]> {
  const { data } = await apiClient.get<ApiResponse<Refund[]>>(`${base(storeId)}/${id}/refunds`);
  return unwrap(data);
}

/* -------------------------------------------------------------------------- */
/*  The collection desk (#93)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One order's collection, as a member of staff sees it.
 *
 * There is deliberately NO field carrying the buyer's current code, because
 * there is no route that returns one (`routes/admin/orders.ts`): a code is the
 * buyer's, and a desk verifies one by having it presented. Keeping the client
 * type free of it is what stops somebody adding a "show the code" button and
 * discovering the endpoint does not exist only after designing the screen.
 */
export interface OrderPickupDesk {
  readonly pickup: OrderPickup;
  readonly events: readonly PickupCollectionEvent[];
}

const pickupBase = (storeId: string, orderId: string) =>
  `${base(storeId)}/${orderId}/pickup`;

/** GET the collection snapshot and its audited trail. 404s on a delivery order. */
export async function fetchOrderPickup(
  storeId: string,
  orderId: string,
): Promise<OrderPickupDesk> {
  const { data } = await apiClient.get<ApiResponse<OrderPickupDesk>>(
    pickupBase(storeId, orderId),
  );
  return unwrap(data);
}

/** POST … /pickup/ready — the parcel is on the shelf behind the counter. */
export async function markPickupReady(
  storeId: string,
  orderId: string,
  input: MarkPickupReadyInput,
): Promise<OrderPickup> {
  const { data } = await apiClient.post<ApiResponse<{ pickup: OrderPickup }>>(
    `${pickupBase(storeId, orderId)}/ready`,
    input,
  );
  return unwrap(data).pickup;
}

/**
 * POST … /pickup/collect — the handover happened.
 *
 * Takes the code the person PRESENTED, or an `override` with a reason. The
 * override is the audited fallback #93 verification rule 7 asks for: a code
 * that will not scan must not strand a customer at a counter, and the record of
 * who waved it through is what makes that safe rather than a hole.
 */
export async function collectPickup(
  storeId: string,
  orderId: string,
  input: CollectPickupInput,
): Promise<OrderPickup> {
  const { data } = await apiClient.post<ApiResponse<{ pickup: OrderPickup }>>(
    `${pickupBase(storeId, orderId)}/collect`,
    input,
  );
  return unwrap(data).pickup;
}

/**
 * POST … /pickup/cancel — withdraw the handover.
 *
 * This moves NO money and NO stock (`docs/pickup.md` §10). The units were
 * committed when the order was paid, and refunding is the separate,
 * money-moving decision on the order itself.
 */
export async function cancelPickup(
  storeId: string,
  orderId: string,
  input: CancelPickupInput,
): Promise<OrderPickup> {
  const { data } = await apiClient.post<ApiResponse<{ pickup: OrderPickup }>>(
    `${pickupBase(storeId, orderId)}/cancel`,
    input,
  );
  return unwrap(data).pickup;
}

/**
 * POST … /pickup/rotate-code — invalidate every outstanding copy at once.
 *
 * The ONE call that returns a code, and it returns the NEW one because the shop
 * is the party that has to tell the customer it changed. There is no grace
 * window: the previous code stops working immediately.
 */
export async function rotateCollectionCode(
  storeId: string,
  orderId: string,
  reason: string,
): Promise<PickupCollectionCode> {
  const { data } = await apiClient.post<ApiResponse<{ code: PickupCollectionCode }>>(
    `${pickupBase(storeId, orderId)}/rotate-code`,
    { reason },
  );
  return unwrap(data).code;
}
