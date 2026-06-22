import React from "react";
import { View } from "react-native";
import type { OrderStatus } from "@mercaria/shared-types";
import { Text } from "@mercaria/ui";

const LABELS: Record<OrderStatus, string> = {
  pending_payment: "Pending",
  paid: "Paid",
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
  refunded: "Refunded",
  partially_refunded: "Part. refunded",
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
  const [bg, text] = STYLES[status].split(" ");
  return (
    <View className={`rounded-full px-2 py-1 ${bg}`}>
      <Text className={`text-[10px] font-semibold ${text}`}>{LABELS[status]}</Text>
    </View>
  );
}
