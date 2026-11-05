import { View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Download } from 'lucide-react-native';
import type {
  DataExportDataset,
  DataExportRunFailure,
  DataExportRunStatus,
  DataExportRunView,
} from '@mercaria/shared-types';
import { Text, formatDateTime, toBloomIcon } from '@mercaria/ui';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import type { AccentTone } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from '@/lib/i18n';
import { useDataExportDownload } from '@/lib/hooks/use-data-exports';

/**
 * Translation KEYS, not sentences (#398): module scope is evaluated before the
 * locale store rehydrates.
 */
export const DATA_EXPORT_DATASET_LABEL_KEYS: Record<DataExportDataset, string> = {
  orders: 'dataExports.datasets.orders',
  products: 'dataExports.datasets.products',
  customers: 'dataExports.datasets.customers',
};

const STATUS_LABEL_KEYS: Record<DataExportRunStatus, string> = {
  pending: 'dataExports.status.pending',
  running: 'dataExports.status.running',
  succeeded: 'dataExports.status.succeeded',
  failed: 'dataExports.status.failed',
  skipped_limit: 'dataExports.status.skippedLimit',
  skipped_not_entitled: 'dataExports.status.skippedNotEntitled',
};

const FAILURE_KEYS: Record<DataExportRunFailure, string> = {
  generation_failed: 'dataExports.failure.generationFailed',
  storage_unavailable: 'dataExports.failure.storageUnavailable',
};

const TONES: Record<DataExportRunStatus, AccentTone> = {
  pending: 'default',
  running: 'default',
  succeeded: 'primary',
  failed: 'error',
  skipped_limit: 'default',
  skipped_not_entitled: 'default',
};

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  // Whole units: a fraction would need the locale's decimal separator, and a
  // file size is a rough figure either way.
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** The export history: what ran, what it held, and a download while the file is kept. */
export function ExportRunList({
  storeId,
  runs,
}: {
  storeId: string;
  runs: readonly DataExportRunView[];
}) {
  const { t, locale } = useTranslation();
  const download = useDataExportDownload(storeId);

  const open = (runId: string) =>
    download.mutate(runId, {
      onSuccess: async (link) => {
        await WebBrowser.openBrowserAsync(link.url);
      },
      onError: () => toast.error(t('dataExports.downloadFailed')),
    });

  if (runs.length === 0) {
    return <Text className="text-sm text-muted-foreground">{t('dataExports.noRuns')}</Text>;
  }

  return (
    <View className="gap-2">
      {runs.map((run) => {
        const when = formatDateTime(run.occurrenceAt ?? run.createdAt, locale) ?? '';
        const details: string[] = [];
        if (run.rowCount !== null) details.push(t('dataExports.rows', { rows: run.rowCount }));
        if (run.byteSize !== null) details.push(sizeLabel(run.byteSize));
        if (run.truncated) details.push(t('dataExports.truncated'));
        if (run.failure) details.push(t(FAILURE_KEYS[run.failure]));
        if (run.status === 'succeeded' && !run.downloadable) details.push(t('dataExports.expired'));
        return (
          <View
            key={run.id}
            className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3"
          >
            <View className="flex-1 gap-1">
              <View className="flex-row flex-wrap items-center gap-2">
                <Text className="text-sm font-semibold text-foreground">
                  {t(DATA_EXPORT_DATASET_LABEL_KEYS[run.dataset])}
                </Text>
                <Badge
                  size="label-small"
                  variant="subtle"
                  color={TONES[run.status]}
                  content={t(STATUS_LABEL_KEYS[run.status])}
                />
                <Text className="text-xs text-muted-foreground">
                  {t(
                    run.trigger === 'schedule'
                      ? 'dataExports.triggerSchedule'
                      : 'dataExports.triggerOnDemand',
                  )}
                </Text>
              </View>
              <Text className="text-xs text-muted-foreground">
                {[when, ...details].filter(Boolean).join(' · ')}
              </Text>
            </View>
            {run.downloadable ? (
              <Button
                tone="neutral"
                leadingIcon={toBloomIcon(Download)}
                onPress={() => open(run.id)}
                loading={download.isPending && download.variables === run.id}
              >
                {t('dataExports.download')}
              </Button>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
