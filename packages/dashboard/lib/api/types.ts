import type { Money, OrderStatus } from "@mercaria/shared-types";

/**
 * Dashboard order stats returned by `GET /admin/stores/:storeId/orders/stats`.
 *
 * This shape mirrors the backend `storeStats` service return (per-status order
 * counts, paid-order revenue in the store's default currency, and the number of
 * tracked variants at or below the low-stock threshold). It is a backend-local
 * interface (not exported from `@mercaria/shared-types`), so the dashboard
 * declares the matching wire type here.
 */
export interface StoreStats {
  counts: Record<OrderStatus, number>;
  revenue: Money;
  lowStockVariantCount: number;
}
