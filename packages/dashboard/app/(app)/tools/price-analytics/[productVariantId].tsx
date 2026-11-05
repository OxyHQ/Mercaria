import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import Svg, { Circle, Polyline } from 'react-native-svg';
import { Button } from '@oxy.so/bloom/button';
import {
  STORE_PRICE_TREND_GRANULARITIES,
  STORE_PRICE_TREND_WINDOWS_DAYS,
  type StorePriceTrendGranularity,
  type StorePriceTrendPoint,
  type StorePriceTrendResponse,
  type StorePriceTrendWindowDays,
} from '@mercaria/shared-types';
import { Text, formatDate, useColorScheme } from '@mercaria/ui';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import { PlanToolGate } from '@/components/plan-tools/PlanToolGate';
import {
  BAND_LABEL_KEYS,
  REASON_LABEL_KEYS,
  rowMoney,
} from '@/components/plan-tools/price-analytics-labels';
import { useStorePriceAnalytics, useStorePriceTrend } from '@/lib/hooks/use-price-analytics';
import { planRefusalOf } from '@/lib/plan-refusal';
import { useTranslation } from '@/lib/i18n';

/**
 * One listing's price against its comparison over time: the store's own price,
 * and the other sellers' lowest and median, per day or week.
 */
export default function PriceAnalyticsDetailScreen() {
  const { t } = useTranslation();
  const { productVariantId } = useLocalSearchParams<{ productVariantId: string }>();
  return (
    <>
      <Head>
        <title>{t('priceAnalytics.documentTitle')}</title>
      </Head>
      <Screen title={t('priceAnalytics.detailTitle')}>
        <RequireStore permission="analytics:read">
          {(storeId) => (
            <PlanToolGate storeId={storeId} capability="competitive_price_analytics">
              {() => <DetailBody storeId={storeId} productVariantId={productVariantId ?? ''} />}
            </PlanToolGate>
          )}
        </RequireStore>
      </Screen>
    </>
  );
}

const GRANULARITY_LABEL_KEYS: Record<StorePriceTrendGranularity, string> = {
  day: 'priceAnalytics.trend.daily',
  week: 'priceAnalytics.trend.weekly',
};

function DetailBody({ storeId, productVariantId }: { storeId: string; productVariantId: string }) {
  const { t, locale } = useTranslation();
  const [windowDays, setWindowDays] = useState<StorePriceTrendWindowDays>(30);
  const [granularity, setGranularity] = useState<StorePriceTrendGranularity>('day');
  const overview = useStorePriceAnalytics(storeId);
  const trend = useStorePriceTrend(storeId, productVariantId, windowDays, granularity);
  const row = overview.data?.rows.find((entry) => entry.productVariantId === productVariantId);

  if (planRefusalOf(trend.error) !== null || planRefusalOf(overview.error) !== null) {
    return (
      <ScreenMessage
        title={t('priceAnalytics.planEndedTitle')}
        body={t('priceAnalytics.planEndedBody')}
      />
    );
  }

  return (
    <View className="gap-4 pb-8">
      {row ? (
        <View className="gap-1 rounded-xl border border-border bg-surface p-4">
          <Text className="text-base font-semibold text-foreground">{row.listingTitle}</Text>
          {row.variantTitle ? (
            <Text className="text-xs text-muted-foreground">{row.variantTitle}</Text>
          ) : null}
          {row.canonicalProductName ? (
            <Text className="text-xs text-muted-foreground">
              {t('priceAnalytics.matchedTo', { product: row.canonicalProductName })}
            </Text>
          ) : null}
          <Text className="mt-2 text-sm text-foreground">
            {rowMoney(row.ownAmount, row.currency, locale) === null
              ? t('priceAnalytics.noPrice')
              : t('priceAnalytics.yourPrice', {
                  price: rowMoney(row.ownAmount, row.currency, locale) ?? '',
                })}
          </Text>
          {row.state === 'measured' && row.market && row.position ? (
            <>
              <Text className="text-sm text-foreground">
                {t('priceAnalytics.positionLine', { band: t(BAND_LABEL_KEYS[row.position.band]) })}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t('priceAnalytics.marketLine', {
                  sellers: row.market.otherSellers,
                  lowest: rowMoney(row.market.lowestAmount, row.currency, locale) ?? '',
                  median: rowMoney(row.market.medianAmount, row.currency, locale) ?? '',
                })}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t('priceAnalytics.deltaLine', {
                  toLowest: (row.position.deltaToLowestBps / 100).toFixed(1),
                  toMedian: (row.position.deltaToMedianBps / 100).toFixed(1),
                })}
              </Text>
            </>
          ) : (
            <Text className="text-xs text-muted-foreground">
              {t(REASON_LABEL_KEYS[row.reason ?? 'insufficient_observations'])}
            </Text>
          )}
          {row.conversion ? (
            <Text className="text-xs text-muted-foreground">
              {t('priceAnalytics.converted', {
                provider: row.conversion.provider,
                date: formatDate(row.conversion.asOf, locale) ?? row.conversion.asOf,
              })}
            </Text>
          ) : null}
          {!row.inComparison ? (
            <Text className="text-xs text-muted-foreground">{t('priceAnalytics.notShown')}</Text>
          ) : null}
        </View>
      ) : null}

      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
          {t('priceAnalytics.trend.title')}
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <View className="flex-row gap-1 rounded-xl border border-border bg-surface p-1">
            {STORE_PRICE_TREND_WINDOWS_DAYS.map((value) => (
              <Button
                key={value}
                size="sm"
                appearance={windowDays === value ? 'subtle' : 'plain'}
                pressed={windowDays === value}
                onPress={() => setWindowDays(value)}
              >
                {t('priceAnalytics.trend.lastDays', { days: value })}
              </Button>
            ))}
          </View>
          <View className="flex-row gap-1 rounded-xl border border-border bg-surface p-1">
            {STORE_PRICE_TREND_GRANULARITIES.map((value) => (
              <Button
                key={value}
                size="sm"
                appearance={granularity === value ? 'subtle' : 'plain'}
                pressed={granularity === value}
                onPress={() => setGranularity(value)}
              >
                {t(GRANULARITY_LABEL_KEYS[value])}
              </Button>
            ))}
          </View>
        </View>
      </View>

      {trend.isPending ? (
        <ScreenLoading />
      ) : trend.isError || !trend.data ? (
        <View className="items-center gap-2">
          <ScreenMessage
            title={t('priceAnalytics.trend.loadFailed')}
            body={t('common.pleaseTryAgain')}
          />
          <Button size="sm" appearance="subtle" onPress={() => void trend.refetch()}>
            {t('common.retry')}
          </Button>
        </View>
      ) : trend.data.reason ? (
        <ScreenMessage
          title={t('priceAnalytics.trend.unavailable')}
          body={t(REASON_LABEL_KEYS[trend.data.reason])}
        />
      ) : (
        <TrendView trend={trend.data} />
      )}
    </View>
  );
}

const CHART_WIDTH = 600;
const CHART_HEIGHT = 180;

/** The x/y of each defined value, scaled into the chart box. */
function polyline(
  points: readonly StorePriceTrendPoint[],
  value: (point: StorePriceTrendPoint) => number | null,
  min: number,
  max: number,
): { x: number; y: number }[] {
  const span = Math.max(1, max - min);
  const step = points.length > 1 ? CHART_WIDTH / (points.length - 1) : 0;
  const out: { x: number; y: number }[] = [];
  points.forEach((point, index) => {
    const v = value(point);
    if (v === null) return;
    out.push({ x: index * step, y: CHART_HEIGHT - ((v - min) / span) * (CHART_HEIGHT - 8) - 4 });
  });
  return out;
}

function TrendView({ trend }: { trend: StorePriceTrendResponse }) {
  const { t, locale } = useTranslation();
  const { colors } = useColorScheme();

  const values = trend.points.flatMap((point) => [
    ...(point.ownAmount === null ? [] : [point.ownAmount]),
    ...(point.market === null ? [] : [point.market.lowestAmount, point.market.medianAmount]),
  ]);
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 1;

  const series = useMemo(
    () => ({
      own: polyline(trend.points, (point) => point.ownAmount, min, max),
      median: polyline(trend.points, (point) => point.market?.medianAmount ?? null, min, max),
      lowest: polyline(trend.points, (point) => point.market?.lowestAmount ?? null, min, max),
    }),
    [trend.points, min, max],
  );
  const toPoints = (list: { x: number; y: number }[]) =>
    list.map((point) => `${point.x},${point.y}`).join(' ');

  // Newest first in the table: the latest comparison is the one a reader wants.
  const tableRows = [...trend.points]
    .reverse()
    .filter((point) => point.ownAmount !== null || point.market !== null);

  return (
    <View className="gap-3">
      <View className="gap-3 rounded-xl border border-border bg-surface p-4">
        {values.length === 0 ? (
          <Text className="text-sm text-muted-foreground">{t('priceAnalytics.trend.empty')}</Text>
        ) : (
          <View accessibilityLabel={t('priceAnalytics.trend.chartLabel')}>
            <Svg
              width="100%"
              height={CHART_HEIGHT}
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              preserveAspectRatio="none"
            >
              {[
                { key: 'lowest', list: series.lowest, color: colors.mutedForeground, dash: '4 4' },
                {
                  key: 'median',
                  list: series.median,
                  color: colors.mutedForeground,
                  dash: undefined,
                },
                { key: 'own', list: series.own, color: colors.primary, dash: undefined },
              ].map(({ key, list, color, dash }) =>
                list.length > 1 ? (
                  <Polyline
                    key={key}
                    points={toPoints(list)}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeDasharray={dash}
                  />
                ) : list.length === 1 && list[0] ? (
                  <Circle key={key} cx={list[0].x} cy={list[0].y} r={3} fill={color} />
                ) : null,
              )}
            </Svg>
          </View>
        )}
        <View className="flex-row flex-wrap gap-4">
          <Legend color={colors.primary} label={t('priceAnalytics.trend.legendOwn')} />
          <Legend color={colors.mutedForeground} label={t('priceAnalytics.trend.legendMedian')} />
          <Legend
            color={colors.mutedForeground}
            label={t('priceAnalytics.trend.legendLowest')}
            dashed
          />
        </View>
      </View>

      <View className="gap-1 rounded-xl border border-border bg-surface p-4">
        <View className="flex-row gap-2 border-b border-border pb-2">
          <Text className="flex-1 text-xs font-semibold text-muted-foreground">
            {t('priceAnalytics.trend.colPeriod')}
          </Text>
          <Text className="flex-1 text-xs font-semibold text-muted-foreground">
            {t('priceAnalytics.trend.colOwn')}
          </Text>
          <Text className="flex-1 text-xs font-semibold text-muted-foreground">
            {t('priceAnalytics.trend.colLowest')}
          </Text>
          <Text className="flex-1 text-xs font-semibold text-muted-foreground">
            {t('priceAnalytics.trend.colMedian')}
          </Text>
          <Text className="w-16 text-xs font-semibold text-muted-foreground">
            {t('priceAnalytics.trend.colSellers')}
          </Text>
        </View>
        {tableRows.length === 0 ? (
          <Text className="py-2 text-sm text-muted-foreground">
            {t('priceAnalytics.trend.empty')}
          </Text>
        ) : (
          tableRows.map((point) => (
            <View key={point.bucketStart} className="flex-row gap-2 py-1">
              <Text className="flex-1 text-xs text-foreground">
                {formatDate(point.bucketStart, locale) ?? point.bucketStart}
              </Text>
              <Text className="flex-1 text-xs text-foreground">
                {rowMoney(point.ownAmount, trend.currency, locale) ??
                  t('priceAnalytics.trend.noValue')}
              </Text>
              <Text className="flex-1 text-xs text-foreground">
                {rowMoney(point.market?.lowestAmount, trend.currency, locale) ??
                  t('priceAnalytics.trend.noValue')}
              </Text>
              <Text className="flex-1 text-xs text-foreground">
                {rowMoney(point.market?.medianAmount, trend.currency, locale) ??
                  t('priceAnalytics.trend.noValue')}
              </Text>
              <Text className="w-16 text-xs text-foreground">
                {point.market?.otherSellers ?? t('priceAnalytics.trend.noValue')}
              </Text>
            </View>
          ))
        )}
        <Text className="pt-2 text-xs text-muted-foreground">
          {t('priceAnalytics.trend.footnote')}
        </Text>
      </View>
    </View>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <View className="flex-row items-center gap-2">
      <View
        style={{
          width: 16,
          height: 0,
          borderTopWidth: 2,
          borderColor: color,
          borderStyle: dashed ? 'dashed' : 'solid',
        }}
      />
      <Text className="text-xs text-muted-foreground">{label}</Text>
    </View>
  );
}
