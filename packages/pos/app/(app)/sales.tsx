import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronRight } from "lucide-react-native";
import type { OrderSummary } from "@mercaria/shared-types";
import { Text, Button, PriceDisplay, useColorScheme } from "@mercaria/ui";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import { useOrders } from "@/lib/hooks/use-orders";

/** First page index (1-based). */
const FIRST_PAGE = 1;

/** Recent completed sales. Shipping is intentionally hidden for POS. */
export default function SalesScreen() {
  return (
    <>
      <Head>
        <title>Sales | Mercaria POS</title>
      </Head>
      <RequireStore permission="orders:read">
        {(storeId) => <Sales storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function Sales({ storeId }: { storeId: string }) {
  const [page, setPage] = useState(FIRST_PAGE);
  const { data, isPending, isError, isFetching } = useOrders(storeId, page);

  const orders = data?.data ?? [];
  const hasNextPage = data?.pagination.hasNextPage ?? false;
  const hasPreviousPage = data?.pagination.hasPreviousPage ?? false;

  return (
    <Screen title="Sales" subtitle="Recent orders" action={<StoreSwitcher />}>
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title="Couldn't load sales" body="Please try again." />
      ) : orders.length === 0 ? (
        <ScreenMessage title="No sales yet" body="Completed sales will appear here." />
      ) : (
        <View className="gap-2">
          {orders.map((order) => (
            <OrderRow key={order.id} order={order} storeId={storeId} />
          ))}

          {(hasPreviousPage || hasNextPage) ? (
            <View className="mt-4 flex-row items-center justify-between gap-3">
              <Button
                variant="outline"
                onPress={() => setPage((p) => Math.max(FIRST_PAGE, p - 1))}
                disabled={!hasPreviousPage || isFetching}
                className="flex-1"
              >
                <Text className="font-semibold text-foreground">Previous</Text>
              </Button>
              <Text className="text-sm text-muted-foreground">Page {page}</Text>
              <Button
                variant="outline"
                onPress={() => setPage((p) => p + 1)}
                disabled={!hasNextPage || isFetching}
                className="flex-1"
              >
                <Text className="font-semibold text-foreground">Next</Text>
              </Button>
            </View>
          ) : null}
        </View>
      )}
    </Screen>
  );
}

/** Format an ISO timestamp to a short, locale-aware date-time label. */
function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function OrderRow({ order, storeId }: { order: OrderSummary; storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();

  return (
    <Pressable
      onPress={() => router.push({ pathname: "/receipt/[id]", params: { id: order.id } })}
      accessibilityRole="button"
      accessibilityLabel={`Order ${order.orderNumber}`}
      className="min-h-[64px] flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
    >
      <View className="flex-1">
        <Text className="text-base font-semibold text-foreground">{order.orderNumber}</Text>
        <Text className="text-xs capitalize text-muted-foreground">
          {formatCreatedAt(order.createdAt)} · {order.status.replace("_", " ")}
        </Text>
      </View>
      <PriceDisplay price={order.grandTotal} primaryClassName="text-base font-bold" />
      <ChevronRight size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}
