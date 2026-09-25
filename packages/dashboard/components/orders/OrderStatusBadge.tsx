import React from "react";
import { Badge } from "@oxy.so/bloom/badge";
import type { AccentTone } from "@oxy.so/bloom/theme";
import type { OrderStatus } from "@mercaria/shared-types";
import { useTranslation } from "@/lib/i18n";

/**
 * Translation KEYS per status, not sentences (#398).
 *
 * This module is evaluated once at import, before the locale store has
 * rehydrated, so a resolved label here would freeze whatever language loaded
 * first. The badge calls `t(LABEL_KEYS[status])` and therefore re-renders when
 * the locale changes. The status VALUES are untouched — they are the API's
 * vocabulary, not copy.
 *
 * The same keys carry the filter chips on the orders list, so a status is
 * spelled one way across the whole area.
 */
export const ORDER_STATUS_LABEL_KEYS: Record<OrderStatus, string> = {
  pending_payment: "orders.status.pendingPayment",
  paid: "orders.status.paid",
  processing: "orders.status.processing",
  shipped: "orders.status.shipped",
  delivered: "orders.status.delivered",
  digitally_delivered: "orders.status.digitallyDelivered",
  cancelled: "orders.status.cancelled",
  refunded: "orders.status.refunded",
  partially_refunded: "orders.status.partiallyRefunded",
};

/** Bloom accent tone per status, painted as a `subtle` Bloom `Badge`. */
const TONES: Record<OrderStatus, AccentTone> = {
  pending_payment: "default",
  paid: "primary",
  processing: "primary",
  shipped: "primary",
  delivered: "primary",
  // The same pill as `delivered`: both mean the buyer has what they paid for, and
  // a different colour would imply a difference a merchant has to act on.
  digitally_delivered: "primary",
  cancelled: "default",
  refunded: "error",
  partially_refunded: "error",
};

/** Small pill rendering an order's lifecycle status. */
export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const { t } = useTranslation();
  return (
    <Badge
      size="label-small"
      variant="subtle"
      color={TONES[status]}
      content={t(ORDER_STATUS_LABEL_KEYS[status])}
    />
  );
}
