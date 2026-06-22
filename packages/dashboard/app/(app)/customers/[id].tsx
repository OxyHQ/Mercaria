import React from "react";
import { View, Pressable } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft, User } from "lucide-react-native";
import type { Customer, OrderSummary } from "@mercaria/shared-types";
import { Text, PriceDisplay, useColorScheme } from "@mercaria/ui";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { OrderStatusBadge } from "@/components/orders/OrderStatusBadge";
import { useCustomer, useCustomerOrders } from "@/lib/hooks/use-customers";

export default function CustomerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Head>
        <title>Customer | Mercaria Dashboard</title>
      </Head>
      <RequireStore permission="customers:read">
        {(storeId) => <CustomerDetailBody storeId={storeId} customerId={String(id)} />}
      </RequireStore>
    </>
  );
}

function CustomerDetailBody({ storeId, customerId }: { storeId: string; customerId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const customer = useCustomer(storeId, customerId);
  const orders = useCustomerOrders(storeId, customerId);

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">Back</Text>
    </Pressable>
  );

  if (customer.isPending) {
    return (
      <Screen title="Customer" action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (customer.isError || !customer.data) {
    return (
      <Screen title="Customer" action={back}>
        <ScreenMessage title="Couldn't load customer" body="Please try again." />
      </Screen>
    );
  }

  const c = customer.data;
  const name = c.displayName ?? c.email ?? (c.isWalkIn ? "Walk-in customer" : "Customer");

  return (
    <Screen title={name} subtitle="Customer detail" action={back}>
      <View className="gap-5">
        <CustomerCard customer={c} name={name} />
        <View className="rounded-2xl border border-border bg-surface p-4">
          <Text className="mb-3 text-sm font-semibold text-foreground">Orders</Text>
          {orders.isPending ? (
            <ScreenLoading />
          ) : (orders.data?.length ?? 0) === 0 ? (
            <Text className="text-sm text-muted-foreground">No orders yet.</Text>
          ) : (
            <View className="gap-2">
              {orders.data?.map((order) => (
                <OrderRow key={order.id} order={order} onPress={() => router.push(`/orders/${order.id}`)} />
              ))}
            </View>
          )}
        </View>
      </View>
    </Screen>
  );
}

function CustomerCard({ customer, name }: { customer: Customer; name: string }) {
  const { colors } = useColorScheme();
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <View className="flex-row items-center gap-3">
        <View className="h-12 w-12 items-center justify-center rounded-full bg-muted">
          <User size={22} color={colors.mutedForeground} />
        </View>
        <View className="flex-1">
          <Text className="text-base font-semibold text-foreground">{name}</Text>
          {customer.email ? (
            <Text className="text-sm text-muted-foreground">{customer.email}</Text>
          ) : null}
          {customer.phone ? (
            <Text className="text-sm text-muted-foreground">{customer.phone}</Text>
          ) : null}
        </View>
      </View>
      <View className="mt-4 flex-row gap-4">
        <View className="flex-1">
          <Text className="text-xs uppercase text-muted-foreground">Orders</Text>
          <Text className="text-lg font-bold text-foreground">{customer.stats.orderCount}</Text>
        </View>
        <View className="flex-1">
          <Text className="text-xs uppercase text-muted-foreground">Lifetime spend</Text>
          <PriceDisplay price={customer.stats.totalSpent} primaryClassName="text-lg font-bold" />
        </View>
      </View>
    </View>
  );
}

function OrderRow({ order, onPress }: { order: OrderSummary; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center justify-between gap-3 rounded-xl border border-border p-3 active:opacity-80"
    >
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{order.orderNumber}</Text>
        <Text className="text-xs text-muted-foreground">
          {new Date(order.createdAt).toLocaleDateString()}
        </Text>
      </View>
      <PriceDisplay price={order.grandTotal} primaryClassName="text-sm font-semibold" />
      <OrderStatusBadge status={order.status} />
    </Pressable>
  );
}
