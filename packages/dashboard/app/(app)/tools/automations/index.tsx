import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Head from 'expo-router/head';
import { useRouter } from 'expo-router';
import { Pencil, Plus, Trash2 } from 'lucide-react-native';
import type {
  AutomationRule,
  AutomationRuleAction,
  AutomationRuleRun,
  AutomationRuleTrigger,
  CreateAutomationRuleInput,
  CurrencyCode,
  StoreCapabilityView,
  UpdateAutomationRuleInput,
} from '@mercaria/shared-types';
import { AUTOMATION_RULE_ACTIONS_BY_TRIGGER } from '@mercaria/shared-types';
import {
  Text,
  formatDateTime,
  formatMoney,
  toBloomIcon,
  useColorScheme,
  type Translate,
} from '@mercaria/ui';
import { Button } from '@oxy.so/bloom/button';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Switch } from '@oxy.so/bloom/switch';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { Dialog, useDialogControl, type DialogControlProps } from '@oxy.so/bloom/dialog';
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
import { useStoreCapability } from '@/lib/hooks/use-plan';
import {
  useAutomationRules,
  useAutomationRuns,
  useCreateAutomationRule,
  useDeleteAutomationRule,
  useUpdateAutomationRule,
} from '@/lib/hooks/use-automations';
import { planRefusalOf } from '@/lib/plan-refusal';
import { toMajorString, toMinorUnits } from '@/lib/money';

/**
 * Automations — the `automation_rules` paid tool (#89).
 *
 * A rule is one trigger and one action. The server checks rules about once a
 * minute and records what each did; this screen writes rules and shows that
 * record. Everything a rule does goes through the same services a member's own
 * edit does, so a listing under review and an order held for review are never
 * touched — the copy says so where the action is chosen.
 *
 * KEYS rather than sentences at module scope (#398).
 */
const TRIGGER_LABEL_KEYS: Record<AutomationRuleTrigger, string> = {
  listing_stock_at_or_below: 'automations.form.triggerStock',
  order_paid: 'automations.form.triggerOrder',
};

const ACTION_LABEL_KEYS: Record<AutomationRuleAction, string> = {
  notify_owner: 'automations.form.actionNotify',
  pause_listing: 'automations.form.actionPause',
  mark_order_processing: 'automations.form.actionProcess',
};

const ACTION_SUMMARY_KEYS: Record<AutomationRuleAction, string> = {
  notify_owner: 'automations.action.notifyOwner',
  pause_listing: 'automations.action.pauseListing',
  mark_order_processing: 'automations.action.markOrderProcessing',
};

const STEP_KEYS: Record<AutomationRuleRun['step'], string> = {
  notify_owner: 'automations.step.notifyOwner',
  pause_listing: 'automations.step.pauseListing',
  republish_listing: 'automations.step.republishListing',
  mark_order_processing: 'automations.step.markOrderProcessing',
};

const OUTCOME_KEYS: Record<AutomationRuleRun['outcome'], string> = {
  succeeded: 'automations.outcome.succeeded',
  skipped: 'automations.outcome.skipped',
  failed: 'automations.outcome.failed',
};

export default function AutomationsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('automations.documentTitle')}</title>
      </Head>
      <RequireStore permission="products:read">
        {(storeId) => <AutomationsBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function AutomationsBody({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const { can } = useActiveStoreContext();
  const editor = useDialogControl();
  const [editing, setEditing] = useState<AutomationRule | null>(null);
  const capability = useStoreCapability(storeId, 'automation_rules');
  const entitled = capability.capability?.entitled === true;
  const canWrite = can('products:write');

  const action =
    entitled && canWrite ? (
      <Button
        tone="accent"
        leadingIcon={toBloomIcon(Plus)}
        onPress={() => {
          setEditing(null);
          editor.open();
        }}
      >
        {t('automations.new')}
      </Button>
    ) : null;

  return (
    <Screen title={t('automations.title')} subtitle={t('automations.subtitle')} action={action}>
      <PlanToolGate storeId={storeId} capability="automation_rules">
        {(view) => (
          <View className="gap-6">
            <RulesSection
              storeId={storeId}
              view={view}
              canWrite={canWrite}
              onEdit={(rule) => {
                setEditing(rule);
                editor.open();
              }}
            />
            <HistorySection storeId={storeId} />
          </View>
        )}
      </PlanToolGate>
      {/* A store whose plan ended keeps its rules: it can read, turn off and delete them. */}
      {!capability.isPending && !entitled ? (
        <LapsedRules storeId={storeId} canWrite={canWrite} />
      ) : null}
      <RuleDialog storeId={storeId} control={editor} rule={editing} />
    </Screen>
  );
}

function RulesSection({
  storeId,
  view,
  canWrite,
  onEdit,
}: {
  storeId: string;
  view: StoreCapabilityView;
  canWrite: boolean;
  onEdit: (rule: AutomationRule) => void;
}) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useAutomationRules(storeId);

  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between gap-2">
        <PlanUsage view={view} />
        <Text className="text-xs text-muted-foreground">{t('automations.timing')}</Text>
      </View>
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title={t('automations.loadError')} body={t('common.pleaseTryAgain')} />
      ) : (data?.length ?? 0) === 0 ? (
        <ScreenMessage title={t('automations.empty.title')} body={t('automations.empty.body')} />
      ) : (
        <View className="gap-2">
          {data?.map((rule) => (
            <RuleRow
              key={rule.id}
              storeId={storeId}
              rule={rule}
              canWrite={canWrite}
              onEdit={() => onEdit(rule)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** Rules a store keeps after its plan ended — readable, and only turned off or deleted. */
function LapsedRules({ storeId, canWrite }: { storeId: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const { data } = useAutomationRules(storeId);
  if (!data || data.length === 0) return null;
  return (
    <View className="mt-6 gap-2">
      <Text className="text-sm font-semibold text-foreground">{t('automations.lapsed.title')}</Text>
      <Text className="text-xs text-muted-foreground">{t('automations.lapsed.body')}</Text>
      {data.map((rule) => (
        <RuleRow key={rule.id} storeId={storeId} rule={rule} canWrite={canWrite} lapsed />
      ))}
    </View>
  );
}

/** One sentence for a rule: its trigger and its action. */
function describeRule(rule: AutomationRule, t: Translate, locale: string): string {
  const trigger =
    rule.trigger === 'listing_stock_at_or_below'
      ? t('automations.trigger.stock', { threshold: rule.stockThreshold ?? 0 })
      : rule.minOrderTotal
        ? t('automations.trigger.orderPaidMin', { amount: formatMoney(rule.minOrderTotal, locale) })
        : t('automations.trigger.orderPaid');
  return t('automations.ruleSummary', { trigger, action: t(ACTION_SUMMARY_KEYS[rule.action]) });
}

function RuleRow({
  storeId,
  rule,
  canWrite,
  onEdit,
  lapsed = false,
}: {
  storeId: string;
  rule: AutomationRule;
  canWrite: boolean;
  onEdit?: () => void;
  lapsed?: boolean;
}) {
  const { t, locale } = useTranslation();
  const { colors } = useColorScheme();
  const { can } = useActiveStoreContext();
  const update = useUpdateAutomationRule(storeId);
  const remove = useDeleteAutomationRule(storeId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // An order-moving rule is managed only by someone who could move the order by hand.
  const mayManage = canWrite && (rule.action !== 'mark_order_processing' || can('orders:fulfill'));
  // A lapsed rule can be switched OFF but not back on until the plan returns.
  const mayToggle = mayManage && (!lapsed || rule.enabled);

  const toggle = (enabled: boolean) =>
    update.mutate(
      { id: rule.id, input: { enabled } },
      {
        onError: (error) =>
          toast.error(
            planRefusalOf(error) ? t('automations.notIncluded') : t('automations.updateError'),
          ),
      },
    );

  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3">
      <View className="flex-1 gap-1">
        <Text className="text-sm font-semibold text-foreground">{rule.name}</Text>
        <Text className="text-xs text-muted-foreground">{describeRule(rule, t, locale)}</Text>
        {rule.tag ? (
          <Text className="text-xs text-muted-foreground">
            {t('automations.tagScope', { tag: rule.tag })}
          </Text>
        ) : null}
        {rule.republishWhenRestocked ? (
          <Text className="text-xs text-muted-foreground">{t('automations.republishNote')}</Text>
        ) : null}
      </View>
      {mayToggle ? (
        <Switch
          checked={rule.enabled}
          onCheckedChange={toggle}
          accessibilityLabel={t('automations.enabledLabel')}
        />
      ) : null}
      {mayManage && onEdit && !lapsed ? (
        <Pressable
          onPress={onEdit}
          accessibilityLabel={t('automations.edit')}
          className="p-2 active:opacity-70"
        >
          <Pencil size={16} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
      {mayManage ? (
        <Pressable
          onPress={() => setConfirmOpen(true)}
          accessibilityLabel={t('automations.delete')}
          className="p-2 active:opacity-70"
        >
          <Trash2 size={16} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
      <AlertDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('automations.deleteConfirmTitle')}
        description={t('automations.deleteConfirmBody')}
        confirmLabel={t('automations.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={() =>
          remove.mutate(rule.id, {
            onSuccess: () => toast.success(t('automations.deleted')),
            onError: () => toast.error(t('automations.deleteError')),
          })
        }
      />
    </View>
  );
}

function HistorySection({ storeId }: { storeId: string }) {
  const { t, locale } = useTranslation();
  const router = useRouter();
  const runs = useAutomationRuns(storeId);
  const rules = useAutomationRules(storeId);
  const names = new Map((rules.data ?? []).map((rule) => [rule.id, rule.name]));

  return (
    <View className="gap-2">
      <Text className="text-sm font-semibold text-foreground">
        {t('automations.history.title')}
      </Text>
      {runs.isPending ? (
        <ScreenLoading />
      ) : runs.isError ? (
        <Text className="text-xs text-muted-foreground">{t('automations.history.loadError')}</Text>
      ) : (runs.data?.length ?? 0) === 0 ? (
        <Text className="text-xs text-muted-foreground">{t('automations.history.empty')}</Text>
      ) : (
        runs.data?.map((run) => (
          <Pressable
            key={run.id}
            onPress={() =>
              run.subjectKind === 'listing'
                ? router.push({ pathname: '/products/[id]', params: { id: run.subjectId } })
                : router.push({ pathname: '/orders/[id]', params: { id: run.subjectId } })
            }
            className="gap-1 rounded-xl border border-border bg-surface p-3 active:opacity-70"
          >
            <View className="flex-row items-center justify-between gap-2">
              <Text className="flex-1 text-sm text-foreground">
                {t('automations.history.row', {
                  rule: names.get(run.ruleId) ?? t('automations.deletedRule'),
                  step: t(STEP_KEYS[run.step]),
                })}
              </Text>
              <Text
                className={
                  run.outcome === 'succeeded'
                    ? 'text-xs font-semibold text-foreground'
                    : 'text-xs font-semibold text-muted-foreground'
                }
              >
                {t(OUTCOME_KEYS[run.outcome])}
              </Text>
            </View>
            <Text className="text-xs text-muted-foreground">
              {formatDateTime(run.createdAt, locale) ?? ''}
            </Text>
            {run.detail ? (
              <Text className="text-xs text-muted-foreground">{run.detail}</Text>
            ) : null}
          </Pressable>
        ))
      )}
    </View>
  );
}

/** The create/edit form. The trigger and the action are fixed once a rule exists. */
function RuleDialog({
  storeId,
  control,
  rule,
}: {
  storeId: string;
  control: DialogControlProps;
  rule: AutomationRule | null;
}) {
  const { t } = useTranslation();
  // Keyed on the rule so opening another rule (or a new one) starts from its values.
  return (
    <Dialog
      control={control}
      title={rule ? t('automations.form.editTitle') : t('automations.form.createTitle')}
    >
      <RuleForm key={rule?.id ?? 'new'} storeId={storeId} rule={rule} onDone={control.close} />
    </Dialog>
  );
}

function RuleForm({
  storeId,
  rule,
  onDone,
}: {
  storeId: string;
  rule: AutomationRule | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { store, can } = useActiveStoreContext();
  const currency = (rule?.minOrderTotal?.currency ??
    store?.defaultCurrency ??
    'FAIR') as CurrencyCode;
  const create = useCreateAutomationRule(storeId);
  const update = useUpdateAutomationRule(storeId);

  const [name, setName] = useState(rule?.name ?? '');
  const [trigger, setTrigger] = useState<AutomationRuleTrigger>(
    rule?.trigger ?? 'listing_stock_at_or_below',
  );
  const [action, setAction] = useState<AutomationRuleAction>(rule?.action ?? 'pause_listing');
  const [threshold, setThreshold] = useState(String(rule?.stockThreshold ?? 0));
  const [tag, setTag] = useState(rule?.tag ?? '');
  const [minTotal, setMinTotal] = useState(
    rule?.minOrderTotal ? toMajorString(rule.minOrderTotal.amount, currency) : '',
  );
  const [republish, setRepublish] = useState(rule?.republishWhenRestocked ?? true);

  const actions = AUTOMATION_RULE_ACTIONS_BY_TRIGGER[trigger].filter(
    (candidate) => candidate !== 'mark_order_processing' || can('orders:fulfill'),
  );

  const chooseTrigger = (next: AutomationRuleTrigger) => {
    setTrigger(next);
    const allowed = AUTOMATION_RULE_ACTIONS_BY_TRIGGER[next];
    if (!allowed.includes(action)) setAction(allowed[0] ?? 'notify_owner');
  };

  const onError = (error: unknown) => {
    const refusal = planRefusalOf(error);
    toast.error(
      refusal === 'limit'
        ? t('automations.limitReached')
        : refusal === 'capability'
          ? t('automations.notIncluded')
          : t('automations.form.error'),
    );
  };

  const submit = () => {
    if (!name.trim()) {
      toast.error(t('automations.form.nameRequired'));
      return;
    }
    const isStock = trigger === 'listing_stock_at_or_below';
    let stockThreshold: number | null = null;
    if (isStock) {
      const parsed = Number(threshold.trim());
      if (threshold.trim() === '' || !Number.isInteger(parsed) || parsed < 0) {
        toast.error(t('automations.form.thresholdInvalid'));
        return;
      }
      stockThreshold = parsed;
    }
    let minOrderTotal: { amount: number; currency: CurrencyCode } | null = null;
    if (!isStock && minTotal.trim() !== '') {
      const amount = toMinorUnits(minTotal, currency);
      if (amount === null) {
        toast.error(t('automations.form.minTotalInvalid'));
        return;
      }
      minOrderTotal = { amount, currency };
    }
    const shared = {
      name: name.trim(),
      stockThreshold,
      tag: tag.trim() === '' ? null : tag.trim(),
      minOrderTotal,
      republishWhenRestocked: action === 'pause_listing' ? republish : false,
    };

    if (rule) {
      const input: UpdateAutomationRuleInput = shared;
      update.mutate(
        { id: rule.id, input },
        {
          onSuccess: () => {
            toast.success(t('automations.form.saved'));
            onDone();
          },
          onError,
        },
      );
      return;
    }
    const input: CreateAutomationRuleInput = { ...shared, trigger, action };
    create.mutate(input, {
      onSuccess: () => {
        toast.success(t('automations.form.created'));
        onDone();
      },
      onError,
    });
  };

  return (
    <View className="gap-4">
      <Field label={t('automations.form.name')}>
        <TextFieldInput
          label={t('automations.form.name')}
          value={name}
          onValueChange={setName}
          placeholder={t('automations.form.namePlaceholder')}
        />
      </Field>
      {rule ? null : (
        <>
          <Field label={t('automations.form.trigger')}>
            <SegmentedControl type="radio" value={trigger} onValueChange={chooseTrigger}>
              {(Object.keys(TRIGGER_LABEL_KEYS) as AutomationRuleTrigger[]).map((value) => (
                <SegmentedControlItem key={value} value={value}>
                  <SegmentedControlItemText>
                    {t(TRIGGER_LABEL_KEYS[value])}
                  </SegmentedControlItemText>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </Field>
          <Field label={t('automations.form.action')}>
            <SegmentedControl type="radio" value={action} onValueChange={setAction}>
              {actions.map((value) => (
                <SegmentedControlItem key={value} value={value}>
                  <SegmentedControlItemText>{t(ACTION_LABEL_KEYS[value])}</SegmentedControlItemText>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </Field>
        </>
      )}
      {trigger === 'listing_stock_at_or_below' ? (
        <Field label={t('automations.form.threshold')}>
          <TextFieldInput
            label={t('automations.form.threshold')}
            value={threshold}
            onValueChange={setThreshold}
            keyboardType="number-pad"
          />
        </Field>
      ) : (
        <Field label={t('automations.form.minTotal', { currency })}>
          <TextFieldInput
            label={t('automations.form.minTotal', { currency })}
            value={minTotal}
            onValueChange={setMinTotal}
            keyboardType="decimal-pad"
          />
        </Field>
      )}
      <Field label={t('automations.form.tag')}>
        <TextFieldInput
          label={t('automations.form.tag')}
          value={tag}
          onValueChange={setTag}
          placeholder={t('automations.form.tagPlaceholder')}
          autoCapitalize="none"
        />
      </Field>
      {action === 'pause_listing' ? (
        <>
          <View className="flex-row items-center justify-between gap-3">
            <Text className="flex-1 text-sm text-foreground">
              {t('automations.form.republish')}
            </Text>
            <Switch
              checked={republish}
              onCheckedChange={setRepublish}
              accessibilityLabel={t('automations.form.republish')}
            />
          </View>
          <Text className="text-xs text-muted-foreground">{t('automations.form.pauseHint')}</Text>
        </>
      ) : null}
      {action === 'mark_order_processing' ? (
        <Text className="text-xs text-muted-foreground">{t('automations.form.processHint')}</Text>
      ) : null}
      <Button
        tone="accent"
        onPress={submit}
        loading={create.isPending || update.isPending}
        className="mt-1"
      >
        {rule ? t('common.save') : t('common.create')}
      </Button>
    </View>
  );
}
