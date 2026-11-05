import { useEffect, useState } from 'react';
import { Platform, Pressable, Share, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { ChevronLeft, Download } from 'lucide-react-native';
import {
  REPLENISHMENT_ROW_STATUSES,
  REPLENISHMENT_SETTING_BOUNDS,
  REPLENISHMENT_SETTING_KEYS,
  type ReplenishmentPlan,
  type ReplenishmentPlanRow,
  type ReplenishmentRowStatus,
  type ReplenishmentSettingKey,
  type ReplenishmentSettingValues,
  type ReplenishmentVariantOverride,
} from '@mercaria/shared-types';
import { Text, toBloomIcon, useColorScheme } from '@mercaria/ui';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Dialog, useDialogControl, type DialogControlProps } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
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
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import type { AccentTone } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import { PlanToolGate } from '@/components/plan-tools/PlanToolGate';
import { useTranslation } from '@/lib/i18n';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import {
  useDeleteReplenishmentOverride,
  useReplenishmentPlan,
  useReplenishmentSettings,
  useSaveReplenishmentOverride,
  useSaveReplenishmentSettings,
} from '@/lib/hooks/use-replenishment';
import { fetchReplenishmentCsv, type ReplenishmentPlanFilters } from '@/lib/api/replenishment';
import { planRefusalOf } from '@/lib/plan-refusal';

/**
 * Replenishment planning (a paid tool, `replenishment_planning`): the store's
 * demand forecast and purchase suggestions over its own multi-location stock.
 *
 * Reading needs `products:read` and `stats:read` (a row is stock beside sales);
 * the settings are editable with `inventory:write`. The plan is a list to
 * export — nothing here orders from a supplier.
 */
export default function ReplenishmentScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('replenishment.documentTitle')}</title>
      </Head>
      <RequireStore permission="products:read">
        {(storeId) => <ReplenishmentBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

// KEYS, not sentences (#398): evaluated at import, before the locale rehydrates.
const STATUS_LABEL_KEYS: Record<ReplenishmentRowStatus, string> = {
  stocked_out: 'replenishment.status.stockedOut',
  reorder_now: 'replenishment.status.reorderNow',
  healthy: 'replenishment.status.healthy',
  no_recent_sales: 'replenishment.status.noRecentSales',
};
const STATUS_TONES: Record<ReplenishmentRowStatus, AccentTone> = {
  stocked_out: 'error',
  reorder_now: 'warning',
  healthy: 'success',
  no_recent_sales: 'default',
};
const SETTING_LABEL_KEYS: Record<ReplenishmentSettingKey, string> = {
  leadTimeDays: 'replenishment.settings.leadTime',
  targetCoverDays: 'replenishment.settings.targetCover',
  safetyStockDays: 'replenishment.settings.safetyStock',
};
const ALL = 'all';

function ReplenishmentBody({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
  const { can } = useActiveStoreContext();
  const [filters, setFilters] = useState<ReplenishmentPlanFilters>({
    locationId: null,
    status: null,
  });
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const csv = await fetchReplenishmentCsv(storeId, filters);
      const filename = `replenishment-${new Date().toISOString().slice(0, 10)}.csv`;
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(url);
      } else {
        await Share.share({ title: filename, message: csv });
      }
    } catch (error) {
      toast.error(
        planRefusalOf(error) ? t('replenishment.planRefused') : t('replenishment.exportFailed'),
      );
    } finally {
      setExporting(false);
    }
  };

  const action = (
    <View className="flex-row flex-wrap items-center justify-end gap-2">
      <Pressable
        onPress={() => router.back()}
        className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
      >
        <ChevronLeft size={16} color={colors.foreground} />
        <Text className="text-sm font-medium text-foreground">{t('common.back')}</Text>
      </Pressable>
    </View>
  );

  if (!can('stats:read')) {
    return (
      <Screen title={t('replenishment.title')} action={action}>
        <ScreenMessage title={t('common.noAccess')} body={t('common.noAccessBody')} />
      </Screen>
    );
  }

  return (
    <Screen title={t('replenishment.title')} subtitle={t('replenishment.subtitle')} action={action}>
      <PlanToolGate storeId={storeId} capability="replenishment_planning">
        {() => (
          <View className="gap-6">
            <PlanSection
              storeId={storeId}
              filters={filters}
              onFiltersChange={setFilters}
              onExport={() => {
                void exportCsv();
              }}
              exporting={exporting}
            />
            <SettingsSection storeId={storeId} canEdit={can('inventory:write')} />
            <HowItWorks />
          </View>
        )}
      </PlanToolGate>
    </Screen>
  );
}

function PlanSection({
  storeId,
  filters,
  onFiltersChange,
  onExport,
  exporting,
}: {
  storeId: string;
  filters: ReplenishmentPlanFilters;
  onFiltersChange: (next: ReplenishmentPlanFilters) => void;
  onExport: () => void;
  exporting: boolean;
}) {
  const { t } = useTranslation();
  const { can } = useActiveStoreContext();
  const plan = useReplenishmentPlan(storeId, filters);
  const overrideControl = useDialogControl();
  const [editing, setEditing] = useState<ReplenishmentPlanRow | null>(null);
  const canEdit = can('inventory:write');

  if (plan.isPending) return <ScreenLoading />;
  if (plan.isError || !plan.data) {
    return (
      <ScreenMessage
        title={
          planRefusalOf(plan.error) ? t('replenishment.planRefused') : t('replenishment.loadFailed')
        }
        body={t('common.pleaseTryAgain')}
      />
    );
  }
  const data = plan.data;

  const locationOptions = [
    { value: ALL, label: t('replenishment.filters.allLocations') },
    ...data.locations.map((location) => ({ value: location.id, label: location.name })),
  ];
  const statusOptions = [
    { value: ALL, label: t('replenishment.filters.allStatuses') },
    ...REPLENISHMENT_ROW_STATUSES.map((status) => ({
      value: status,
      label: t(STATUS_LABEL_KEYS[status]),
    })),
  ];

  return (
    <View className="gap-4">
      <Summary plan={data} />
      <View className="flex-row flex-wrap items-end gap-3">
        <FilterSelect
          label={t('replenishment.filters.location')}
          value={filters.locationId ?? ALL}
          options={locationOptions}
          onChange={(value) =>
            onFiltersChange({ ...filters, locationId: value === ALL ? null : value })
          }
        />
        <FilterSelect
          label={t('replenishment.filters.status')}
          value={filters.status ?? ALL}
          options={statusOptions}
          onChange={(value) =>
            onFiltersChange({
              ...filters,
              status: value === ALL ? null : (value as ReplenishmentRowStatus),
            })
          }
        />
        <Button
          tone="accent"
          leadingIcon={toBloomIcon(Download)}
          onPress={onExport}
          loading={exporting}
        >
          {t('replenishment.exportCsv')}
        </Button>
      </View>
      {data.truncated ? (
        <Text className="text-xs text-muted-foreground">{t('replenishment.truncated')}</Text>
      ) : null}
      {data.rows.length === 0 ? (
        <ScreenMessage title={t('replenishment.emptyTitle')} body={t('replenishment.emptyBody')} />
      ) : (
        <PlanTable
          rows={data.rows}
          onEdit={
            canEdit
              ? (row) => {
                  setEditing(row);
                  overrideControl.open();
                }
              : undefined
          }
        />
      )}
      {data.totalRows > data.rows.length ? (
        <Text className="text-xs text-muted-foreground">
          {t('replenishment.moreRows', { shown: data.rows.length, total: data.totalRows })}
        </Text>
      ) : null}
      <OverrideDialog storeId={storeId} control={overrideControl} row={editing} />
    </View>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <View className="min-w-48">
      <Select value={value} onValueChange={(next) => onChange(String(next))}>
        <SelectTrigger label={label}>
          <SelectValue />
          <SelectIcon />
        </SelectTrigger>
        <SelectContent
          label={label}
          items={options}
          renderItem={(item) => (
            <SelectItem value={item.value} label={item.label}>
              <SelectItemText>{item.label}</SelectItemText>
              <SelectItemIndicator />
            </SelectItem>
          )}
        />
      </Select>
    </View>
  );
}

function Summary({ plan }: { plan: ReplenishmentPlan }) {
  const { t } = useTranslation();
  const tiles: { key: string; label: string; value: number }[] = [
    {
      key: 'stockedOut',
      label: t('replenishment.status.stockedOut'),
      value: plan.summary.stockedOut,
    },
    {
      key: 'reorderNow',
      label: t('replenishment.status.reorderNow'),
      value: plan.summary.reorderNow,
    },
    { key: 'healthy', label: t('replenishment.status.healthy'), value: plan.summary.healthy },
    {
      key: 'suggested',
      label: t('replenishment.summary.suggestedUnits'),
      value: plan.summary.suggestedUnits,
    },
  ];
  return (
    <View className="flex-row flex-wrap gap-3">
      {tiles.map((tile) => (
        <View
          key={tile.key}
          className="min-w-36 flex-1 gap-1 rounded-2xl border border-border bg-surface p-4"
        >
          <Text className="text-xs text-muted-foreground">{tile.label}</Text>
          <Text className="text-xl font-semibold text-foreground">{tile.value}</Text>
        </View>
      ))}
    </View>
  );
}

function StatusBadge({ status }: { status: ReplenishmentRowStatus }) {
  const { t } = useTranslation();
  return (
    <Badge
      size="label-small"
      variant="subtle"
      color={STATUS_TONES[status]}
      content={t(STATUS_LABEL_KEYS[status])}
    />
  );
}

function useRowFormat() {
  const { t } = useTranslation();
  return {
    stockout: (row: ReplenishmentPlanRow) =>
      row.projectedStockoutDate ?? t('replenishment.values.noForecast'),
    cover: (row: ReplenishmentPlanRow) =>
      row.daysOfCover === null
        ? t('replenishment.values.noForecast')
        : t('replenishment.values.days', { days: row.daysOfCover }),
    sold: (row: ReplenishmentPlanRow) =>
      t('replenishment.values.sold', { recent: row.unitsSoldRecent, long: row.unitsSoldLong }),
    demand: (row: ReplenishmentPlanRow) =>
      t('replenishment.values.perDay', { rate: row.averageDailyDemand }),
    stock: (row: ReplenishmentPlanRow) =>
      t('replenishment.values.stock', { available: row.available, onHand: row.onHand }),
  };
}

function ProductCell({ row }: { row: ReplenishmentPlanRow }) {
  const { t } = useTranslation();
  return (
    <View className="gap-0.5">
      <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
        {row.productTitle}
      </Text>
      <Text className="text-xs text-muted-foreground" numberOfLines={1}>
        {row.sku ? `${row.variantTitle} · ${row.sku}` : row.variantTitle}
        {row.overridden ? ` · ${t('replenishment.values.ownSettings')}` : ''}
      </Text>
    </View>
  );
}

function PlanTable({
  rows,
  onEdit,
}: {
  rows: readonly ReplenishmentPlanRow[];
  onEdit?: (row: ReplenishmentPlanRow) => void;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const format = useRowFormat();

  if (width < 768) {
    return (
      <View className="overflow-hidden rounded-2xl border border-border bg-surface">
        {rows.map((row) => (
          <Pressable
            key={`${row.variantId}:${row.locationId ?? ALL}`}
            disabled={!onEdit}
            onPress={() => onEdit?.(row)}
            className="gap-2 border-b border-border p-4 active:opacity-70"
          >
            <View className="flex-row items-start justify-between gap-3">
              <View className="flex-1">
                <ProductCell row={row} />
              </View>
              <StatusBadge status={row.status} />
            </View>
            <Text className="text-sm text-foreground">
              {t('replenishment.values.suggest', { count: row.suggestedOrderQuantity })}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {t('replenishment.columns.stockout')}: {format.stockout(row)} ·{' '}
              {t('replenishment.columns.cover')}: {format.cover(row)}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {format.stock(row)} · {format.demand(row)} · {format.sold(row)}
            </Text>
          </Pressable>
        ))}
      </View>
    );
  }

  const heading = (label: string) => (
    <Text className="text-xs font-semibold text-muted-foreground">{label}</Text>
  );
  return (
    <Table accessibilityLabel={t('replenishment.title')} size="sm" minWidth={900}>
      <TableHeader>
        <TableColumn flex={2}>{heading(t('replenishment.columns.product'))}</TableColumn>
        <TableColumn width={120}>{heading(t('common.status'))}</TableColumn>
        <TableColumn width={90} align="end">
          {heading(t('replenishment.columns.suggested'))}
        </TableColumn>
        <TableColumn width={110}>{heading(t('replenishment.columns.stockout'))}</TableColumn>
        <TableColumn width={100} align="end">
          {heading(t('replenishment.columns.cover'))}
        </TableColumn>
        <TableColumn width={120} align="end">
          {heading(t('replenishment.columns.stock'))}
        </TableColumn>
        <TableColumn width={90} align="end">
          {heading(t('replenishment.columns.demand'))}
        </TableColumn>
        <TableColumn width={100} align="end">
          {heading(t('replenishment.columns.sold'))}
        </TableColumn>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={`${row.variantId}:${row.locationId ?? ALL}`}
            {...(onEdit ? { onPress: () => onEdit(row) } : {})}
          >
            <TableCell>
              <ProductCell row={row} />
            </TableCell>
            <TableCell>
              <StatusBadge status={row.status} />
            </TableCell>
            <TableCell>
              <Text className="text-sm font-semibold text-foreground">
                {row.suggestedOrderQuantity}
              </Text>
            </TableCell>
            <TableCell>
              <Text className="text-sm text-foreground">{format.stockout(row)}</Text>
            </TableCell>
            <TableCell>
              <Text className="text-sm text-foreground">{format.cover(row)}</Text>
            </TableCell>
            <TableCell>
              <Text className="text-sm text-foreground">{format.stock(row)}</Text>
            </TableCell>
            <TableCell>
              <Text className="text-sm text-foreground">{row.averageDailyDemand}</Text>
            </TableCell>
            <TableCell>
              <Text className="text-sm text-foreground">
                {row.unitsSoldRecent} / {row.unitsSoldLong}
              </Text>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Parse one day field: empty → `null` (inherit / missing), else a bounded whole number. */
function parseDays(raw: string, key: ReplenishmentSettingKey): number | null | 'invalid' {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const value = Number(trimmed);
  const { min, max } = REPLENISHMENT_SETTING_BOUNDS[key];
  return value >= min && value <= max ? value : 'invalid';
}

function toDrafts(values: Partial<Record<ReplenishmentSettingKey, number | null>>) {
  return Object.fromEntries(
    REPLENISHMENT_SETTING_KEYS.map((key) => {
      const value = values[key];
      return [key, value === null || value === undefined ? '' : String(value)];
    }),
  ) as Record<ReplenishmentSettingKey, string>;
}

function DayFields({
  drafts,
  onChange,
  disabled,
  placeholders,
}: {
  drafts: Record<ReplenishmentSettingKey, string>;
  onChange: (key: ReplenishmentSettingKey, value: string) => void;
  disabled?: boolean;
  placeholders?: Record<ReplenishmentSettingKey, string>;
}) {
  const { t } = useTranslation();
  return (
    <View className="flex-row flex-wrap gap-3">
      {REPLENISHMENT_SETTING_KEYS.map((key) => (
        <View key={key} className="min-w-40 flex-1">
          <Field label={t(SETTING_LABEL_KEYS[key])}>
            <TextFieldInput
              label={t(SETTING_LABEL_KEYS[key])}
              value={drafts[key]}
              onValueChange={(value) => onChange(key, value)}
              keyboardType="number-pad"
              editable={!disabled}
              {...(placeholders ? { placeholder: placeholders[key] } : {})}
            />
          </Field>
        </View>
      ))}
    </View>
  );
}

function SettingsSection({ storeId, canEdit }: { storeId: string; canEdit: boolean }) {
  const { t } = useTranslation();
  const settings = useReplenishmentSettings(storeId);
  const save = useSaveReplenishmentSettings(storeId);
  const remove = useDeleteReplenishmentOverride(storeId);
  const [drafts, setDrafts] = useState(() => toDrafts({}));

  const loaded = settings.data?.settings;
  useEffect(() => {
    if (loaded) setDrafts(toDrafts(loaded));
  }, [loaded]);

  if (settings.isPending) return <ScreenLoading />;
  if (settings.isError || !settings.data) {
    return (
      <ScreenMessage
        title={t('replenishment.settings.loadFailed')}
        body={t('common.pleaseTryAgain')}
      />
    );
  }
  const view = settings.data;

  const submit = () => {
    const values: Partial<ReplenishmentSettingValues> = {};
    for (const key of REPLENISHMENT_SETTING_KEYS) {
      const parsed = parseDays(drafts[key], key);
      if (parsed === null || parsed === 'invalid') {
        const { min, max } = REPLENISHMENT_SETTING_BOUNDS[key];
        toast.error(t('replenishment.settings.invalid', { min, max }));
        return;
      }
      (values as Record<ReplenishmentSettingKey, number>)[key] = parsed;
    }
    save.mutate(values as ReplenishmentSettingValues, {
      onSuccess: () => toast.success(t('replenishment.settings.saved')),
      onError: (error) =>
        toast.error(
          planRefusalOf(error)
            ? t('replenishment.planRefused')
            : t('replenishment.settings.saveFailed'),
        ),
    });
  };

  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <View className="gap-1">
        <Text className="text-base font-semibold text-foreground">
          {t('replenishment.settings.title')}
        </Text>
        <Text className="text-sm text-muted-foreground">{t('replenishment.settings.body')}</Text>
        {!view.settings.saved ? (
          <Text className="text-xs text-muted-foreground">
            {t('replenishment.settings.defaultsNote')}
          </Text>
        ) : null}
      </View>
      <DayFields
        drafts={drafts}
        disabled={!canEdit}
        onChange={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))}
      />
      {canEdit ? (
        <View className="flex-row">
          <Button tone="accent" onPress={submit} loading={save.isPending}>
            {t('replenishment.settings.save')}
          </Button>
        </View>
      ) : (
        <Text className="text-xs text-muted-foreground">
          {t('replenishment.settings.readOnly')}
        </Text>
      )}

      <View className="gap-2">
        <Text className="text-sm font-semibold text-foreground">
          {t('replenishment.overrides.title')}
        </Text>
        {view.overrides.length === 0 ? (
          <Text className="text-sm text-muted-foreground">
            {canEdit
              ? t('replenishment.overrides.emptyEditable')
              : t('replenishment.overrides.empty')}
          </Text>
        ) : (
          view.overrides.map((override) => (
            <OverrideRow
              key={override.variantId}
              override={override}
              {...(canEdit
                ? {
                    onRemove: () =>
                      remove.mutate(override.variantId, {
                        onSuccess: () => toast.success(t('replenishment.overrides.removed')),
                        onError: () => toast.error(t('replenishment.overrides.removeFailed')),
                      }),
                  }
                : {})}
            />
          ))
        )}
      </View>
    </View>
  );
}

function OverrideRow({
  override,
  onRemove,
}: {
  override: ReplenishmentVariantOverride;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const values = REPLENISHMENT_SETTING_KEYS.map((key) =>
    t('replenishment.overrides.value', {
      label: t(SETTING_LABEL_KEYS[key]),
      value: override[key] === null ? t('replenishment.overrides.inherit') : String(override[key]),
    }),
  ).join(' · ');
  return (
    <View className="flex-row items-center gap-3 rounded-xl border border-border p-3">
      <View className="flex-1 gap-0.5">
        <Text className="text-sm font-medium text-foreground">
          {override.productTitle} · {override.variantTitle}
        </Text>
        <Text className="text-xs text-muted-foreground">{values}</Text>
      </View>
      {onRemove ? (
        <Button tone="neutral" onPress={onRemove}>
          {t('replenishment.overrides.remove')}
        </Button>
      ) : null}
    </View>
  );
}

function OverrideDialog({
  storeId,
  control,
  row,
}: {
  storeId: string;
  control: DialogControlProps;
  row: ReplenishmentPlanRow | null;
}) {
  const { t } = useTranslation();
  const settings = useReplenishmentSettings(storeId);
  const save = useSaveReplenishmentOverride(storeId);
  const existing = settings.data?.overrides.find((entry) => entry.variantId === row?.variantId);
  const [drafts, setDrafts] = useState(() => toDrafts({}));

  useEffect(() => {
    setDrafts(toDrafts(existing ?? {}));
  }, [existing]);

  const store = settings.data?.settings;
  const placeholders = store
    ? (Object.fromEntries(
        REPLENISHMENT_SETTING_KEYS.map((key) => [
          key,
          t('replenishment.overrides.placeholder', { value: store[key] }),
        ]),
      ) as Record<ReplenishmentSettingKey, string>)
    : undefined;

  const submit = () => {
    if (!row) return;
    const values: Record<ReplenishmentSettingKey, number | null> = {
      leadTimeDays: null,
      targetCoverDays: null,
      safetyStockDays: null,
    };
    for (const key of REPLENISHMENT_SETTING_KEYS) {
      const parsed = parseDays(drafts[key], key);
      if (parsed === 'invalid') {
        const { min, max } = REPLENISHMENT_SETTING_BOUNDS[key];
        toast.error(t('replenishment.settings.invalid', { min, max }));
        return;
      }
      values[key] = parsed;
    }
    save.mutate(
      { variantId: row.variantId, values },
      {
        onSuccess: () => {
          toast.success(t('replenishment.overrides.saved'));
          control.close();
        },
        onError: (error) =>
          toast.error(
            planRefusalOf(error)
              ? t('replenishment.planRefused')
              : t('replenishment.overrides.saveFailed'),
          ),
      },
    );
  };

  return (
    <Dialog control={control} title={t('replenishment.overrides.dialogTitle')}>
      <View className="gap-4">
        {row ? (
          <Text className="text-sm font-medium text-foreground">
            {row.productTitle} · {row.variantTitle}
          </Text>
        ) : null}
        <Text className="text-xs text-muted-foreground">{t('replenishment.overrides.hint')}</Text>
        <DayFields
          drafts={drafts}
          onChange={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))}
          {...(placeholders ? { placeholders } : {})}
        />
        <View className="flex-row">
          <Button tone="accent" onPress={submit} loading={save.isPending}>
            {t('replenishment.overrides.save')}
          </Button>
        </View>
      </View>
    </Dialog>
  );
}

function HowItWorks() {
  const { t } = useTranslation();
  const lines = [
    'replenishment.how.sales',
    'replenishment.how.demand',
    'replenishment.how.cover',
    'replenishment.how.suggest',
    'replenishment.how.incoming',
    'replenishment.how.noOrders',
  ];
  return (
    <View className="gap-2 rounded-2xl border border-border p-4">
      <Text className="text-sm font-semibold text-foreground">{t('replenishment.how.title')}</Text>
      {lines.map((key) => (
        <Text key={key} className="text-xs text-muted-foreground">
          {t(key)}
        </Text>
      ))}
    </View>
  );
}
