import React, { useState } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft, ChevronRight, ShoppingBag } from "lucide-react-native";
import type { OrderStatus, OrderSummary } from "@mercaria/shared-types";
import { Text, PriceDisplay, useColorScheme } from "@mercaria/ui";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import { OrderStatusBadge } from "@/components/orders/OrderStatusBadge";
import { useOrders } from "@/lib/hooks/use-orders";

const FILTERS: { key: OrderStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "paid", label: "Paid" },
  { key: "processing", label: "Processing" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
  { key: "cancelled", label: "Cancelled" },
];

export default function OrdersScreen() {
  return (
    <>
      <Head>
        <title>Orders | Mercaria Dashboard</title>
      </Head>
      <RequireStore permission="orders:read">
        {(storeId) => <OrdersBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function OrdersBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const [status, setStatus] = useState<OrderStatus | "all">("all");
  const [page, setPage] = useState(1);
  const { data, isPending, isError } = useOrders(storeId, page, status);

  return (
    <Screen title="Orders" subtitle="Fulfil and track your sales" action={<StoreSwitcher />}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-4">
        <View className="flex-row gap-2">
          {FILTERS.map((f) => {
            const active = f.key === status;
            return (
              <Pressable
                key={f.key}
                onPress={() => {
                  setStatus(f.key);
                  setPage(1);
                }}
                className={`rounded-full border px-3 py-1.5 ${
                  active ? "border-primary bg-primary" : "border-border bg-background"
                }`}
              >
                <Text className={`text-sm font-medium ${active ? "text-primary-foreground" : "text-foreground"}`}>
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title="Couldn't load orders" body="Please try again." />
      ) : (data?.data.length ?? 0) === 0 ? (
        <ScreenMessage title="No orders" body="Orders will appear here once customers buy." />
      ) : (
        <View className="gap-2">
          {data?.data.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              onPress={() => router.push(`/orders/${order.id}`)}
            />
          ))}
        </View>
      )}

      {data && data.pagination.pages > 1 ? (
        <View className="mt-4 flex-row items-center justify-center gap-4">
          <Pressable
            onPress={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="h-9 w-9 items-center justify-center rounded-lg border border-border active:opacity-70 disabled:opacity-40"
          >
            <ChevronLeft size={18} color={colors.foreground} />
          </Pressable>
          <Text className="text-sm text-muted-foreground">
            Page {data.pagination.page} of {data.pagination.pages}
          </Text>
          <Pressable
            onPress={() => setPage((p) => p + 1)}
            disabled={page >= data.pagination.pages}
            className="h-9 w-9 items-center justify-center rounded-lg border border-border active:opacity-70 disabled:opacity-40"
          >
            <ChevronRight size={18} color={colors.foreground} />
          </Pressable>
        </View>
      ) : null}
    </Screen>
  );
}

function OrderRow({ order, onPress }: { order: OrderSummary; onPress: () => void }) {
  const { colors } = useColorScheme();
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3 active:opacity-80 web:hover:border-primary"
    >
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
        <ShoppingBag size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{order.orderNumber}</Text>
        <Text className="text-xs text-muted-foreground">
          {order.itemCount} item{order.itemCount === 1 ? "" : "s"} ·{" "}
          {new Date(order.createdAt).toLocaleDateString()}
        </Text>
      </View>
      <PriceDisplay price={order.grandTotal.shop} primaryClassName="text-sm font-semibold" />
      <OrderStatusBadge status={order.status} />
    </Pressable>
  );
}
