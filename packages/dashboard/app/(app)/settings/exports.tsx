import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { ChevronLeft, CalendarClock, FileDown } from 'lucide-react-native';
import { DATA_EXPORT_DATASET_PERMISSIONS, DATA_EXPORT_DATASETS } from '@mercaria/shared-types';
import { Text, useColorScheme } from '@mercaria/ui';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import {
  DATA_EXPORT_DATASET_LABEL_KEYS,
  ExportRunList,
} from '@/components/data-exports/ExportRunList';
import { useTranslation } from '@/lib/i18n';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import { useDataExportRuns, useRequestDataExport } from '@/lib/hooks/use-data-exports';

/**
 * Export data — the store's own orders, products and customers as CSV, on
 * demand, for every store whatever its plan (`data_export` is ungateable).
 *
 * The paid tool is the SCHEDULE over this same file (`/tools/scheduled-exports`);
 * this screen links to it and is never gated by it.
 */
export default function ExportsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('dataExports.documentTitle')}</title>
      </Head>
      <RequireStore>{(storeId) => <ExportsBody storeId={storeId} />}</RequireStore>
    </>
  );
}

function ExportsBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { can } = useActiveStoreContext();
  const runs = useDataExportRuns(storeId);
  const request = useRequestDataExport(storeId);
  const datasets = DATA_EXPORT_DATASETS.filter((dataset) =>
    can(DATA_EXPORT_DATASET_PERMISSIONS[dataset]),
  );

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">{t('common.back')}</Text>
    </Pressable>
  );

  return (
    <Screen title={t('dataExports.title')} subtitle={t('dataExports.subtitle')} action={back}>
      <View className="gap-6">
        <View className="gap-2">
          {datasets.map((dataset) => (
            <View
              key={dataset}
              className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4"
            >
              <FileDown size={18} color={colors.mutedForeground} />
              <Text className="flex-1 text-sm font-semibold text-foreground">
                {t(DATA_EXPORT_DATASET_LABEL_KEYS[dataset])}
              </Text>
              <Button
                tone="accent"
                loading={request.isPending && request.variables === dataset}
                onPress={() =>
                  request.mutate(dataset, {
                    onSuccess: () => toast.success(t('dataExports.requested')),
                    onError: () => toast.error(t('dataExports.requestFailed')),
                  })
                }
              >
                {t('dataExports.exportNow')}
              </Button>
            </View>
          ))}
          <Text className="text-xs text-muted-foreground">{t('dataExports.retentionNote')}</Text>
        </View>

        <Pressable
          onPress={() => router.push('/tools/scheduled-exports')}
          className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-80"
        >
          <CalendarClock size={18} color={colors.mutedForeground} />
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">
              {t('dataExports.scheduleLinkTitle')}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {t('dataExports.scheduleLinkBody')}
            </Text>
          </View>
        </Pressable>

        <View className="gap-2">
          <Text className="text-base font-semibold text-foreground">
            {t('dataExports.historyTitle')}
          </Text>
          {runs.isPending ? (
            <ScreenLoading />
          ) : runs.isError ? (
            <ScreenMessage title={t('dataExports.loadFailed')} body={t('common.pleaseTryAgain')} />
          ) : (
            <ExportRunList storeId={storeId} runs={runs.data ?? []} />
          )}
        </View>
      </View>
    </Screen>
  );
}
