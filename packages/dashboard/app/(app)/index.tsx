import React from "react";
import { View } from "react-native";
import Head from "expo-router/head";
import type { Money, OrderStatus, ReportSummary, SalesReportPoint, TopProduct } from "@mercaria/shared-types";
import { Text, PriceDisplay, useColorScheme } from "@mercaria/ui";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import { useReportSummary, useSalesReport, useTopProducts } from "@/lib/hooks/use-reports";
import { useStoreStats } from "@/lib/hooks/use-orders";
import { useTranslation } from "@/lib/i18n";

export default function DashboardScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("home.documentTitle")}</title>
      </Head>
      <Screen
        title={t("nav.dashboard")}
        subtitle={t("home.subtitle")}
        action={<StoreSwitcher />}
      >
        <RequireStore permission="stats:read">
          {(storeId) => <DashboardBody storeId={storeId} />}
        </RequireStore>
      </Screen>
    </>
  );
}

function DashboardBody({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const summary = useReportSummary(storeId);
  const sales = useSalesReport(storeId, "day");
  const top = useTopProducts(storeId);
  const stats = useStoreStats(storeId);

  if (summary.isPending) {
    return <ScreenLoading />;
  }
  if (summary.isError || !summary.data) {
    return <ScreenMessage title={t("home.reportsError")} body={t("common.pleaseTryAgain")} />;
  }

  return (
    <View className="gap-6">
      <SummaryCards summary={summary.data} />
      {sales.data ? <SalesChart points={sales.data} /> : null}
      <View className="flex-col gap-6 md:flex-row">
        <View className="flex-1">
          <StatusBreakdown byStatus={summary.data.byStatus} />
        </View>
        <View className="flex-1">
          {top.data ? <TopProductsList products={top.data} /> : null}
        </View>
      </View>
      {stats.data ? (
        <LowStockCard count={stats.data.lowStockVariantCount} />
      ) : null}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <View className="flex-1 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </Text>
      <View className="mt-2">{value}</View>
    </View>
  );
}

function MoneyStat({ amount }: { amount: Money }) {
  return <PriceDisplay price={amount} primaryClassName="text-xl font-bold" />;
}

function SummaryCards({ summary }: { summary: ReportSummary }) {
  const { t } = useTranslation();
  return (
    <View className="flex-col gap-3 md:flex-row">
      <Stat label={t("home.stats.revenue")} value={<MoneyStat amount={summary.revenue} />} />
      <Stat
        label={t("home.stats.paidOrders")}
        value={<Text className="text-xl font-bold text-foreground">{summary.paidOrderCount}</Text>}
      />
      <Stat
        label={t("home.stats.averageOrder")}
        value={<MoneyStat amount={summary.averageOrderValue} />}
      />
      <Stat label={t("home.stats.refunds")} value={<MoneyStat amount={summary.refundTotal} />} />
    </View>
  );
}

function SalesChart({ points }: { points: SalesReportPoint[] }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const max = Math.max(1, ...points.map((p) => p.revenue.amount));

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-4 text-sm font-semibold text-foreground">{t("home.sales.title")}</Text>
      {points.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{t("home.sales.empty")}</Text>
      ) : (
        <View className="h-40 flex-row items-end gap-1">
          {points.map((p) => {
            const heightPct = Math.round((p.revenue.amount / max) * 100);
            return (
              <View key={p.bucket} className="flex-1 items-center justify-end">
                <View
                  style={{
                    height: `${Math.max(2, heightPct)}%`,
                    backgroundColor: colors.primary,
                    width: "70%",
                    borderRadius: 4,
                  }}
                />
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

/**
 * Translation KEYS rather than sentences (#398): this map is evaluated once at
 * import, before the locale store has rehydrated, so a resolved label here would
 * freeze whatever language loaded first. The breakdown resolves them at the use
 * site, so the card re-renders when the locale changes.
 *
 * These are the FULL labels this card shows; `OrderStatusBadge`'s abbreviated
 * pill copy ("Pending", "Part. refunded") is a different set of strings and
 * keeps its own keys.
 */
const STATUS_LABEL_KEYS: Record<OrderStatus, string> = {
  pending_payment: "home.orderStatus.pendingPayment",
  paid: "home.orderStatus.paid",
  processing: "home.orderStatus.processing",
  shipped: "home.orderStatus.shipped",
  delivered: "home.orderStatus.delivered",
  cancelled: "home.orderStatus.cancelled",
  refunded: "home.orderStatus.refunded",
  partially_refunded: "home.orderStatus.partiallyRefunded",
};

function StatusBreakdown({ byStatus }: { byStatus: Record<OrderStatus, number> }) {
  const { t } = useTranslation();
  const entries = (Object.keys(byStatus) as OrderStatus[]).filter((s) => byStatus[s] > 0);
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">
        {t("home.statusBreakdown.title")}
      </Text>
      {entries.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{t("home.statusBreakdown.empty")}</Text>
      ) : (
        <View className="gap-2">
          {entries.map((status) => (
            <View key={status} className="flex-row items-center justify-between">
              <Text className="text-sm text-muted-foreground">{t(STATUS_LABEL_KEYS[status])}</Text>
              <Text className="text-sm font-semibold text-foreground">{byStatus[status]}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function TopProductsList({ products }: { products: TopProduct[] }) {
  const { t } = useTranslation();
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">
        {t("home.topProducts.title")}
      </Text>
      {products.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{t("home.topProducts.empty")}</Text>
      ) : (
        <View className="gap-2">
          {products.map((p) => (
            <View key={p.listingId} className="flex-row items-center justify-between gap-3">
              <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
                {p.title}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t("home.topProducts.unitsSold", { count: p.unitsSold })}
              </Text>
              <PriceDisplay price={p.revenue} primaryClassName="text-sm font-semibold" />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function LowStockCard({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">{t("home.inventory.title")}</Text>
      <Text className="mt-1 text-sm text-muted-foreground">
        {count === 0
          ? t("home.inventory.noneLow")
          : t("home.inventory.lowStock", { count })}
      </Text>
    </View>
  );
}
