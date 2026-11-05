import { useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import axios from 'axios';
import { ChevronLeft, Pencil, Plus, Trash2 } from 'lucide-react-native';
import type {
  Location,
  PosRegister,
  PosRegisterSalesRow,
  StoreCapabilityView,
} from '@mercaria/shared-types';
import { POS_REGISTER_NAME_MAX_LENGTH } from '@mercaria/shared-types';
import { Text, PriceDisplay, formatDate, toBloomIcon, useColorScheme } from '@mercaria/ui';
import { Button } from '@oxy.so/bloom/button';
import { Dialog, useDialogControl, type DialogControlProps } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { toast } from '@oxy.so/bloom/toast';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import { PlanToolGate, PlanUsage } from '@/components/plan-tools/PlanToolGate';
import { useTranslation } from '@/lib/i18n';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import { useLocations } from '@/lib/hooks/use-tax-and-locations';
import {
  useCreatePosRegister,
  usePosRegisterSummary,
  usePosRegisters,
  useRemovePosRegister,
  useRenamePosRegister,
} from '@/lib/hooks/use-pos-registers';
import { planRefusalOf } from '@/lib/plan-refusal';
import { reportCalendarDate } from '@/lib/report-range';

/** The summary windows offered, in days (1 = today, UTC). */
const SUMMARY_DAYS = ['1', '7', '30'] as const;
type SummaryDays = (typeof SUMMARY_DAYS)[number];

/** A KEY per window (#398): evaluated at import, before the locale rehydrates. */
const SUMMARY_DAYS_LABEL_KEYS: Record<SummaryDays, string> = {
  '1': 'posRegisters.summary.today',
  '7': 'posRegisters.summary.last7',
  '30': 'posRegisters.summary.last30',
};

const MS_PER_DAY = 86_400_000;

/**
 * POS registers — the paid `expanded_pos_registers` tool (#89).
 *
 * Every location keeps its one default register, which every device uses and
 * which stays free; this screen adds NAMED registers beside it, each counted
 * against the plan, and shows each register's daily sales.
 */
export default function PosRegistersScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('posRegisters.documentTitle')}</title>
      </Head>
      <RequireStore permission="locations:write">
        {(storeId) => <PosRegistersBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function PosRegistersBody({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
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
    <Screen title={t('posRegisters.title')} subtitle={t('posRegisters.subtitle')} action={back}>
      <PlanToolGate storeId={storeId} capability="expanded_pos_registers">
        {(view) => <PosRegistersTool storeId={storeId} view={view} />}
      </PlanToolGate>
    </Screen>
  );
}

/** What the dialog is doing: adding to a location, or renaming one register. */
type Editing = { kind: 'create'; location: Location } | { kind: 'rename'; register: PosRegister };

function PosRegistersTool({ storeId, view }: { storeId: string; view: StoreCapabilityView }) {
  const { t } = useTranslation();
  const { can } = useActiveStoreContext();
  const locations = useLocations(storeId);
  const registers = usePosRegisters(storeId);
  const remove = useRemovePosRegister(storeId);
  const dialog = useDialogControl();
  const [editing, setEditing] = useState<Editing | null>(null);

  if (locations.isPending || registers.isPending) return <ScreenLoading />;
  if (locations.isError || registers.isError || !locations.data || !registers.data) {
    return <ScreenMessage title={t('posRegisters.loadFailed')} body={t('common.pleaseTryAgain')} />;
  }

  const all = registers.data.registers;
  const live = all.filter((register) => !register.archivedAt);

  const open = (next: Editing) => {
    setEditing(next);
    dialog.open();
  };

  const onRemove = (register: PosRegister) =>
    remove.mutate(register.id, {
      onSuccess: (result) =>
        toast.success(
          t(result.outcome === 'archived' ? 'posRegisters.archived' : 'posRegisters.deleted', {
            name: register.name,
          }),
        ),
      onError: () => toast.error(t('posRegisters.removeFailed')),
    });

  return (
    <View className="gap-6">
      <View className="gap-1">
        <PlanUsage view={view} />
        <Text className="text-sm text-muted-foreground">{t('posRegisters.defaultExplainer')}</Text>
      </View>

      <View className="gap-4">
        {locations.data.map((location) => (
          <LocationRegisters
            key={location.id}
            location={location}
            registers={live.filter((register) => register.locationId === location.id)}
            onAdd={() => open({ kind: 'create', location })}
            onRename={(register) => open({ kind: 'rename', register })}
            onRemove={onRemove}
          />
        ))}
      </View>

      {can('stats:read') ? (
        <RegisterSummary storeId={storeId} locations={locations.data} registers={all} />
      ) : null}

      <RegisterDialog storeId={storeId} control={dialog} editing={editing} />
    </View>
  );
}

function LocationRegisters({
  location,
  registers,
  onAdd,
  onRename,
  onRemove,
}: {
  location: Location;
  registers: PosRegister[];
  onAdd: () => void;
  onRename: (register: PosRegister) => void;
  onRemove: (register: PosRegister) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  return (
    <View className="gap-2 rounded-2xl border border-border bg-surface p-4">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm font-semibold text-foreground">{location.name}</Text>
        <Button appearance="outline" tone="neutral" leadingIcon={toBloomIcon(Plus)} onPress={onAdd}>
          {t('posRegisters.add')}
        </Button>
      </View>
      <View className="rounded-lg bg-muted px-3 py-2">
        <Text className="text-sm font-medium text-foreground">{t('posRegisters.defaultName')}</Text>
        <Text className="text-xs text-muted-foreground">{t('posRegisters.defaultMeta')}</Text>
      </View>
      {registers.map((register) => (
        <View key={register.id} className="flex-row items-center gap-2 px-3 py-1">
          <Text className="flex-1 text-sm text-foreground">{register.name}</Text>
          <Pressable
            onPress={() => onRename(register)}
            accessibilityRole="button"
            accessibilityLabel={t('posRegisters.renameAction', { name: register.name })}
            className="p-2 active:opacity-70"
          >
            <Pencil size={16} color={colors.mutedForeground} />
          </Pressable>
          <Pressable
            onPress={() => onRemove(register)}
            accessibilityRole="button"
            accessibilityLabel={t('posRegisters.removeAction', { name: register.name })}
            className="p-2 active:opacity-70"
          >
            <Trash2 size={16} color={colors.mutedForeground} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/** A refused write, said calmly: the plan, the allowance, a taken name, or a plain failure. */
function writeErrorKey(error: unknown): string {
  const refusal = planRefusalOf(error);
  if (refusal === 'limit') return 'posRegisters.limitReached';
  if (refusal === 'capability') return 'posRegisters.notIncluded';
  if (axios.isAxiosError(error) && error.response?.status === 409) return 'posRegisters.nameTaken';
  return 'posRegisters.saveFailed';
}

function RegisterDialog({
  storeId,
  control,
  editing,
}: {
  storeId: string;
  control: DialogControlProps;
  editing: Editing | null;
}) {
  const { t } = useTranslation();
  const create = useCreatePosRegister(storeId);
  const rename = useRenamePosRegister(storeId);
  const [name, setName] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);

  // Reset the field whenever the dialog opens on something else.
  const key = editing
    ? editing.kind === 'create'
      ? `create:${editing.location.id}`
      : `rename:${editing.register.id}`
    : null;
  if (key !== editingKey) {
    setEditingKey(key);
    setName(editing?.kind === 'rename' ? editing.register.name : '');
  }

  const submit = () => {
    const trimmed = name.trim();
    if (!editing) return;
    if (!trimmed) {
      toast.error(t('posRegisters.nameRequired'));
      return;
    }
    const done = {
      onSuccess: () => {
        toast.success(t('posRegisters.saved'));
        control.close();
      },
      onError: (error: unknown) => toast.error(t(writeErrorKey(error))),
    };
    if (editing.kind === 'create') {
      create.mutate({ locationId: editing.location.id, name: trimmed }, done);
    } else {
      rename.mutate({ id: editing.register.id, name: trimmed }, done);
    }
  };

  const title =
    editing?.kind === 'rename'
      ? t('posRegisters.renameTitle')
      : t('posRegisters.newTitle', { location: editing?.location.name ?? '' });

  return (
    <Dialog control={control} title={title}>
      <View className="gap-4">
        <Field label={t('common.name')}>
          <TextFieldInput
            label={t('common.name')}
            value={name}
            onValueChange={setName}
            maxLength={POS_REGISTER_NAME_MAX_LENGTH}
            placeholder={t('posRegisters.namePlaceholder')}
          />
        </Field>
        <Button
          tone="accent"
          onPress={submit}
          loading={create.isPending || rename.isPending}
          className="mt-1"
        >
          {editing?.kind === 'rename' ? t('common.save') : t('common.create')}
        </Button>
      </View>
    </Dialog>
  );
}

/** The window `[from, to]` for "the last `days` UTC days, today included". */
function summaryWindow(days: SummaryDays): { from: string; to: string } {
  const now = new Date();
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(startOfToday - (Number(days) - 1) * MS_PER_DAY);
  return { from: from.toISOString(), to: now.toISOString() };
}

function RegisterSummary({
  storeId,
  locations,
  registers,
}: {
  storeId: string;
  locations: Location[];
  registers: PosRegister[];
}) {
  const { t, locale } = useTranslation();
  const [days, setDays] = useState<SummaryDays>('7');
  // Computed per choice, not per render, so the query key stays stable.
  const range = useMemo(() => summaryWindow(days), [days]);
  const summary = usePosRegisterSummary(storeId, range.from, range.to);

  const registerNames = useMemo(
    () => new Map(registers.map((register) => [register.id, register.name])),
    [registers],
  );
  const locationNames = useMemo(
    () => new Map(locations.map((location) => [location.id, location.name])),
    [locations],
  );

  const byDay = useMemo(() => {
    const groups = new Map<string, PosRegisterSalesRow[]>();
    for (const row of summary.data?.rows ?? []) {
      const group = groups.get(row.day) ?? [];
      group.push(row);
      groups.set(row.day, group);
    }
    return [...groups.entries()];
  }, [summary.data]);

  const registerLabel = (row: PosRegisterSalesRow) => {
    const name =
      row.registerId === null
        ? t('posRegisters.defaultName')
        : (registerNames.get(row.registerId) ?? t('posRegisters.unknownRegister'));
    const location = row.locationId ? locationNames.get(row.locationId) : undefined;
    return location ? t('posRegisters.summary.atLocation', { name, location }) : name;
  };

  return (
    <View className="gap-3">
      <View className="gap-1">
        <Text className="text-base font-semibold text-foreground">
          {t('posRegisters.summary.title')}
        </Text>
        <Text className="text-xs text-muted-foreground">{t('posRegisters.summary.note')}</Text>
      </View>
      <SegmentedControl
        type="radio"
        value={days}
        onValueChange={(value) => setDays(value as SummaryDays)}
      >
        {SUMMARY_DAYS.map((option) => (
          <SegmentedControlItem key={option} value={option}>
            <SegmentedControlItemText>
              {t(SUMMARY_DAYS_LABEL_KEYS[option])}
            </SegmentedControlItemText>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>

      {summary.isPending ? (
        <ScreenLoading />
      ) : summary.isError ? (
        <ScreenMessage
          title={t('posRegisters.summary.loadFailed')}
          body={t('common.pleaseTryAgain')}
        />
      ) : byDay.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{t('posRegisters.summary.empty')}</Text>
      ) : (
        <View className="gap-3">
          {byDay.map(([day, rows]) => (
            <View key={day} className="gap-2 rounded-2xl border border-border bg-surface p-4">
              <Text className="text-sm font-semibold text-foreground">
                {formatDate(reportCalendarDate(day), locale)}
              </Text>
              {rows.map((row) => (
                <View
                  key={`${row.locationId ?? ''}:${row.registerId ?? 'default'}:${row.grossSales.currency}`}
                  className="flex-row items-center justify-between gap-3"
                >
                  <View className="flex-1">
                    <Text className="text-sm text-foreground">{registerLabel(row)}</Text>
                    <Text className="text-xs text-muted-foreground">
                      {t('posRegisters.summary.sales', { count: row.salesCount })}
                    </Text>
                  </View>
                  <PriceDisplay price={row.grossSales} primaryClassName="text-sm font-semibold" />
                </View>
              ))}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
