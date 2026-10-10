import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import Head from 'expo-router/head';
import type {
  Money,
  OrderStatus,
  ReportSummary,
  SalesReportPoint,
  TopProduct,
} from '@mercaria/shared-types';
import { Text, PriceDisplay, formatDate, formatMoney, useColorScheme } from '@mercaria/ui';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import { useReportSummary, useSalesReport, useTopProducts } from '@/lib/hooks/use-reports';
import { useStoreStats } from '@/lib/hooks/use-orders';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import {
  dailySales,
  reportRange,
  reportCalendarDate,
  type ReportDays,
  type ReportRange,
} from '@/lib/report-range';
import { useTranslation } from '@/lib/i18n';

export default function DashboardScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('home.documentTitle')}</title>
      </Head>
      <Screen title={t('nav.dashboard')} subtitle={t('home.subtitle')}>
        <RequireStore permission="stats:read">
          {(storeId) => <DashboardBody storeId={storeId} />}
        </RequireStore>
      </Screen>
    </>
  );
}

function DashboardBody({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const [days, setDays] = useState<ReportDays>(30);
  const [now] = useState(Date.now);
  const range = useMemo(() => reportRange(days, now), [days, now]);
  const summary = useReportSummary(storeId);
  const sales = useSalesReport(storeId, 'day', range);
  const top = useTopProducts(storeId, range);
  const stats = useStoreStats(storeId);

  return (
    <View className="gap-4 pb-8">
      <View className="gap-2">
        <Text className="text-sm font-semibold text-muted-foreground">{t('home.allTime')}</Text>
        {summary.data ? (
          <SummaryCards summary={summary.data} />
        ) : summary.isPending ? (
          <ScreenLoading />
        ) : (
          <ReportError
            retry={() => {
              void summary.refetch();
            }}
          />
        )}
      </View>
      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
          {t('home.performance')}
        </Text>
        <View className="flex-row gap-1 rounded-xl border border-border bg-surface p-1">
          {([7, 30, 90] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              appearance={days === value ? 'subtle' : 'plain'}
              pressed={days === value}
              onPress={() => setDays(value)}
            >
              {t('home.lastDays', { days: value })}
            </Button>
          ))}
        </View>
      </View>
      {sales.isError ? (
        <ReportError
          retry={() => {
            void sales.refetch();
          }}
        />
      ) : (
        <SalesChart points={sales.data ?? []} range={range} loading={sales.isPending} />
      )}
      <View className="flex-col items-stretch gap-4 lg:flex-row">
        <View className="min-w-0 lg:flex-1">
          {summary.data ? <StatusBreakdown byStatus={summary.data.byStatus} /> : null}
        </View>
        <View className="min-w-0 lg:flex-1">
          {top.data ? (
            <TopProductsList products={top.data} />
          ) : top.isPending ? (
            <ScreenLoading />
          ) : (
            <ReportError
              retry={() => {
                void top.refetch();
              }}
            />
          )}
        </View>
      </View>
      {stats.data ? <LowStockCard count={stats.data.lowStockVariantCount} /> : null}
    </View>
  );
}

function ReportError({ retry }: { retry: () => void }) {
  const { t } = useTranslation();
  return (
    <View className="items-center rounded-xl border border-border bg-surface p-4">
      <ScreenMessage title={t('home.reportsError')} />
      <Button size="sm" appearance="subtle" onPress={retry}>
        {t('common.retry')}
      </Button>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <View className="w-1/2 gap-2 p-4 md:w-1/4">
      <Text className="text-sm font-medium text-muted-foreground">{label}</Text>
      <View>{value}</View>
    </View>
  );
}

function MoneyStat({ amount }: { amount: Money }) {
  return <PriceDisplay price={amount} primaryClassName="text-xl font-bold" />;
}

function SummaryCards({ summary }: { summary: ReportSummary }) {
  const { t } = useTranslation();
  return (
    <View className="flex-row flex-wrap rounded-xl border border-border bg-surface">
      <Stat label={t('home.stats.revenue')} value={<MoneyStat amount={summary.revenue} />} />
      <Stat
        label={t('home.stats.paidOrders')}
        value={<Text className="text-xl font-bold text-foreground">{summary.paidOrderCount}</Text>}
      />
      <Stat
        label={t('home.stats.averageOrder')}
        value={<MoneyStat amount={summary.averageOrderValue} />}
      />
      <Stat label={t('home.stats.refunds')} value={<MoneyStat amount={summary.refundTotal} />} />
    </View>
  );
}

function SalesChart({
  points,
  range,
  loading,
}: {
  points: SalesReportPoint[];
  range: ReportRange;
  loading: boolean;
}) {
  const { colors } = useColorScheme();
  const { t, locale } = useTranslation();
  const series = useMemo(() => dailySales(points, range), [points, range]);
  const max = Math.max(1, ...series.map((point) => point.revenue.amount));
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  const selected = series.find((point) => point.bucket === selectedBucket);

  return (
    <View
      testID="merchant-sales-chart"
      className="min-h-[324px] gap-4 rounded-xl border border-border bg-surface p-4"
    >
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text accessibilityRole="header" className="text-sm font-semibold text-foreground">
          {t('home.sales.title')}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {t('home.utcRange', {
            from: formatDate(reportCalendarDate(range.from), locale),
            to: formatDate(reportCalendarDate(range.to), locale),
          })}
        </Text>
      </View>
      {series.length === 0 ? (
        <View className="h-40 justify-center" accessibilityLiveRegion="polite">
          <Text className="text-sm text-muted-foreground">
            {t(loading ? 'common.loading' : 'home.sales.empty')}
          </Text>
        </View>
      ) : (
        <>
          <View className="h-40 flex-row items-end gap-1 border-b border-border">
            {series.map((point) => (
              <Pressable
                key={point.bucket}
                testID="merchant-sales-day"
                onPress={() => setSelectedBucket(point.bucket)}
                accessibilityRole="button"
                accessibilityLabel={t('home.sales.point', {
                  date: formatDate(reportCalendarDate(point.bucket), locale),
                  revenue: formatMoney(point.revenue, locale),
                  count: point.orders,
                })}
                accessibilityState={{ selected: point.bucket === selectedBucket }}
                aria-pressed={point.bucket === selectedBucket}
                className="h-40 min-w-0 flex-1 items-center justify-end"
              >
                <View
                  style={{
                    height: Math.max(
                      point.revenue.amount > 0 ? 2 : 0,
                      (point.revenue.amount / max) * 150,
                    ),
                    backgroundColor: colors.primary,
                    width: '70%',
                    borderTopStartRadius: 3,
                    borderTopEndRadius: 3,
                    opacity: selected && selected.bucket !== point.bucket ? 0.45 : 1,
                  }}
                />
              </Pressable>
            ))}
          </View>
          <View className="flex-row justify-between gap-4">
            <Text className="text-xs text-muted-foreground">
              {formatDate(reportCalendarDate(range.from), locale)}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {formatDate(reportCalendarDate(range.to), locale)}
            </Text>
          </View>
          <View className="min-h-8" accessibilityLiveRegion="polite">
            <Text className="text-xs text-muted-foreground">
              {selected
                ? t('home.sales.point', {
                    date: formatDate(reportCalendarDate(selected.bucket), locale),
                    revenue: formatMoney(selected.revenue, locale),
                    count: selected.orders,
                  })
                : t('home.sales.inspect')}
            </Text>
          </View>
        </>
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
  pending_payment: 'home.orderStatus.pendingPayment',
  paid: 'home.orderStatus.paid',
  processing: 'home.orderStatus.processing',
  shipped: 'home.orderStatus.shipped',
  delivered: 'home.orderStatus.delivered',
  // #1015: a digital order's completion signal (ADR 0010 D9). Here because the
  // `Record` refuses to compile without it, which is why it is a `Record`.
  digitally_delivered: 'home.orderStatus.digitallyDelivered',
  cancelled: 'home.orderStatus.cancelled',
  refunded: 'home.orderStatus.refunded',
  partially_refunded: 'home.orderStatus.partiallyRefunded',
};

function StatusBreakdown({ byStatus }: { byStatus: Record<OrderStatus, number> }) {
  const { t } = useTranslation();
  const entries = (Object.keys(byStatus) as OrderStatus[]).filter((s) => byStatus[s] > 0);
  return (
    <View className="rounded-xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">
        {t('home.statusBreakdown.title')}
      </Text>
      {entries.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{t('home.statusBreakdown.empty')}</Text>
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
  const router = useRouter();
  const { can } = useActiveStoreContext();
  return (
    <View className="rounded-xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">
        {t('home.topProducts.title')}
      </Text>
      {products.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{t('home.topProducts.empty')}</Text>
      ) : (
        <View className="gap-2">
          {products.map((p) => (
            <Pressable
              key={p.listingId}
              accessibilityRole="link"
              disabled={!can('products:read')}
              onPress={() =>
                router.push({ pathname: '/products/[id]', params: { id: p.listingId } })
              }
              className="flex-row items-center justify-between gap-3 rounded-lg py-2 web:hover:bg-muted"
            >
              <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
                {p.title}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t('home.topProducts.unitsSold', { count: p.unitsSold })}
              </Text>
              <PriceDisplay price={p.revenue} primaryClassName="text-sm font-semibold" />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function LowStockCard({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <View className="rounded-xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">{t('home.inventory.title')}</Text>
      <Text className="mt-1 text-sm text-muted-foreground">
        {count === 0 ? t('home.inventory.noneLow') : t('home.inventory.lowStock', { count })}
      </Text>
    </View>
  );
}
