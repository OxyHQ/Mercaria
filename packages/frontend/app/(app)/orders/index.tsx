import { useState } from "react";
import { View, Pressable } from "react-native";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import { ChevronRight, Package } from "lucide-react-native";
import type { OrderStatus, OrderSummary } from "@mercaria/shared-types";
import {
  Button,
  PriceDisplay,
  SectionHeader,
  Text,
  commercialSellerLabel,
  formatDate,
} from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { ReviewEligibilityPrompts } from "@/components/reviews/ReviewEligibilityPrompts";
import { useOrders } from "@/lib/hooks/use-orders";
import { useTranslation } from "@/lib/i18n";

/**
 * Friendly label per order status, as translation KEYS.
 *
 * A module-scope `const` is evaluated at import, before the locale store has
 * rehydrated, so a sentence here would freeze whichever language loaded first.
 * The keys are literal so the i18n guard can see each leaf is referenced, and
 * they are resolved at the render site.
 */
const STATUS_LABEL_KEY: Record<OrderStatus, string> = {
  pending_payment: "orders.status.pendingPayment",
  paid: "orders.status.paid",
  processing: "orders.status.processing",
  shipped: "orders.status.shipped",
  delivered: "orders.status.delivered",
  cancelled: "orders.status.cancelled",
  refunded: "orders.status.refunded",
  partially_refunded: "orders.status.partiallyRefunded",
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
  const { t, locale } = useTranslation();
  // From the order's own commercial presentation (#129): a `platform` order has
  // neither `store` nor `seller`, so the old coalesce left Mercaria's own sales
  // with no seller in the list at all.
  const sellerName = commercialSellerLabel(t, order.commercial);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("orders.row.openA11yLabel", { number: order.orderNumber })}
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-4 web:hover:opacity-90 active:opacity-90"
    >
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-bold text-foreground" numberOfLines={1}>
          {order.orderNumber}
        </Text>
        {/* ONE key for the whole line: the separators and the order of the
            three facts are not the same in every language, and the item count
            pluralises. The status is a BADGE term elsewhere on this screen, so
            it is a term here rather than an action label. */}
        <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
          {t("orders.row.meta", {
            count: order.itemCount,
            status: t(STATUS_LABEL_KEY[order.status]),
            seller: sellerName,
          })}
        </Text>
        <Text className="mt-0.5 text-xs text-muted-foreground">
          {formatDate(order.createdAt, locale)}
        </Text>
      </View>
      <PriceDisplay price={order.grandTotal.presentment} primaryClassName="text-sm font-bold" />
      <ChevronRight size={18} className="text-muted-foreground" />
    </Pressable>
  );
}

function OrdersBody() {
  const { t } = useTranslation();
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const [page, setPage] = useState(1);
  const { data, isLoading } = useOrders(page);

  const orders = data?.data ?? [];
  const pagination = data?.pagination;

  return (
    <>
      <SectionHeader title={t("orders.title")} />

      {/*
        The verified-review surface (#76 UI rule 3). Above the list because it is
        the thing with a deadline-free ask attached; it renders nothing at all
        when the buyer has no open eligibility, which is the ordinary case.
      */}
      <ReviewEligibilityPrompts />

      {!isAuthenticated ? (
        <EmptyState
          title={t("orders.empty.title")}
          subtitle={t("orders.empty.signedOutSubtitle")}
        />
      ) : isLoading && !data ? (
        <View className="gap-3 px-4 py-6">
          <View className="h-20 w-full rounded-2xl bg-muted" />
          <View className="h-20 w-full rounded-2xl bg-muted" />
          <View className="h-20 w-full rounded-2xl bg-muted" />
        </View>
      ) : orders.length === 0 ? (
        <EmptyState title={t("orders.empty.title")} subtitle={t("orders.empty.subtitle")} />
      ) : (
        <View className="gap-3 px-4">
          {orders.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              onPress={() =>
                router.push(`/orders/${order.id}`)
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
                <Text className="text-sm font-medium text-foreground">
                  {t("orders.pagination.previous")}
                </Text>
              </Button>
              <Text className="text-xs text-muted-foreground">
                {t("orders.pagination.pageOf", {
                  page: pagination.page,
                  pages: pagination.pages,
                })}
              </Text>
              <Button
                variant="outline"
                size="sm"
                disabled={!pagination.hasNextPage}
                onPress={() => setPage((p) => p + 1)}
              >
                <Text className="text-sm font-medium text-foreground">
                  {t("orders.pagination.next")}
                </Text>
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
  const { t } = useTranslation();
  return (
    <ScreenShell contentClassName="pt-5 web:max-w-[900px]">
      <Head>
        <title>{t("orders.pageTitle")}</title>
      </Head>
      <OrdersBody />
    </ScreenShell>
  );
}
