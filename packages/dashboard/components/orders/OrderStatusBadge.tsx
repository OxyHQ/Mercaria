import React from "react";
import { View } from "react-native";
import type { OrderStatus } from "@mercaria/shared-types";
import { Text } from "@mercaria/ui";
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
  cancelled: "orders.status.cancelled",
  refunded: "orders.status.refunded",
  partially_refunded: "orders.status.partiallyRefunded",
};

/** Tailwind classes per status: `<bg> <text>`. */
const STYLES: Record<OrderStatus, string> = {
  pending_payment: "bg-muted text-muted-foreground",
  paid: "bg-primary/10 text-primary",
  processing: "bg-primary/10 text-primary",
  shipped: "bg-primary/10 text-primary",
  delivered: "bg-primary/10 text-primary",
  cancelled: "bg-muted text-muted-foreground",
  refunded: "bg-destructive/10 text-destructive",
  partially_refunded: "bg-destructive/10 text-destructive",
};

/** Small pill rendering an order's lifecycle status. */
export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const { t } = useTranslation();
  const [bg, text] = STYLES[status].split(" ");
  return (
    <View className={`rounded-full px-2 py-1 ${bg}`}>
      <Text className={`text-[10px] font-semibold ${text}`}>{t(ORDER_STATUS_LABEL_KEYS[status])}</Text>
    </View>
  );
}
