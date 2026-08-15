import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import type {
  PaginatedResponse,
  MerchantOrder,
  MerchantOrderSummary,
  OrderStatus,
  Refund,
  CreateRefundInput,
  OrderPickup,
  PickupCollectionCode,
} from "@mercaria/shared-types";
import {
  fetchOrders,
  fetchOrder,
  fetchStoreStats,
  patchOrderStatus,
  createRefund,
  fetchOrderRefunds,
  fetchOrderPickup,
  markPickupReady,
  collectPickup,
  cancelPickup,
  rotateCollectionCode,
  type FulfillmentStatus,
  type OrderPickupDesk,
} from "../api/orders";
import { queryKeys } from "../queryKeys";
import type { StoreStats } from "../api/types";

const PAGE_LIMIT = 20;

/** Paginated order list (optionally filtered by status). */
export function useOrders(storeId: string, page: number, status: OrderStatus | "all") {
  return useQuery<PaginatedResponse<MerchantOrderSummary>>({
    queryKey: queryKeys.orders.list(storeId, page, status),
    queryFn: () =>
      fetchOrders(storeId, {
        page,
        limit: PAGE_LIMIT,
        ...(status !== "all" ? { status } : {}),
      }),
    enabled: Boolean(storeId),
    placeholderData: keepPreviousData,
  });
}

/** A single hydrated order. */
export function useOrder(storeId: string, orderId: string) {
  return useQuery<MerchantOrder>({
    queryKey: queryKeys.orders.detail(storeId, orderId),
    queryFn: () => fetchOrder(storeId, orderId),
    enabled: Boolean(storeId) && Boolean(orderId),
  });
}

/** The store order dashboard stats. */
export function useStoreStats(storeId: string) {
  return useQuery<StoreStats>({
    queryKey: queryKeys.orders.stats(storeId),
    queryFn: () => fetchStoreStats(storeId),
    enabled: Boolean(storeId),
  });
}

/** Refunds processed against an order. */
export function useOrderRefunds(storeId: string, orderId: string) {
  return useQuery<Refund[]>({
    queryKey: queryKeys.orders.refunds(storeId, orderId),
    queryFn: () => fetchOrderRefunds(storeId, orderId),
    enabled: Boolean(storeId) && Boolean(orderId),
  });
}

function invalidateOrders(
  queryClient: ReturnType<typeof useQueryClient>,
  storeId: string,
  orderId: string,
) {
  queryClient.invalidateQueries({ queryKey: ["stores", storeId, "orders"] });
  queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(storeId, orderId) });
}

/** Drive an order status transition (fulfilment). */
export function usePatchOrderStatus(storeId: string, orderId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { status: FulfillmentStatus; trackingNumber?: string; note?: string }) =>
      patchOrderStatus(storeId, orderId, body),
    onSuccess: () => invalidateOrders(queryClient, storeId, orderId),
  });
}

/** Process a refund against an order. */
export function useCreateRefund(storeId: string, orderId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRefundInput) => createRefund(storeId, orderId, input),
    onSuccess: () => {
      invalidateOrders(queryClient, storeId, orderId);
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.refunds(storeId, orderId) });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  The collection desk (#93)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One order's collection snapshot and audited trail.
 *
 * `retry: false` and no error surfacing by the caller: a 404 here is the
 * ORDINARY answer for a delivery order, not a failure. The desk simply does not
 * render, which is right — an order that is being posted has no counter.
 */
export function useOrderPickup(storeId: string, orderId: string) {
  return useQuery<OrderPickupDesk>({
    queryKey: queryKeys.orders.pickup(storeId, orderId),
    queryFn: () => fetchOrderPickup(storeId, orderId),
    enabled: Boolean(storeId) && Boolean(orderId),
    retry: false,
  });
}

/**
 * Every desk action, sharing one invalidation.
 *
 * A single mutation over a discriminated action rather than four hooks: each
 * one refreshes exactly the same two things — the collection and its trail —
 * and a refusal is as much a trail entry as a success, so even a failed attempt
 * must re-read it.
 */
export type PickupDeskAction =
  | { kind: "ready"; note?: string }
  | { kind: "collect"; code?: string; overrideReason?: string }
  | { kind: "cancel"; reason: string };

export function usePickupDeskAction(storeId: string, orderId: string) {
  const queryClient = useQueryClient();
  return useMutation<OrderPickup, Error, PickupDeskAction>({
    mutationFn: (action) => {
      if (action.kind === "ready") {
        return markPickupReady(storeId, orderId, {
          ...(action.note === undefined ? {} : { note: action.note }),
        });
      }
      if (action.kind === "cancel") {
        return cancelPickup(storeId, orderId, { reason: action.reason });
      }
      return collectPickup(storeId, orderId, {
        ...(action.code === undefined ? {} : { code: action.code }),
        ...(action.overrideReason === undefined
          ? {}
          : { override: { reason: action.overrideReason } }),
      });
    },
    // `onSettled`, not `onSuccess`: a REFUSED validation is an audit entry too,
    // and a desk that only refreshed on success would leave the person who was
    // just turned away invisible in the trail on screen.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders.pickup(storeId, orderId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(storeId, orderId) });
    },
  });
}

/** Rotate the code. The ONE call that hands a merchant one, and it is the NEW one. */
export function useRotateCollectionCode(storeId: string, orderId: string) {
  const queryClient = useQueryClient();
  return useMutation<PickupCollectionCode, Error, string>({
    mutationFn: (reason) => rotateCollectionCode(storeId, orderId, reason),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders.pickup(storeId, orderId) });
    },
  });
}
