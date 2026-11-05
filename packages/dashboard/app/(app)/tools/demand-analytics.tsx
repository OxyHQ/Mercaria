import type React from 'react';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Link } from 'expo-router';
import Head from 'expo-router/head';
import { Button } from '@oxy.so/bloom/button';
import type {
  ConversionFigures,
  ConversionReportExport,
  ConversionReportInterval,
  ConversionTrendReport,
  ListingConversionReport,
  ListingConversionRow,
} from '@mercaria/shared-types';
import { Text, formatDate, useColorScheme } from '@mercaria/ui';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import { PlanToolGate } from '@/components/plan-tools/PlanToolGate';
import { useTranslation } from '@/lib/i18n';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import {
  useConversionTrend,
  useExportConversionReport,
  useListingConversion,
} from '@/lib/hooks/use-conversion-report';
import { planRefusalOf } from '@/lib/plan-refusal';
import {
  CONVERSION_WINDOW_DAYS,
  calendarDate,
  conversionWindow,
  formatPointsChange,
  formatRate,
  formatRelativeChange,
  type ConversionWindowDays,
} from '@/lib/conversion-report';

/**
 * Demand analytics — the checkout conversion report, the paid
 * `advanced_demand_analytics` tool (#89).
 *
 * Built from the store's own native checkout orders: checkouts started, paid,
 * open and abandoned, per listing and over time, with the previous period
 * beside it. Every figure set below the cohort floor arrives suppressed from
 * the server and is shown as hidden, never as zero. Views and search terms are
 * not in the report and the screen says so rather than leaving a gap.
 */
export default function DemandAnalyticsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('demandAnalytics.documentTitle')}</title>
      </Head>
      <Screen title={t('demandAnalytics.title')} subtitle={t('demandAnalytics.subtitle')}>
        <RequireStore permission="stats:read">
          {(storeId) => (
            <PlanToolGate storeId={storeId} capability="advanced_demand_analytics">
              {() => <DemandAnalyticsBody storeId={storeId} />}
            </PlanToolGate>
          )}
        </RequireStore>
      </Screen>
    </>
  );
}

function DemandAnalyticsBody({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const [days, setDays] = useState<ConversionWindowDays>(28);
  const [interval, setBucketInterval] = useState<ConversionReportInterval>('day');
  const [now] = useState(Date.now);
  const range = useMemo(() => conversionWindow(days, now), [days, now]);
  const listings = useListingConversion(storeId, range);
  const trend = useConversionTrend(storeId, range, interval);
  const exporter = useExportConversionReport(storeId);
  const [exporting, setExporting] = useState<ConversionReportExport | null>(null);

  const runExport = (report: ConversionReportExport) => {
    setExporting(report);
    exporter.mutate(
      { report, window: range, interval },
      {
        onSettled: () => setExporting(null),
      },
    );
  };

  const refused = planRefusalOf(listings.error) ?? planRefusalOf(trend.error);
  if (refused) {
    return (
      <ScreenMessage
        title={t('demandAnalytics.planChangedTitle')}
        body={t('demandAnalytics.planChangedBody')}
      />
    );
  }

  return (
    <View className="gap-4 pb-8">
      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <View className="flex-row flex-wrap gap-2">
          <View className="flex-row gap-1 rounded-xl border border-border bg-surface p-1">
            {CONVERSION_WINDOW_DAYS.map((value) => (
              <Button
                key={value}
                size="sm"
                appearance={days === value ? 'subtle' : 'plain'}
                pressed={days === value}
                onPress={() => setDays(value)}
              >
                {t('demandAnalytics.lastDays', { days: value })}
              </Button>
            ))}
          </View>
          <View className="flex-row gap-1 rounded-xl border border-border bg-surface p-1">
            {(['day', 'week'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                appearance={interval === value ? 'subtle' : 'plain'}
                pressed={interval === value}
                onPress={() => setBucketInterval(value)}
              >
                {t(value === 'day' ? 'demandAnalytics.daily' : 'demandAnalytics.weekly')}
              </Button>
            ))}
          </View>
        </View>
        <View className="flex-row flex-wrap gap-2">
          <Button
            size="sm"
            appearance="subtle"
            loading={exporting === 'listings'}
            disabled={exporting !== null}
            onPress={() => runExport('listings')}
          >
            {t('demandAnalytics.exportListings')}
          </Button>
          <Button
            size="sm"
            appearance="subtle"
            loading={exporting === 'trend'}
            disabled={exporting !== null}
            onPress={() => runExport('trend')}
          >
            {t('demandAnalytics.exportTrend')}
          </Button>
        </View>
      </View>
      {exporter.isError ? (
        <Text className="text-sm text-muted-foreground" accessibilityLiveRegion="polite">
          {t('demandAnalytics.exportFailed')}
        </Text>
      ) : null}

      {trend.data ? (
        <>
          <PeriodSummary report={trend.data} />
          <TrendChart report={trend.data} />
        </>
      ) : trend.isPending ? (
        <ScreenLoading />
      ) : (
        <ReportError
          retry={() => {
            void trend.refetch();
          }}
        />
      )}

      {listings.data ? (
        <ListingsSection report={listings.data} />
      ) : listings.isPending ? (
        <ScreenLoading />
      ) : (
        <ReportError
          retry={() => {
            void listings.refetch();
          }}
        />
      )}

      <View className="gap-2 rounded-xl border border-border bg-surface p-4">
        <Text className="text-xs text-muted-foreground">{t('demandAnalytics.notMeasured')}</Text>
        <Text className="text-xs text-muted-foreground">{t('demandAnalytics.definitions')}</Text>
      </View>
    </View>
  );
}

function ReportError({ retry }: { retry: () => void }) {
  const { t } = useTranslation();
  return (
    <View className="items-center rounded-xl border border-border bg-surface p-4">
      <ScreenMessage title={t('demandAnalytics.loadFailed')} />
      <Button size="sm" appearance="subtle" onPress={retry}>
        {t('common.retry')}
      </Button>
    </View>
  );
}

function SuppressedNote({ minimum }: { minimum: number }) {
  const { t } = useTranslation();
  return (
    <View className="gap-1 rounded-xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">
        {t('demandAnalytics.suppressedTitle')}
      </Text>
      <Text className="text-sm text-muted-foreground">
        {t('demandAnalytics.suppressedBody', { minimum })}
      </Text>
    </View>
  );
}

function Stat({ label, value, change }: { label: string; value: string; change?: string }) {
  return (
    <View className="w-1/2 gap-1 p-4 md:w-1/4">
      <Text className="text-sm font-medium text-muted-foreground">{label}</Text>
      <Text className="text-xl font-bold text-foreground">{value}</Text>
      {change ? <Text className="text-xs text-muted-foreground">{change}</Text> : null}
    </View>
  );
}

/** The window's headline figures, each with its change against the period before. */
function PeriodSummary({ report }: { report: ConversionTrendReport }) {
  const { t, locale } = useTranslation();
  const current = report.current;
  if (!current.aboveThreshold) return <SuppressedNote minimum={report.minimumCohort} />;

  const change = report.change;
  const relative = (value: number | null | undefined) =>
    value === null || value === undefined
      ? t('demandAnalytics.noComparison')
      : t('demandAnalytics.changeRelative', { value: formatRelativeChange(value, locale) });

  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap rounded-xl border border-border bg-surface">
        <Stat
          label={t('demandAnalytics.stats.checkoutsStarted')}
          value={String(current.checkoutsStarted)}
          change={relative(change?.checkoutsStarted)}
        />
        <Stat
          label={t('demandAnalytics.stats.paidCheckouts')}
          value={String(current.paidCheckouts)}
          change={relative(change?.paidCheckouts)}
        />
        <Stat
          label={t('demandAnalytics.stats.conversionRate')}
          value={formatRate(current.conversionRate ?? 0, locale)}
          change={
            change?.conversionRate === null || change?.conversionRate === undefined
              ? t('demandAnalytics.noComparison')
              : t('demandAnalytics.changePoints', {
                  value: formatPointsChange(change.conversionRate, locale),
                })
          }
        />
        <Stat
          label={t('demandAnalytics.stats.abandonedCheckouts')}
          value={String(current.abandonedCheckouts)}
          change={t('demandAnalytics.stats.openCheckoutsCount', {
            open: current.openCheckouts,
          })}
        />
      </View>
      <Text className="text-xs text-muted-foreground">
        {t('demandAnalytics.utcRange', {
          from: formatDate(calendarDate(report.window.from), locale),
          to: formatDate(calendarDate(report.window.to), locale),
        })}
      </Text>
    </View>
  );
}

/**
 * Checkouts started per bucket — one series, so no legend; the title names it.
 * A suppressed bucket is drawn as a short muted stub with its own label, so
 * "hidden" never reads as "none".
 */
function TrendChart({ report }: { report: ConversionTrendReport }) {
  const { t, locale } = useTranslation();
  const { colors } = useColorScheme();
  const [selected, setSelected] = useState<string | null>(null);
  const max = Math.max(1, ...report.buckets.map((bucket) => bucket.figures.checkoutsStarted));
  const point = report.buckets.find((bucket) => bucket.bucketStart === selected);

  const describe = (bucketStart: string, figures: ConversionFigures) => {
    const date = formatDate(calendarDate(bucketStart), locale);
    return figures.aboveThreshold
      ? t('demandAnalytics.trend.point', {
          date,
          started: figures.checkoutsStarted,
          paid: figures.paidCheckouts,
          rate: formatRate(figures.conversionRate ?? 0, locale),
        })
      : t('demandAnalytics.trend.suppressedPoint', { date, minimum: report.minimumCohort });
  };

  return (
    <View className="gap-4 rounded-xl border border-border bg-surface p-4">
      <Text accessibilityRole="header" className="text-sm font-semibold text-foreground">
        {t(
          report.interval === 'week'
            ? 'demandAnalytics.trend.titleWeekly'
            : 'demandAnalytics.trend.titleDaily',
        )}
      </Text>
      <View className="h-40 flex-row items-end gap-1 border-b border-border">
        {report.buckets.map((bucket) => {
          const published = bucket.figures.aboveThreshold;
          return (
            <Pressable
              key={bucket.bucketStart}
              onPress={() => setSelected(bucket.bucketStart)}
              accessibilityRole="button"
              accessibilityLabel={describe(bucket.bucketStart, bucket.figures)}
              accessibilityState={{ selected: bucket.bucketStart === selected }}
              className="h-40 min-w-0 flex-1 items-center justify-end"
            >
              <View
                style={{
                  height: published
                    ? Math.max(2, (bucket.figures.checkoutsStarted / max) * 150)
                    : 4,
                  backgroundColor: published ? colors.primary : colors.border,
                  width: '70%',
                  borderTopStartRadius: 3,
                  borderTopEndRadius: 3,
                  opacity: point && point.bucketStart !== bucket.bucketStart ? 0.45 : 1,
                }}
              />
            </Pressable>
          );
        })}
      </View>
      <View className="flex-row justify-between gap-4">
        <Text className="text-xs text-muted-foreground">
          {formatDate(calendarDate(report.window.from), locale)}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {formatDate(calendarDate(report.window.to), locale)}
        </Text>
      </View>
      <View className="min-h-8" accessibilityLiveRegion="polite">
        <Text className="text-xs text-muted-foreground">
          {point ? describe(point.bucketStart, point.figures) : t('demandAnalytics.trend.inspect')}
        </Text>
      </View>
    </View>
  );
}

function ListingsSection({ report }: { report: ListingConversionReport }) {
  const { t } = useTranslation();
  return (
    <View className="gap-4">
      <View className="flex-col items-stretch gap-4 lg:flex-row">
        <View className="min-w-0 lg:flex-1">
          <RankedList
            title={t('demandAnalytics.best.title')}
            rows={report.bestConverting}
            minimum={report.minimumCohort}
          />
        </View>
        <View className="min-w-0 lg:flex-1">
          <RankedList
            title={t('demandAnalytics.worst.title')}
            rows={report.worstConverting}
            minimum={report.minimumCohort}
          />
        </View>
      </View>
      <View className="gap-3 rounded-xl border border-border bg-surface p-4">
        <Text accessibilityRole="header" className="text-sm font-semibold text-foreground">
          {t('demandAnalytics.listings.title')}
        </Text>
        {report.listings.length === 0 ? (
          <Text className="text-sm text-muted-foreground">
            {t('demandAnalytics.listings.empty', { minimum: report.minimumCohort })}
          </Text>
        ) : (
          <View className="gap-1">
            {report.listings.map((row) => (
              <ListingRow key={row.listingId} row={row} />
            ))}
          </View>
        )}
        {report.suppressedListingCount > 0 ? (
          <Text className="text-xs text-muted-foreground">
            {t('demandAnalytics.listings.suppressed', {
              hidden: report.suppressedListingCount,
              minimum: report.minimumCohort,
            })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function RankedList({
  title,
  rows,
  minimum,
}: {
  title: string;
  rows: readonly ListingConversionRow[];
  minimum: number;
}) {
  const { t } = useTranslation();
  return (
    <View className="gap-2 rounded-xl border border-border bg-surface p-4">
      <Text accessibilityRole="header" className="text-sm font-semibold text-foreground">
        {title}
      </Text>
      {rows.length === 0 ? (
        <Text className="text-sm text-muted-foreground">
          {t('demandAnalytics.rankedEmpty', { minimum })}
        </Text>
      ) : (
        rows.map((row) => <ListingRow key={row.listingId} row={row} />)
      )}
    </View>
  );
}

/** One listing: its title, its counts, and its conversion as a single-hue bar. */
function ListingRow({ row }: { row: ListingConversionRow }) {
  const { t, locale } = useTranslation();
  const { colors } = useColorScheme();
  const { can } = useActiveStoreContext();
  const rate = row.figures.conversionRate ?? 0;
  const rateText = formatRate(rate, locale);
  const content: React.ReactNode = (
    <View className="gap-1 rounded-lg py-2">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
          {row.title}
        </Text>
        <Text className="text-sm font-semibold text-foreground">{rateText}</Text>
      </View>
      <View className="h-1.5 overflow-hidden rounded-full bg-muted">
        <View
          style={{
            width: `${String(Math.round(rate * 100))}%`,
            height: '100%',
            backgroundColor: colors.primary,
            borderRadius: 999,
          }}
        />
      </View>
      <Text className="text-xs text-muted-foreground">
        {t('demandAnalytics.listings.row', {
          started: row.figures.checkoutsStarted,
          paid: row.figures.paidCheckouts,
          abandoned: row.figures.abandonedCheckouts,
        })}
      </Text>
    </View>
  );
  return can('products:read') ? (
    <Link href={{ pathname: '/products/[id]', params: { id: row.listingId } }} asChild>
      <Pressable accessibilityLabel={`${row.title}, ${rateText}`} className="web:hover:bg-muted">
        {content}
      </Pressable>
    </Link>
  ) : (
    <View accessible accessibilityLabel={`${row.title}, ${rateText}`}>
      {content}
    </View>
  );
}
