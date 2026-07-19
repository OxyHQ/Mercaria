import { useState } from "react";
import { View, Pressable } from "react-native";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import { ChevronRight, Package } from "lucide-react-native";
import type { OrderStatus, OrderSummary } from "@mercaria/shared-types";
import { Button, PriceDisplay, SectionHeader, Text } from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { useOrders } from "@/lib/hooks/use-orders";

/** Friendly label per order status. */
const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: "Pending payment",
  paid: "Paid",
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
};

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View className="items-center px-8 py-24">
      <View className="mb-4 h-16 w-16 items-center justify-center rounded-full bg-secondary">
        <Package size={28} className="text-muted-foreground" />
      </View>
      <Text className="text-center text-lg font-bold text-foreground">{title}</Text>
      <Text className="mt-1 text-center text-sm text-muted-foreground">{subtitle}</Text>
    </View>
  );
}

function OrderRow({ order, onPress }: { order: OrderSummary; onPress: () => void }) {
  const sellerName = order.store?.name ?? order.seller?.displayName;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open order ${order.orderNumber}`}
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-4 web:hover:opacity-90 active:opacity-90"
    >
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-bold text-foreground" numberOfLines={1}>
          {order.orderNumber}
        </Text>
        <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
          {STATUS_LABEL[order.status]}
          {sellerName ? ` · ${sellerName}` : ""}
          {` · ${order.itemCount} item${order.itemCount === 1 ? "" : "s"}`}
        </Text>
        <Text className="mt-0.5 text-xs text-muted-foreground">
          {new Date(order.createdAt).toLocaleDateString()}
        </Text>
      </View>
      <PriceDisplay price={order.grandTotal.presentment} primaryClassName="text-sm font-bold" />
      <ChevronRight size={18} className="text-muted-foreground" />
    </Pressable>
  );
}

function OrdersBody() {
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const [page, setPage] = useState(1);
  const { data, isLoading } = useOrders(page);

  const orders = data?.data ?? [];
  const pagination = data?.pagination;

  return (
    <>
      <SectionHeader title="Your orders" />

      {!isAuthenticated ? (
        <EmptyState title="No orders yet" subtitle="Sign in to see your order history." />
      ) : isLoading && !data ? (
        <View className="gap-3 px-4 py-6">
          <View className="h-20 w-full rounded-2xl bg-muted" />
          <View className="h-20 w-full rounded-2xl bg-muted" />
          <View className="h-20 w-full rounded-2xl bg-muted" />
        </View>
      ) : orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          subtitle="When you place an order it will show up here."
        />
      ) : (
        <View className="gap-3 px-4">
          {orders.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              onPress={() =>
                router.push(`/orders/${order.id}` as Parameters<typeof router.push>[0])
              }
            />
          ))}

          {pagination && pagination.pages > 1 ? (
            <View className="mt-2 flex-row items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                disabled={!pagination.hasPreviousPage}
                onPress={() => setPage((p) => Math.max(1, p - 1))}
              >
                <Text className="text-sm font-medium text-foreground">Previous</Text>
              </Button>
              <Text className="text-xs text-muted-foreground">
                Page {pagination.page} of {pagination.pages}
              </Text>
              <Button
                variant="outline"
                size="sm"
                disabled={!pagination.hasNextPage}
                onPress={() => setPage((p) => p + 1)}
              >
                <Text className="text-sm font-medium text-foreground">Next</Text>
              </Button>
            </View>
          ) : null}
        </View>
      )}

      <View className="h-24" />
    </>
  );
}

export default function OrdersScreen() {
  return (
    <ScreenShell contentClassName="pt-5 web:max-w-[900px]">
      <Head>
        <title>Your orders — Mercaria</title>
      </Head>
      <OrdersBody />
    </ScreenShell>
  );
}
