import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronRight } from "lucide-react-native";
import type { OrderSummary } from "@mercaria/shared-types";
import { Text, Button, PriceDisplay, formatDateTime, useColorScheme } from "@mercaria/ui";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import { useOrders } from "@/lib/hooks/use-orders";
import { useTranslation } from "@/lib/i18n";
import { ORDER_STATUS_LABEL_KEYS } from "@/lib/order-labels";

/** First page index (1-based). */
const FIRST_PAGE = 1;

/** Recent completed sales. Shipping is intentionally hidden for POS. */
export default function SalesScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("sales.documentTitle")}</title>
      </Head>
      <RequireStore permission="orders:read">
        {(storeId) => <Sales storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function Sales({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(FIRST_PAGE);
  const { data, isPending, isError, isFetching } = useOrders(storeId, page);

  const orders = data?.data ?? [];
  const hasNextPage = data?.pagination.hasNextPage ?? false;
  const hasPreviousPage = data?.pagination.hasPreviousPage ?? false;

  return (
    <Screen title={t("nav.sales")} subtitle={t("sales.subtitle")} action={<StoreSwitcher />}>
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title={t("sales.loadFailed")} body={t("common.pleaseTryAgain")} />
      ) : orders.length === 0 ? (
        <ScreenMessage title={t("sales.emptyTitle")} body={t("sales.emptyBody")} />
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
                <Text className="font-semibold text-foreground">{t("common.previous")}</Text>
              </Button>
              <Text className="text-sm text-muted-foreground">
                {t("sales.pageNumber", { page })}
              </Text>
              <Button
                variant="outline"
                onPress={() => setPage((p) => p + 1)}
                disabled={!hasNextPage || isFetching}
                className="flex-1"
              >
                <Text className="font-semibold text-foreground">{t("common.next")}</Text>
              </Button>
            </View>
          ) : null}
        </View>
      )}
    </Screen>
  );
}

function OrderRow({ order, storeId }: { order: OrderSummary; storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t, locale } = useTranslation();
  // Replaces a local `formatCreatedAt` that called `toLocaleString()` with no
  // locale, so the timestamp rendered in the DEVICE's language inside a sentence
  // in the app's (#529). `@mercaria/ui` owns date formatting, and this app keeps
  // no copy of it.
  const when = formatDateTime(order.createdAt, locale);
  const status = t(ORDER_STATUS_LABEL_KEYS[order.status]);

  return (
    <Pressable
      onPress={() => router.push({ pathname: "/receipt/[id]", params: { id: order.id } })}
      accessibilityRole="button"
      accessibilityLabel={t("sales.orderLabel", { number: order.orderNumber })}
      className="min-h-[64px] flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
    >
      <View className="flex-1">
        <Text className="text-base font-semibold text-foreground">{order.orderNumber}</Text>
        {/* `sales.rowMeta` NAMES the timestamp, so with no renderable one the
            status stands alone — it is already a complete translated phrase —
            rather than interpolating a null, which i18n-js renders as the
            literal `[missing "%{when}" value]`. */}
        <Text className="text-xs text-muted-foreground">
          {when === null ? status : t("sales.rowMeta", { when, status })}
        </Text>
      </View>
      <PriceDisplay price={order.grandTotal.shop} primaryClassName="text-base font-bold" />
      <ChevronRight size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}
