import { useState } from 'react';
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { ChevronLeft, Plus, Trash2, Pencil, CalendarClock } from 'lucide-react-native';
import {
  DATA_EXPORT_CADENCES,
  DATA_EXPORT_DATASET_PERMISSIONS,
  DATA_EXPORT_DATASETS,
  DATA_EXPORT_MAX_DAY_OF_MONTH,
  type DataExportCadence,
  type DataExportDataset,
  type DataExportScheduleView,
  type StoreCapabilityView,
} from '@mercaria/shared-types';
import { Text, formatDateTime, formatWeekday, toBloomIcon, useColorScheme } from '@mercaria/ui';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import { PlanToolGate, PlanUsage } from '@/components/plan-tools/PlanToolGate';
import {
  DATA_EXPORT_DATASET_LABEL_KEYS,
  ExportRunList,
} from '@/components/data-exports/ExportRunList';
import { useTranslation } from '@/lib/i18n';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import { planRefusalOf } from '@/lib/plan-refusal';
import {
  useCreateDataExportSchedule,
  useDataExportRuns,
  useDataExportSchedules,
  useDeleteDataExportSchedule,
  useUpdateDataExportSchedule,
} from '@/lib/hooks/use-data-exports';

/** Translation KEYS per cadence (#398). */
const CADENCE_LABEL_KEYS: Record<DataExportCadence, string> = {
  daily: 'scheduledExports.cadence.daily',
  weekly: 'scheduledExports.cadence.weekly',
  monthly: 'scheduledExports.cadence.monthly',
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const DAYS_OF_MONTH = Array.from({ length: DATA_EXPORT_MAX_DAY_OF_MONTH }, (_, index) => index + 1);

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Scheduled exports — the paid tool (`scheduled_exports`): the store's orders,
 * products or customers as CSV on a cadence, each run taking one export from
 * the billing period's allowance.
 *
 * Exporting on demand is free and lives at `/settings/exports`; this screen
 * links there. A store without the tool still reaches its existing schedules'
 * history through that screen.
 */
export default function ScheduledExportsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('scheduledExports.documentTitle')}</title>
      </Head>
      <RequireStore>{(storeId) => <ScheduledExportsBody storeId={storeId} />}</RequireStore>
    </>
  );
}

function ScheduledExportsBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();

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
    <Screen
      title={t('scheduledExports.title')}
      subtitle={t('scheduledExports.subtitle')}
      action={back}
    >
      <PlanToolGate storeId={storeId} capability="scheduled_exports">
        {(view) => <ScheduledExportsTool storeId={storeId} view={view} />}
      </PlanToolGate>
      <Pressable
        onPress={() => router.push('/settings/exports')}
        className="mt-6 flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-80"
      >
        <Text className="flex-1 text-xs text-muted-foreground">
          {t('scheduledExports.onDemandLink')}
        </Text>
      </Pressable>
    </Screen>
  );
}

type DialogState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; schedule: DataExportScheduleView };

function ScheduledExportsTool({ storeId, view }: { storeId: string; view: StoreCapabilityView }) {
  const { t } = useTranslation();
  const { can } = useActiveStoreContext();
  const schedules = useDataExportSchedules(storeId);
  const runs = useDataExportRuns(storeId);
  const [dialog, setDialog] = useState<DialogState>({ mode: 'closed' });
  const datasets = DATA_EXPORT_DATASETS.filter((dataset) =>
    can(DATA_EXPORT_DATASET_PERMISSIONS[dataset]),
  );

  return (
    <View className="gap-6">
      <View className="flex-row items-center justify-between gap-3">
        <PlanUsage view={view} />
        {datasets.length > 0 ? (
          <Button
            tone="accent"
            leadingIcon={toBloomIcon(Plus)}
            onPress={() => setDialog({ mode: 'create' })}
          >
            {t('scheduledExports.newSchedule')}
          </Button>
        ) : null}
      </View>

      {schedules.isPending ? (
        <ScreenLoading />
      ) : schedules.isError ? (
        <ScreenMessage title={t('scheduledExports.loadFailed')} body={t('common.pleaseTryAgain')} />
      ) : (schedules.data?.length ?? 0) === 0 ? (
        <ScreenMessage
          title={t('scheduledExports.emptyTitle')}
          body={t('scheduledExports.emptyBody')}
        />
      ) : (
        <View className="gap-2">
          {schedules.data?.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              storeId={storeId}
              schedule={schedule}
              onEdit={() => setDialog({ mode: 'edit', schedule })}
            />
          ))}
        </View>
      )}

      <View className="gap-2">
        <Text className="text-base font-semibold text-foreground">
          {t('scheduledExports.historyTitle')}
        </Text>
        <Text className="text-xs text-muted-foreground">{t('dataExports.retentionNote')}</Text>
        {runs.isPending ? (
          <ScreenLoading />
        ) : runs.isError ? (
          <ScreenMessage title={t('dataExports.loadFailed')} body={t('common.pleaseTryAgain')} />
        ) : (
          <ExportRunList
            storeId={storeId}
            runs={(runs.data ?? []).filter((run) => run.trigger === 'schedule')}
          />
        )}
      </View>

      {dialog.mode !== 'closed' ? (
        <ScheduleDialog
          key={dialog.mode === 'edit' ? dialog.schedule.id : 'create'}
          storeId={storeId}
          datasets={datasets}
          schedule={dialog.mode === 'edit' ? dialog.schedule : undefined}
          onClose={() => setDialog({ mode: 'closed' })}
        />
      ) : null}
    </View>
  );
}

/** "Weekly on Monday at 06:00 (Europe/Madrid)". */
function useCadenceSummary() {
  const { t, locale } = useTranslation();
  return (
    schedule: Pick<
      DataExportScheduleView,
      'cadence' | 'hour' | 'weekday' | 'dayOfMonth' | 'timeZone'
    >,
  ) => {
    const at = hourLabel(schedule.hour);
    switch (schedule.cadence) {
      case 'daily':
        return t('scheduledExports.summary.daily', { at, zone: schedule.timeZone });
      case 'weekly':
        return t('scheduledExports.summary.weekly', {
          day: formatWeekday(schedule.weekday ?? 1, locale),
          at,
          zone: schedule.timeZone,
        });
      case 'monthly':
        return t('scheduledExports.summary.monthly', {
          day: schedule.dayOfMonth ?? 1,
          at,
          zone: schedule.timeZone,
        });
    }
  };
}

function refusalMessage(error: unknown, t: (key: string) => string, fallback: string): string {
  const refusal = planRefusalOf(error);
  if (refusal === 'capability') return t('scheduledExports.refusedCapability');
  if (refusal === 'limit') return t('scheduledExports.refusedLimit');
  return t(fallback);
}

function ScheduleRow({
  storeId,
  schedule,
  onEdit,
}: {
  storeId: string;
  schedule: DataExportScheduleView;
  onEdit: () => void;
}) {
  const { t, locale } = useTranslation();
  const { colors } = useColorScheme();
  const summary = useCadenceSummary();
  const update = useUpdateDataExportSchedule(storeId);
  const remove = useDeleteDataExportSchedule(storeId);
  const [confirming, setConfirming] = useState(false);

  const toggle = (enabled: boolean) =>
    update.mutate(
      { id: schedule.id, patch: { enabled } },
      {
        onSuccess: () =>
          toast.success(t(enabled ? 'scheduledExports.resumed' : 'scheduledExports.paused')),
        onError: (error) => toast.error(refusalMessage(error, t, 'scheduledExports.saveFailed')),
      },
    );

  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3">
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
        <CalendarClock size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1 gap-1">
        <Text className="text-sm font-semibold text-foreground">
          {t(DATA_EXPORT_DATASET_LABEL_KEYS[schedule.dataset])}
        </Text>
        <Text className="text-xs text-muted-foreground">{summary(schedule)}</Text>
        <Text className="text-xs text-muted-foreground">
          {schedule.enabled && schedule.nextRunAt
            ? t('scheduledExports.nextRun', {
                at: formatDateTime(schedule.nextRunAt, locale) ?? '',
              })
            : t('scheduledExports.pausedLabel')}
        </Text>
      </View>
      <Switch
        checked={schedule.enabled}
        disabled={update.isPending}
        onCheckedChange={toggle}
        accessibilityLabel={t('scheduledExports.enabledLabel')}
      />
      <Pressable
        onPress={onEdit}
        accessibilityLabel={t('scheduledExports.edit')}
        className="p-2 active:opacity-70"
      >
        <Pencil size={16} color={colors.mutedForeground} />
      </Pressable>
      <Pressable
        onPress={() => setConfirming(true)}
        accessibilityLabel={t('scheduledExports.delete')}
        className="p-2 active:opacity-70"
      >
        <Trash2 size={16} color={colors.mutedForeground} />
      </Pressable>
      <Dialog
        open={confirming}
        title={t('scheduledExports.deleteTitle')}
        dismissOnBackdrop={!remove.isPending}
        onClose={() => {
          if (!remove.isPending) setConfirming(false);
        }}
      >
        <View className="gap-3">
          <Text className="text-sm text-foreground">{t('scheduledExports.deleteBody')}</Text>
          <Button
            appearance="outline"
            disabled={remove.isPending}
            onPress={() => setConfirming(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button
            tone="danger"
            loading={remove.isPending}
            onPress={() =>
              remove.mutate(schedule.id, {
                onSuccess: () => {
                  setConfirming(false);
                  toast.success(t('scheduledExports.deleted'));
                },
                onError: () => toast.error(t('scheduledExports.deleteFailed')),
              })
            }
          >
            {t('scheduledExports.delete')}
          </Button>
        </View>
      </Dialog>
    </View>
  );
}

function ChoiceSelect({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger label={label}>
          <SelectValue />
          <SelectIcon />
        </SelectTrigger>
        <SelectContent
          label={label}
          items={items}
          renderItem={(item) => (
            <SelectItem value={item.value} label={item.label}>
              <SelectItemText>{item.label}</SelectItemText>
              <SelectItemIndicator />
            </SelectItem>
          )}
        />
      </Select>
    </Field>
  );
}

/** Create a schedule, or edit one's timing. The dataset of an existing schedule is fixed. */
function ScheduleDialog({
  storeId,
  datasets,
  schedule,
  onClose,
}: {
  storeId: string;
  datasets: readonly DataExportDataset[];
  schedule: DataExportScheduleView | undefined;
  onClose: () => void;
}) {
  const { t, locale } = useTranslation();
  const create = useCreateDataExportSchedule(storeId);
  const update = useUpdateDataExportSchedule(storeId);
  const [dataset, setDataset] = useState<DataExportDataset>(
    schedule?.dataset ?? datasets[0] ?? 'orders',
  );
  const [cadence, setCadence] = useState<DataExportCadence>(schedule?.cadence ?? 'daily');
  const [hour, setHour] = useState(schedule?.hour ?? 6);
  const [weekday, setWeekday] = useState(schedule?.weekday ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState(schedule?.dayOfMonth ?? 1);
  const [timeZone, setTimeZone] = useState(schedule?.timeZone ?? deviceTimeZone());
  const pending = create.isPending || update.isPending;

  const timing = {
    cadence,
    hour,
    timeZone: timeZone.trim(),
    ...(cadence === 'weekly' ? { weekday } : {}),
    ...(cadence === 'monthly' ? { dayOfMonth } : {}),
  };

  const submit = () => {
    if (!timing.timeZone) {
      toast.error(t('scheduledExports.timeZoneRequired'));
      return;
    }
    const onError = (error: unknown) =>
      toast.error(refusalMessage(error, t, 'scheduledExports.saveFailed'));
    const onSuccess = () => {
      toast.success(t(schedule ? 'scheduledExports.saved' : 'scheduledExports.created'));
      onClose();
    };
    if (schedule) {
      update.mutate(
        {
          id: schedule.id,
          patch: {
            ...timing,
            weekday: cadence === 'weekly' ? weekday : null,
            dayOfMonth: cadence === 'monthly' ? dayOfMonth : null,
          },
        },
        { onSuccess, onError },
      );
    } else {
      create.mutate({ dataset, ...timing }, { onSuccess, onError });
    }
  };

  return (
    <Dialog
      open
      title={t(schedule ? 'scheduledExports.editTitle' : 'scheduledExports.newTitle')}
      dismissOnBackdrop={!pending}
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <View className="gap-4">
        {schedule ? null : (
          <ChoiceSelect
            label={t('scheduledExports.datasetLabel')}
            value={dataset}
            items={datasets.map((value) => ({
              value,
              label: t(DATA_EXPORT_DATASET_LABEL_KEYS[value]),
            }))}
            onChange={(value) => {
              const next = datasets.find((candidate) => candidate === value);
              if (next) setDataset(next);
            }}
          />
        )}
        <Field label={t('scheduledExports.cadenceLabel')}>
          <SegmentedControl
            type="radio"
            value={cadence}
            onValueChange={(value: string) => {
              const next = DATA_EXPORT_CADENCES.find((candidate) => candidate === value);
              if (next) setCadence(next);
            }}
          >
            {DATA_EXPORT_CADENCES.map((value) => (
              <SegmentedControlItem key={value} value={value}>
                <SegmentedControlItemText>{t(CADENCE_LABEL_KEYS[value])}</SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Field>
        {cadence === 'weekly' ? (
          <ChoiceSelect
            label={t('scheduledExports.weekdayLabel')}
            value={String(weekday)}
            items={WEEKDAYS.map((value) => ({
              value: String(value),
              label: formatWeekday(value, locale),
            }))}
            onChange={(value) => setWeekday(Number(value))}
          />
        ) : null}
        {cadence === 'monthly' ? (
          <ChoiceSelect
            label={t('scheduledExports.dayOfMonthLabel')}
            value={String(dayOfMonth)}
            items={DAYS_OF_MONTH.map((value) => ({ value: String(value), label: String(value) }))}
            onChange={(value) => setDayOfMonth(Number(value))}
          />
        ) : null}
        <ChoiceSelect
          label={t('scheduledExports.hourLabel')}
          value={String(hour)}
          items={HOURS.map((value) => ({ value: String(value), label: hourLabel(value) }))}
          onChange={(value) => setHour(Number(value))}
        />
        <Field label={t('scheduledExports.timeZoneLabel')}>
          <TextFieldInput
            label={t('scheduledExports.timeZoneLabel')}
            value={timeZone}
            onValueChange={setTimeZone}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
        <Text className="text-xs text-muted-foreground">{t('scheduledExports.allowanceNote')}</Text>
        <Button tone="accent" onPress={submit} loading={pending}>
          {t(schedule ? 'common.save' : 'common.create')}
        </Button>
      </View>
    </Dialog>
  );
}
