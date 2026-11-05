import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ArrowDown, ArrowUp, Pin, PinOff } from 'lucide-react-native';
import {
  MAX_MERCHANDISING_PINS,
  MAX_MERCHANDISING_SPOTLIGHT_ITEMS,
  MERCHANDISING_BEST_SELLING_WINDOW_PRESETS,
  MERCHANDISING_SORT_STRATEGIES,
  MIN_MERCHANDISING_SPOTLIGHT_ITEMS,
  type CreateMerchandisingRuleInput,
  type MerchandisingPreviewInput,
  type MerchandisingRule,
  type MerchandisingRuleKind,
  type MerchandisingRuleTarget,
  type MerchandisingSortStrategy,
  type UpdateMerchandisingRuleInput,
} from '@mercaria/shared-types';
import { Text, useColorScheme } from '@mercaria/ui';
import { Button } from '@oxy.so/bloom/button';
import { DatePicker, TimeField } from '@oxy.so/bloom/date-picker';
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
import { useCollections } from '@/lib/hooks/use-collections';
import { useMerchandisingPreview } from '@/lib/hooks/use-merchandising';
import { OxyProductImage } from '@/components/products/OxyProductImage';
import { useTranslation } from '@/lib/i18n';
import { planRefusalOf } from '@/lib/plan-refusal';

/** KEYS rather than labels: evaluated at import, before the locale rehydrates. */
export const STRATEGY_KEYS: Record<MerchandisingSortStrategy, string> = {
  best_selling: 'merchandising.strategy.bestSelling',
  newest: 'merchandising.strategy.newest',
  price_asc: 'merchandising.strategy.priceAsc',
  price_desc: 'merchandising.strategy.priceDesc',
};

/** What the editor holds; every field is a plain value the form can show. */
interface Draft {
  kind: MerchandisingRuleKind;
  title: string;
  target: MerchandisingRuleTarget;
  collectionId: string | null;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  sortStrategy: MerchandisingSortStrategy;
  bestSellingWindowDays: number;
  inStockFirst: boolean;
  pinnedListingIds: string[];
  spotlightItemLimit: number;
}

function draftOf(rule: MerchandisingRule | undefined): Draft {
  return {
    kind: rule?.kind ?? 'sort',
    title: rule?.title ?? '',
    target: rule?.target ?? 'store',
    collectionId: rule?.collectionId ?? null,
    enabled: rule?.enabled ?? true,
    startsAt: rule?.startsAt ?? null,
    endsAt: rule?.endsAt ?? null,
    sortStrategy: rule?.sortStrategy ?? 'best_selling',
    bestSellingWindowDays: rule?.bestSellingWindowDays ?? 30,
    inStockFirst: rule?.inStockFirst ?? false,
    pinnedListingIds: rule?.pinnedListingIds ?? [],
    spotlightItemLimit: rule?.spotlightItemLimit ?? 8,
  };
}

/** The create body a draft becomes. */
export function toCreateInput(draft: Draft): CreateMerchandisingRuleInput {
  const common = {
    kind: draft.kind,
    title: draft.title.trim(),
    target: draft.kind === 'spotlight' ? ('collection' as const) : draft.target,
    enabled: draft.enabled,
    startsAt: draft.startsAt,
    endsAt: draft.endsAt,
    ...(draft.kind === 'spotlight' || draft.target === 'collection'
      ? { collectionId: draft.collectionId ?? undefined }
      : {}),
  };
  if (draft.kind === 'spotlight') {
    return { ...common, spotlightItemLimit: draft.spotlightItemLimit };
  }
  return {
    ...common,
    sortStrategy: draft.sortStrategy,
    ...(draft.sortStrategy === 'best_selling'
      ? { bestSellingWindowDays: draft.bestSellingWindowDays }
      : {}),
    inStockFirst: draft.inStockFirst,
    pinnedListingIds: draft.pinnedListingIds,
  };
}

/** The patch a draft becomes: kind, target and collection are fixed once a rule exists. */
function toUpdateInput(draft: Draft): UpdateMerchandisingRuleInput {
  const common = {
    title: draft.title.trim(),
    enabled: draft.enabled,
    startsAt: draft.startsAt,
    endsAt: draft.endsAt,
  };
  if (draft.kind === 'spotlight')
    return { ...common, spotlightItemLimit: draft.spotlightItemLimit };
  return {
    ...common,
    sortStrategy: draft.sortStrategy,
    bestSellingWindowDays:
      draft.sortStrategy === 'best_selling' ? draft.bestSellingWindowDays : null,
    inStockFirst: draft.inStockFirst,
    pinnedListingIds: draft.pinnedListingIds,
  };
}

/** "HH:mm" in local time for an ISO instant. */
function localTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** A local day plus a local "HH:mm", as an ISO instant. */
function combine(day: Date, time: string | null): string {
  const [hours, minutes] = (time ?? '00:00').split(':').map(Number);
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours || 0, minutes || 0);
  return at.toISOString();
}

/** One end of a schedule: a day and a time, or nothing ("open"). */
function ScheduleField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const day = value ? new Date(value) : null;
  return (
    <Field label={label}>
      <View className="flex-row flex-wrap items-center gap-2">
        <DatePicker
          value={day}
          disabled={disabled}
          accessibilityLabel={label}
          placeholder={t('merchandising.editor.scheduleOpen')}
          onChange={(next) => onChange(next ? combine(next, localTime(value)) : null)}
        />
        {day ? (
          <TimeField
            value={localTime(value)}
            disabled={disabled}
            step={15}
            accessibilityLabel={t('merchandising.editor.time', { field: label })}
            onChange={(time) => onChange(combine(day, time))}
          />
        ) : null}
        {day ? (
          <Button
            size="sm"
            appearance="outline"
            material="flat"
            disabled={disabled}
            onPress={() => onChange(null)}
          >
            {t('merchandising.editor.clear')}
          </Button>
        ) : null}
      </View>
    </Field>
  );
}

/**
 * Create or edit one merchandising rule, with a live preview of the order a
 * sort rule produces — pin from the preview, reorder the pins, save.
 */
export function RuleEditor({
  storeId,
  rule,
  canWrite,
  saving,
  saveError,
  onSave,
}: {
  storeId: string;
  rule?: MerchandisingRule;
  canWrite: boolean;
  saving: boolean;
  saveError: unknown;
  onSave: (input: CreateMerchandisingRuleInput | UpdateMerchandisingRuleInput) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const [draft, setDraft] = useState<Draft>(() => draftOf(rule));
  const collections = useCollections(storeId);
  const creating = rule === undefined;
  const disabled = !canWrite || saving;
  const edit = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const needsCollection = draft.kind === 'spotlight' || draft.target === 'collection';
  const windowValid =
    !draft.startsAt ||
    !draft.endsAt ||
    new Date(draft.endsAt).getTime() > new Date(draft.startsAt).getTime();
  const valid =
    draft.title.trim().length > 0 &&
    windowValid &&
    (!needsCollection || draft.collectionId !== null);

  const previewInput = useMemo<MerchandisingPreviewInput | null>(() => {
    if (draft.kind !== 'sort') return null;
    if (draft.target === 'collection' && !draft.collectionId) return null;
    return {
      target: draft.target,
      ...(draft.target === 'collection' && draft.collectionId
        ? { collectionId: draft.collectionId }
        : {}),
      sortStrategy: draft.sortStrategy,
      ...(draft.sortStrategy === 'best_selling'
        ? { bestSellingWindowDays: draft.bestSellingWindowDays }
        : {}),
      inStockFirst: draft.inStockFirst,
      pinnedListingIds: draft.pinnedListingIds,
      limit: 24,
    };
  }, [draft]);
  const preview = useMerchandisingPreview(storeId, canWrite ? previewInput : null);

  const collectionOptions = (collections.data ?? []).map((collection) => ({
    value: collection.id,
    label: collection.isPublished
      ? collection.title
      : t('merchandising.editor.unpublishedCollection', { title: collection.title }),
  }));
  const strategyOptions = MERCHANDISING_SORT_STRATEGIES.map((value) => ({
    value,
    label: t(STRATEGY_KEYS[value]),
  }));

  const togglePin = (listingId: string) => {
    const pinned = draft.pinnedListingIds;
    if (pinned.includes(listingId)) {
      edit({ pinnedListingIds: pinned.filter((id) => id !== listingId) });
    } else if (pinned.length < MAX_MERCHANDISING_PINS) {
      edit({ pinnedListingIds: [...pinned, listingId] });
    }
  };
  const movePin = (listingId: string, by: -1 | 1) => {
    const pinned = [...draft.pinnedListingIds];
    const from = pinned.indexOf(listingId);
    const to = from + by;
    if (from < 0 || to < 0 || to >= pinned.length) return;
    [pinned[from], pinned[to]] = [pinned[to], pinned[from]];
    edit({ pinnedListingIds: pinned });
  };

  const refusal = planRefusalOf(saveError);

  return (
    <View className="gap-5 pb-8">
      <View className="gap-4 rounded-xl border border-border bg-surface p-4">
        {creating ? (
          <Field label={t('merchandising.editor.kind')}>
            <SegmentedControl
              type="radio"
              value={draft.kind}
              onValueChange={(kind: MerchandisingRuleKind) => edit({ kind })}
            >
              <SegmentedControlItem value="sort">
                <SegmentedControlItemText>{t('merchandising.kind.sort')}</SegmentedControlItemText>
              </SegmentedControlItem>
              <SegmentedControlItem value="spotlight">
                <SegmentedControlItemText>
                  {t('merchandising.kind.spotlight')}
                </SegmentedControlItemText>
              </SegmentedControlItem>
            </SegmentedControl>
          </Field>
        ) : null}
        <Text className="text-sm text-muted-foreground">
          {t(
            draft.kind === 'sort'
              ? 'merchandising.kind.sortDescription'
              : 'merchandising.kind.spotlightDescription',
          )}
        </Text>

        <Field label={t('common.title')}>
          <TextFieldInput
            label={t('common.title')}
            value={draft.title}
            onValueChange={(title) => edit({ title })}
            maxLength={120}
            placeholder={t('merchandising.editor.titlePlaceholder')}
            disabled={disabled}
          />
        </Field>

        {creating && draft.kind === 'sort' ? (
          <Field label={t('merchandising.editor.target')}>
            <SegmentedControl
              type="radio"
              value={draft.target}
              onValueChange={(target: MerchandisingRuleTarget) =>
                edit({ target, pinnedListingIds: [] })
              }
            >
              <SegmentedControlItem value="store">
                <SegmentedControlItemText>
                  {t('merchandising.target.store')}
                </SegmentedControlItemText>
              </SegmentedControlItem>
              <SegmentedControlItem value="collection">
                <SegmentedControlItemText>
                  {t('merchandising.target.collection')}
                </SegmentedControlItemText>
              </SegmentedControlItem>
            </SegmentedControl>
          </Field>
        ) : null}

        {creating && needsCollection ? (
          <Field label={t('merchandising.editor.collection')}>
            <Select
              value={draft.collectionId ?? undefined}
              disabled={disabled}
              onValueChange={(collectionId) => edit({ collectionId, pinnedListingIds: [] })}
            >
              <SelectTrigger label={t('merchandising.editor.collection')}>
                <SelectValue placeholder={t('merchandising.editor.chooseCollection')} />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('merchandising.editor.collection')}
                items={collectionOptions}
                renderItem={(item) => (
                  <SelectItem value={item.value} label={item.label}>
                    <SelectItemText>{item.label}</SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                )}
              />
            </Select>
          </Field>
        ) : null}

        {draft.kind === 'sort' ? (
          <>
            <Field label={t('merchandising.editor.strategy')}>
              <Select
                value={draft.sortStrategy}
                disabled={disabled}
                onValueChange={(value) => {
                  const option = strategyOptions.find((item) => item.value === value);
                  if (option) edit({ sortStrategy: option.value });
                }}
              >
                <SelectTrigger label={t('merchandising.editor.strategy')}>
                  <SelectValue />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent
                  label={t('merchandising.editor.strategy')}
                  items={strategyOptions}
                  renderItem={(item) => (
                    <SelectItem value={item.value} label={item.label}>
                      <SelectItemText>{item.label}</SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  )}
                />
              </Select>
            </Field>
            {draft.sortStrategy === 'best_selling' ? (
              <Field label={t('merchandising.editor.window')}>
                <SegmentedControl
                  type="radio"
                  value={String(draft.bestSellingWindowDays)}
                  onValueChange={(value: string) => edit({ bestSellingWindowDays: Number(value) })}
                >
                  {MERCHANDISING_BEST_SELLING_WINDOW_PRESETS.map((days) => (
                    <SegmentedControlItem key={days} value={String(days)}>
                      <SegmentedControlItemText>
                        {t('merchandising.editor.windowDays', { days })}
                      </SegmentedControlItemText>
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
              </Field>
            ) : null}
            <View className="flex-row items-center justify-between gap-3">
              <Text className="flex-1 text-sm text-foreground">
                {t('merchandising.editor.inStockFirst')}
              </Text>
              <Switch
                checked={draft.inStockFirst}
                disabled={disabled}
                onCheckedChange={(inStockFirst) => edit({ inStockFirst })}
                accessibilityLabel={t('merchandising.editor.inStockFirst')}
              />
            </View>
          </>
        ) : (
          <Field label={t('merchandising.editor.spotlightItems')}>
            <TextFieldInput
              label={t('merchandising.editor.spotlightItems')}
              value={String(draft.spotlightItemLimit)}
              keyboardType="number-pad"
              disabled={disabled}
              onValueChange={(value) => {
                const parsed = Number.parseInt(value, 10);
                if (!Number.isFinite(parsed)) return;
                edit({
                  spotlightItemLimit: Math.min(
                    MAX_MERCHANDISING_SPOTLIGHT_ITEMS,
                    Math.max(MIN_MERCHANDISING_SPOTLIGHT_ITEMS, parsed),
                  ),
                });
              }}
            />
          </Field>
        )}

        <Text className="text-base font-semibold text-foreground">
          {t('merchandising.editor.schedule')}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {t('merchandising.editor.scheduleHint')}
        </Text>
        <ScheduleField
          label={t('merchandising.editor.startsAt')}
          value={draft.startsAt}
          disabled={disabled}
          onChange={(startsAt) => edit({ startsAt })}
        />
        <ScheduleField
          label={t('merchandising.editor.endsAt')}
          value={draft.endsAt}
          disabled={disabled}
          onChange={(endsAt) => edit({ endsAt })}
        />
        {!windowValid ? (
          <Text className="text-sm text-destructive">
            {t('merchandising.editor.windowInvalid')}
          </Text>
        ) : null}
        <View className="flex-row items-center justify-between gap-3">
          <Text className="flex-1 text-sm text-foreground">
            {t('merchandising.editor.enabled')}
          </Text>
          <Switch
            checked={draft.enabled}
            disabled={disabled}
            onCheckedChange={(enabled) => edit({ enabled })}
            accessibilityLabel={t('merchandising.editor.enabled')}
          />
        </View>

        <View className="min-h-5" accessibilityLiveRegion="polite">
          {refusal === 'limit' ? (
            <Text className="text-sm text-muted-foreground">
              {t('merchandising.editor.limitReached')}
            </Text>
          ) : refusal === 'capability' ? (
            <Text className="text-sm text-muted-foreground">
              {t('merchandising.editor.notIncluded')}
            </Text>
          ) : saveError ? (
            <Text className="text-sm text-destructive">{t('merchandising.editor.saveFailed')}</Text>
          ) : null}
        </View>
        {canWrite ? (
          <View className="flex-row">
            <Button
              tone="accent"
              loading={saving}
              disabled={disabled || !valid}
              onPress={() => onSave(creating ? toCreateInput(draft) : toUpdateInput(draft))}
            >
              {creating ? t('common.create') : t('merchandising.editor.save')}
            </Button>
          </View>
        ) : null}
      </View>

      {draft.kind === 'sort' && canWrite ? (
        <View className="gap-3 rounded-xl border border-border bg-surface p-4">
          <Text className="text-base font-semibold text-foreground">
            {t('merchandising.preview.title')}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t('merchandising.preview.hint', { max: MAX_MERCHANDISING_PINS })}
          </Text>
          {previewInput === null ? (
            <Text className="text-sm text-muted-foreground">
              {t('merchandising.editor.chooseCollection')}
            </Text>
          ) : preview.isError ? (
            <Text className="text-sm text-destructive">{t('merchandising.preview.failed')}</Text>
          ) : preview.data && preview.data.items.length === 0 ? (
            <Text className="text-sm text-muted-foreground">
              {t('merchandising.preview.empty')}
            </Text>
          ) : (
            (preview.data?.items ?? []).map((item, index) => {
              const pinIndex = draft.pinnedListingIds.indexOf(item.listingId);
              return (
                <View
                  key={item.listingId}
                  className="flex-row items-center gap-3 rounded-lg border border-border p-2"
                >
                  <Text className="w-6 text-xs text-muted-foreground">{index + 1}</Text>
                  {item.imageFileId ? (
                    <OxyProductImage
                      fileId={item.imageFileId}
                      alt={item.title}
                      size={40}
                      thumbnailOnly
                    />
                  ) : (
                    <View className="h-10 w-10 rounded-md bg-muted" />
                  )}
                  <View className="flex-1">
                    <Text className="text-sm text-foreground" numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text className="text-xs text-muted-foreground">
                      {[
                        item.pinned ? t('merchandising.preview.pinned') : null,
                        item.inStock
                          ? t('merchandising.preview.inStock')
                          : t('merchandising.preview.outOfStock'),
                        item.unitsSold === null
                          ? null
                          : t('merchandising.preview.unitsSold', { units: item.unitsSold }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  {pinIndex >= 0 ? (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('merchandising.preview.moveUp')}
                        disabled={disabled || pinIndex === 0}
                        onPress={() => movePin(item.listingId, -1)}
                        className="p-2 active:opacity-70"
                      >
                        <ArrowUp size={16} color={colors.mutedForeground} />
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('merchandising.preview.moveDown')}
                        disabled={disabled || pinIndex === draft.pinnedListingIds.length - 1}
                        onPress={() => movePin(item.listingId, 1)}
                        className="p-2 active:opacity-70"
                      >
                        <ArrowDown size={16} color={colors.mutedForeground} />
                      </Pressable>
                    </>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t(
                      pinIndex >= 0 ? 'merchandising.preview.unpin' : 'merchandising.preview.pin',
                    )}
                    disabled={disabled}
                    onPress={() => togglePin(item.listingId)}
                    className="p-2 active:opacity-70"
                  >
                    {pinIndex >= 0 ? (
                      <PinOff size={16} color={colors.foreground} />
                    ) : (
                      <Pin size={16} color={colors.mutedForeground} />
                    )}
                  </Pressable>
                </View>
              );
            })
          )}
          {preview.data ? (
            <Text className="text-xs text-muted-foreground">
              {t('merchandising.preview.total', { total: preview.data.total })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
