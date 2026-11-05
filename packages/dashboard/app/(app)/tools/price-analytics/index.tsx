import { useMemo, useState } from 'react';
import { Platform, Pressable, Share, View } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { Button } from '@oxy.so/bloom/button';
import { ChevronRight } from 'lucide-react-native';
import {
  STORE_PRICE_POSITION_BANDS,
  type StorePriceAnalyticsResponse,
  type StorePriceAnalyticsRow,
  type StorePricePositionBand,
} from '@mercaria/shared-types';
import { Text, formatDateTime, useColorScheme } from '@mercaria/ui';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import { PlanToolGate } from '@/components/plan-tools/PlanToolGate';
import {
  BAND_LABEL_KEYS,
  REASON_LABEL_KEYS,
  bandToneClass,
  rowMoney,
} from '@/components/plan-tools/price-analytics-labels';
import { fetchStorePriceAnalyticsCsv } from '@/lib/api/price-analytics';
import { useStorePriceAnalytics } from '@/lib/hooks/use-price-analytics';
import { planRefusalOf } from '@/lib/plan-refusal';
import { useTranslation } from '@/lib/i18n';

/**
 * Competitive price analytics — the store's own live listings against the other
 * offers in their public comparisons (#89's paid `competitive_price_analytics`).
 *
 * A price COMPARISON and nothing else: no suggestion, no target price, and no
 * claim about where a listing appears. Other sellers are only ever counts and
 * aggregates — the API carries no field for one by name.
 */
export default function PriceAnalyticsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('priceAnalytics.documentTitle')}</title>
      </Head>
      <Screen title={t('priceAnalytics.title')} subtitle={t('priceAnalytics.subtitle')}>
        <RequireStore permission="analytics:read">
          {(storeId) => (
            <PlanToolGate storeId={storeId} capability="competitive_price_analytics">
              {() => <PriceAnalyticsBody storeId={storeId} />}
            </PlanToolGate>
          )}
        </RequireStore>
      </Screen>
    </>
  );
}

/** The export's file name — the same one the API's `Content-Disposition` names. */
const CSV_FILENAME = 'price-analytics.csv';

type Filter = 'all' | StorePricePositionBand | 'unmeasured';

function PriceAnalyticsBody({ storeId }: { storeId: string }) {
  const { t, locale } = useTranslation();
  const report = useStorePriceAnalytics(storeId);
  const [filter, setFilter] = useState<Filter>('all');
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);

  const rows = useMemo(() => {
    const all = report.data?.rows ?? [];
    if (filter === 'all') return all;
    if (filter === 'unmeasured') return all.filter((row) => row.state === 'unmeasured');
    return all.filter((row) => row.position?.band === filter);
  }, [report.data, filter]);

  if (report.isPending) return <ScreenLoading />;
  if (report.isError || !report.data) {
    if (planRefusalOf(report.error) !== null) {
      return (
        <ScreenMessage
          title={t('priceAnalytics.planEndedTitle')}
          body={t('priceAnalytics.planEndedBody')}
        />
      );
    }
    return (
      <View className="items-center gap-2">
        <ScreenMessage title={t('priceAnalytics.loadFailed')} body={t('common.pleaseTryAgain')} />
        <Button size="sm" appearance="subtle" onPress={() => void report.refetch()}>
          {t('common.retry')}
        </Button>
      </View>
    );
  }

  const data = report.data;

  const exportCsv = async () => {
    setExporting(true);
    setExportFailed(false);
    try {
      const csv = await fetchStorePriceAnalyticsCsv(storeId);
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = CSV_FILENAME;
        link.click();
        URL.revokeObjectURL(url);
      } else {
        await Share.share({ message: csv });
      }
    } catch {
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  };

  return (
    <View className="gap-4 pb-8">
      {data.semantics === undefined ? (
        <ScreenMessage
          title={t('priceAnalytics.noPolicyTitle')}
          body={t('priceAnalytics.noPolicyBody')}
        />
      ) : null}

      <Summary data={data} />

      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <Text className="text-xs text-muted-foreground">
          {t('priceAnalytics.computedAt', {
            when: formatDateTime(data.computedAt, locale) ?? data.computedAt,
          })}
        </Text>
        <Button
          size="sm"
          appearance="subtle"
          onPress={() => void exportCsv()}
          disabled={exporting || data.rows.length === 0}
        >
          {t(exporting ? 'priceAnalytics.exporting' : 'priceAnalytics.exportCsv')}
        </Button>
      </View>
      {exportFailed ? (
        <Text className="text-xs text-muted-foreground">{t('priceAnalytics.exportFailed')}</Text>
      ) : null}
      {data.coverage.truncated ? (
        <Text className="text-xs text-muted-foreground">
          {t('priceAnalytics.truncated', {
            analysed: data.coverage.listingsAnalysed,
            total: data.coverage.listingsTotal,
          })}
        </Text>
      ) : null}

      {data.rows.length === 0 ? (
        <ScreenMessage
          title={t('priceAnalytics.emptyTitle')}
          body={t('priceAnalytics.emptyBody')}
        />
      ) : (
        <>
          <FilterBar filter={filter} onChange={setFilter} />
          <View className="gap-2">
            {rows.map((row) => (
              <ListingRow key={row.productVariantId} row={row} />
            ))}
            {rows.length === 0 ? (
              <Text className="text-sm text-muted-foreground">
                {t('priceAnalytics.filterEmpty')}
              </Text>
            ) : null}
          </View>
        </>
      )}

      <Text className="text-xs text-muted-foreground">{t('priceAnalytics.method')}</Text>
    </View>
  );
}

function Summary({ data }: { data: StorePriceAnalyticsResponse }) {
  const { t } = useTranslation();
  return (
    <View className="flex-row flex-wrap rounded-xl border border-border bg-surface">
      {STORE_PRICE_POSITION_BANDS.map((band) => (
        <View key={band} className="w-1/2 gap-1 p-4 md:w-1/5">
          <Text className="text-xs font-medium text-muted-foreground">
            {t(BAND_LABEL_KEYS[band])}
          </Text>
          <Text className="text-xl font-bold text-foreground">{data.summary.byBand[band]}</Text>
        </View>
      ))}
      <View className="w-1/2 gap-1 p-4 md:w-1/5">
        <Text className="text-xs font-medium text-muted-foreground">
          {t('priceAnalytics.summary.unmeasured')}
        </Text>
        <Text className="text-xl font-bold text-foreground">{data.summary.unmeasured}</Text>
      </View>
    </View>
  );
}

const FILTERS: readonly Filter[] = ['all', ...STORE_PRICE_POSITION_BANDS, 'unmeasured'];

const FILTER_LABEL_KEYS: Record<Filter, string> = {
  all: 'priceAnalytics.filter.all',
  unmeasured: 'priceAnalytics.summary.unmeasured',
  ...BAND_LABEL_KEYS,
};

function FilterBar({ filter, onChange }: { filter: Filter; onChange: (filter: Filter) => void }) {
  const { t } = useTranslation();
  return (
    <View className="flex-row flex-wrap gap-1 rounded-xl border border-border bg-surface p-1">
      {FILTERS.map((value) => (
        <Button
          key={value}
          size="sm"
          appearance={filter === value ? 'subtle' : 'plain'}
          pressed={filter === value}
          onPress={() => onChange(value)}
        >
          {t(FILTER_LABEL_KEYS[value])}
        </Button>
      ))}
    </View>
  );
}

function ListingRow({ row }: { row: StorePriceAnalyticsRow }) {
  const { t, locale } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
  const own = rowMoney(row.ownAmount, row.currency, locale);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() =>
        router.push({
          pathname: '/tools/price-analytics/[productVariantId]',
          params: { productVariantId: row.productVariantId },
        })
      }
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-70"
    >
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {row.listingTitle}
        </Text>
        {row.variantTitle ? (
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {row.variantTitle}
          </Text>
        ) : null}
        <Text className="text-xs text-muted-foreground">
          {own === null
            ? t('priceAnalytics.noPrice')
            : t('priceAnalytics.yourPrice', { price: own })}
        </Text>
        {row.state === 'measured' && row.market ? (
          <Text className="text-xs text-muted-foreground">
            {t('priceAnalytics.marketLine', {
              sellers: row.market.otherSellers,
              lowest: rowMoney(row.market.lowestAmount, row.currency, locale) ?? '',
              median: rowMoney(row.market.medianAmount, row.currency, locale) ?? '',
            })}
          </Text>
        ) : (
          <Text className="text-xs text-muted-foreground">
            {t(REASON_LABEL_KEYS[row.reason ?? 'insufficient_observations'])}
          </Text>
        )}
        {!row.inComparison ? (
          <Text className="text-xs text-muted-foreground">{t('priceAnalytics.notShown')}</Text>
        ) : null}
      </View>
      {row.position ? (
        <View className={`rounded-full px-3 py-1 ${bandToneClass(row.position.band)}`}>
          <Text className="text-xs font-semibold text-foreground">
            {t(BAND_LABEL_KEYS[row.position.band])}
          </Text>
        </View>
      ) : null}
      <ChevronRight size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}
