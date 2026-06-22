import React from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import { CheckCircle2 } from "lucide-react-native";
import type { Order } from "@mercaria/shared-types";
import { Text, Button, PriceDisplay, useColorScheme } from "@mercaria/ui";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useOrder } from "@/lib/hooks/use-orders";

/** The completed-sale receipt. Shipping is intentionally hidden for POS. */
export default function ReceiptScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return (
    <>
      <Head>
        <title>Receipt | Mercaria POS</title>
      </Head>
      <RequireStore permission="orders:read">
        {(storeId) => <Receipt storeId={storeId} orderId={id ?? ""} />}
      </RequireStore>
    </>
  );
}

function Receipt({ storeId, orderId }: { storeId: string; orderId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { data: order, isPending, isError } = useOrder(storeId, orderId);

  if (isPending) {
    return (
      <Screen title="Receipt">
        <ScreenLoading />
      </Screen>
    );
  }

  if (isError || !order) {
    return (
      <Screen title="Receipt">
        <ScreenMessage title="Couldn't load the receipt" body="The order may not be available." />
      </Screen>
    );
  }

  return (
    <Screen title="Sale complete" subtitle={`Order ${order.orderNumber}`}>
      <View className="gap-5">
        <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4">
          <CheckCircle2 size={28} color={colors.primary} />
          <View className="flex-1">
            <Text className="text-base font-semibold text-foreground">Payment recorded</Text>
            <Text className="text-sm capitalize text-muted-foreground">
              {order.sourceChannel} · {order.status}
            </Text>
          </View>
        </View>

        <OrderLines order={order} />
        <OrderTotals order={order} />

        <Button onPress={() => router.replace("/")} className="h-16">
          <Text className="text-lg font-semibold text-primary-foreground">New sale</Text>
        </Button>
      </View>
    </Screen>
  );
}

function OrderLines({ order }: { order: Order }) {
  return (
    <View className="gap-2 rounded-2xl border border-border bg-surface p-4">
      {order.items.map((item, index) => (
        <View key={`${item.variantId}-${index}`} className="flex-row items-center justify-between gap-3">
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
              {item.title}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {item.variantTitle} · ×{item.quantity}
            </Text>
          </View>
          <PriceDisplay price={item.lineTotal} />
        </View>
      ))}
    </View>
  );
}

function OrderTotals({ order }: { order: Order }) {
  const { totals } = order;
  return (
    <View className="gap-2 rounded-2xl border border-border bg-surface p-4">
      <TotalRow label="Subtotal" price={<PriceDisplay price={totals.subtotal} />} />
      {totals.discountTotal.amount > 0 ? (
        <TotalRow label="Discount" price={<PriceDisplay price={totals.discountTotal} />} />
      ) : null}
      {totals.tax.amount > 0 ? (
        <TotalRow label="Tax" price={<PriceDisplay price={totals.tax} />} />
      ) : null}
      <View className="mt-1 flex-row items-center justify-between border-t border-border pt-3">
        <Text className="text-base font-bold text-foreground">Total</Text>
        <PriceDisplay price={totals.grandTotal} primaryClassName="text-base font-bold" />
      </View>
    </View>
  );
}

function TotalRow({ label, price }: { label: string; price: React.ReactNode }) {
  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-sm text-muted-foreground">{label}</Text>
      {price}
    </View>
  );
}
