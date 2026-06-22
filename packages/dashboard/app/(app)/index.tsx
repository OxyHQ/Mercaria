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

export default function DashboardScreen() {
  return (
    <>
      <Head>
        <title>Dashboard | Mercaria</title>
      </Head>
      <Screen title="Dashboard" subtitle="Your store at a glance" action={<StoreSwitcher />}>
        <RequireStore permission="stats:read">
          {(storeId) => <DashboardBody storeId={storeId} />}
        </RequireStore>
      </Screen>
    </>
  );
}

function DashboardBody({ storeId }: { storeId: string }) {
  const summary = useReportSummary(storeId);
  const sales = useSalesReport(storeId, "day");
  const top = useTopProducts(storeId);
  const stats = useStoreStats(storeId);

  if (summary.isPending) {
    return <ScreenLoading />;
  }
  if (summary.isError || !summary.data) {
    return <ScreenMessage title="Couldn't load reports" body="Please try again." />;
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
  return (
    <View className="flex-col gap-3 md:flex-row">
      <Stat label="Revenue" value={<MoneyStat amount={summary.revenue} />} />
      <Stat
        label="Paid orders"
        value={<Text className="text-xl font-bold text-foreground">{summary.paidOrderCount}</Text>}
      />
      <Stat label="Avg order" value={<MoneyStat amount={summary.averageOrderValue} />} />
      <Stat label="Refunds" value={<MoneyStat amount={summary.refundTotal} />} />
    </View>
  );
}

function SalesChart({ points }: { points: SalesReportPoint[] }) {
  const { colors } = useColorScheme();
  const max = Math.max(1, ...points.map((p) => p.revenue.amount));

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-4 text-sm font-semibold text-foreground">Sales (last period)</Text>
      {points.length === 0 ? (
        <Text className="text-sm text-muted-foreground">No sales in this period yet.</Text>
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

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending_payment: "Pending payment",
  paid: "Paid",
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
};

function StatusBreakdown({ byStatus }: { byStatus: Record<OrderStatus, number> }) {
  const entries = (Object.keys(byStatus) as OrderStatus[]).filter((s) => byStatus[s] > 0);
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">Orders by status</Text>
      {entries.length === 0 ? (
        <Text className="text-sm text-muted-foreground">No orders yet.</Text>
      ) : (
        <View className="gap-2">
          {entries.map((status) => (
            <View key={status} className="flex-row items-center justify-between">
              <Text className="text-sm text-muted-foreground">{STATUS_LABELS[status]}</Text>
              <Text className="text-sm font-semibold text-foreground">{byStatus[status]}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function TopProductsList({ products }: { products: TopProduct[] }) {
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">Top products</Text>
      {products.length === 0 ? (
        <Text className="text-sm text-muted-foreground">No sales yet.</Text>
      ) : (
        <View className="gap-2">
          {products.map((p) => (
            <View key={p.listingId} className="flex-row items-center justify-between gap-3">
              <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
                {p.title}
              </Text>
              <Text className="text-xs text-muted-foreground">{p.unitsSold} sold</Text>
              <PriceDisplay price={p.revenue} primaryClassName="text-sm font-semibold" />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function LowStockCard({ count }: { count: number }) {
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">Inventory</Text>
      <Text className="mt-1 text-sm text-muted-foreground">
        {count === 0
          ? "No tracked variants are low on stock."
          : `${count} tracked variant${count === 1 ? "" : "s"} at or below the low-stock threshold.`}
      </Text>
    </View>
  );
}
