import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { LayoutList, Plus, Trash2 } from 'lucide-react-native';
import type {
  MerchandisingRule,
  MerchandisingRuleStatus,
  StoreCapabilityView,
} from '@mercaria/shared-types';
import { Text, toBloomIcon, useColorScheme } from '@mercaria/ui';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import { PlanToolGate, PlanUsage } from '@/components/plan-tools/PlanToolGate';
import { STRATEGY_KEYS } from '@/components/merchandising/RuleEditor';
import { useTranslation } from '@/lib/i18n';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import { useStoreCapability } from '@/lib/hooks/use-plan';
import { useCollections } from '@/lib/hooks/use-collections';
import { useDeleteMerchandisingRule, useMerchandisingRules } from '@/lib/hooks/use-merchandising';

const CAPABILITY = 'advanced_merchandising_rules' as const;

/** KEYS, resolved at render. */
const STATUS_KEYS: Record<MerchandisingRuleStatus, string> = {
  live: 'merchandising.status.live',
  superseded: 'merchandising.status.superseded',
  scheduled: 'merchandising.status.scheduled',
  ended: 'merchandising.status.ended',
  paused: 'merchandising.status.paused',
  detached: 'merchandising.status.detached',
};

/**
 * Merchandising — the paid store-page rules (`advanced_merchandising_rules`).
 *
 * The rules are listed whatever the plan says: a store whose plan no longer
 * includes the tool still sees what it made, and may delete it; its rules simply
 * stop applying to the store page. Creating and editing sit behind the gate.
 */
export default function MerchandisingScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('merchandising.documentTitle')}</title>
      </Head>
      <RequireStore permission="products:read">
        {(storeId) => <MerchandisingBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function MerchandisingBody({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { can } = useActiveStoreContext();
  const capability = useStoreCapability(storeId, CAPABILITY);
  const entitled = capability.capability?.entitled === true;

  const action =
    entitled && can('collections:write') ? (
      <Button
        tone="accent"
        leadingIcon={toBloomIcon(Plus)}
        onPress={() => router.push('/tools/merchandising/new')}
      >
        {t('merchandising.newRule')}
      </Button>
    ) : undefined;

  return (
    <Screen title={t('merchandising.title')} subtitle={t('merchandising.subtitle')} action={action}>
      <PlanToolGate storeId={storeId} capability={CAPABILITY}>
        {(view) => <RuleList storeId={storeId} view={view} />}
      </PlanToolGate>
      {!capability.isPending && capability.capability && !entitled ? (
        <KeptRules storeId={storeId} />
      ) : null}
    </Screen>
  );
}

/** The not-entitled view's second half: what the store made stays, readable and removable. */
function KeptRules({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const rules = useMerchandisingRules(storeId);
  if (!rules.data || rules.data.length === 0) return null;
  return (
    <View className="mt-6 gap-2">
      <Text className="text-sm text-muted-foreground">{t('merchandising.keptRules')}</Text>
      <Rows storeId={storeId} rules={rules.data} openable={false} />
    </View>
  );
}

function RuleList({ storeId, view }: { storeId: string; view: StoreCapabilityView }) {
  const { t } = useTranslation();
  const rules = useMerchandisingRules(storeId);
  return (
    <View className="gap-4">
      <PlanUsage view={view} />
      {rules.isPending ? (
        <ScreenLoading />
      ) : rules.isError ? (
        <ScreenMessage title={t('merchandising.loadError')} body={t('common.pleaseTryAgain')} />
      ) : rules.data.length === 0 ? (
        <ScreenMessage
          title={t('merchandising.empty.title')}
          body={t('merchandising.empty.body')}
        />
      ) : (
        <Rows storeId={storeId} rules={rules.data} openable />
      )}
    </View>
  );
}

function Rows({
  storeId,
  rules,
  openable,
}: {
  storeId: string;
  rules: MerchandisingRule[];
  openable: boolean;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
  const { can } = useActiveStoreContext();
  const collections = useCollections(storeId);
  const remove = useDeleteMerchandisingRule(storeId);
  const titleOf = new Map((collections.data ?? []).map((c) => [c.id, c.title]));

  const describe = (rule: MerchandisingRule): string => {
    const target =
      rule.target === 'store'
        ? t('merchandising.target.store')
        : rule.collectionId
          ? (titleOf.get(rule.collectionId) ?? t('merchandising.target.collection'))
          : t('merchandising.target.deleted');
    const what =
      rule.kind === 'spotlight'
        ? t('merchandising.kind.spotlight')
        : t(STRATEGY_KEYS[rule.sortStrategy ?? 'newest']);
    return t('merchandising.rowMeta', {
      what,
      target,
      state: t(STATUS_KEYS[rule.status]),
    });
  };

  return (
    <View className="gap-2">
      {rules.map((rule) => (
        <View
          key={rule.id}
          className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3"
        >
          <Pressable
            className="flex-1 flex-row items-center gap-3 active:opacity-70"
            disabled={!openable}
            accessibilityRole={openable ? 'button' : undefined}
            onPress={() =>
              router.push({ pathname: '/tools/merchandising/[id]', params: { id: rule.id } })
            }
          >
            <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
              <LayoutList size={18} color={colors.mutedForeground} />
            </View>
            <View className="flex-1">
              <Text className="text-sm font-semibold text-foreground">{rule.title}</Text>
              <Text className="text-xs text-muted-foreground">{describe(rule)}</Text>
              {rule.applying ? (
                <Text className="text-xs text-foreground">{t('merchandising.applying')}</Text>
              ) : null}
            </View>
          </Pressable>
          {can('collections:write') ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('merchandising.delete')}
              className="p-2 active:opacity-70"
              disabled={remove.isPending}
              onPress={() =>
                remove.mutate(rule.id, {
                  onSuccess: () => toast.success(t('merchandising.deleted')),
                  onError: () => toast.error(t('merchandising.deleteError')),
                })
              }
            >
              <Trash2 size={16} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}
