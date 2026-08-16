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
import { OrderStatusBadge, ORDER_STATUS_LABEL_KEYS } from "@/components/orders/OrderStatusBadge";
import { useOrders } from "@/lib/hooks/use-orders";
import { useTranslation } from "@/lib/i18n";

/**
 * The status chips. Each carries a translation KEY rather than a sentence
 * (#398) — this array is evaluated at import, before the locale store has
 * rehydrated — and the status ones reuse the badge's keys so a status reads the
 * same word wherever it appears.
 */
const FILTERS: { key: OrderStatus | "all"; labelKey: string }[] = [
  { key: "all", labelKey: "common.all" },
  { key: "paid", labelKey: ORDER_STATUS_LABEL_KEYS.paid },
  { key: "processing", labelKey: ORDER_STATUS_LABEL_KEYS.processing },
  { key: "shipped", labelKey: ORDER_STATUS_LABEL_KEYS.shipped },
  { key: "delivered", labelKey: ORDER_STATUS_LABEL_KEYS.delivered },
  { key: "cancelled", labelKey: ORDER_STATUS_LABEL_KEYS.cancelled },
];

export default function OrdersScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("orders.documentTitle")}</title>
      </Head>
      <RequireStore permission="orders:read">
        {(storeId) => <OrdersBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function OrdersBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const [status, setStatus] = useState<OrderStatus | "all">("all");
  const [page, setPage] = useState(1);
  const { data, isPending, isError } = useOrders(storeId, page, status);

  return (
    <Screen title={t("orders.title")} subtitle={t("orders.subtitle")} action={<StoreSwitcher />}>
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
                  {t(f.labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title={t("orders.loadFailed")} body={t("common.pleaseTryAgain")} />
      ) : (data?.data.length ?? 0) === 0 ? (
        <ScreenMessage title={t("orders.empty.title")} body={t("orders.empty.body")} />
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
            {t("common.pageOf", {
              current: data.pagination.page,
              total: data.pagination.pages,
            })}
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
  const { t } = useTranslation();
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
          {t("orders.row.itemsPlacedOn", {
            count: order.itemCount,
            date: new Date(order.createdAt).toLocaleDateString(),
          })}
        </Text>
      </View>
      <PriceDisplay price={order.grandTotal.shop} primaryClassName="text-sm font-semibold" />
      <OrderStatusBadge status={order.status} />
    </Pressable>
  );
}
