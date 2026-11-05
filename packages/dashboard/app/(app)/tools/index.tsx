import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { ChevronRight } from 'lucide-react-native';
import { Text, useColorScheme } from '@mercaria/ui';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import { PlanUsage } from '@/components/plan-tools/PlanToolGate';
import { useTranslation } from '@/lib/i18n';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import { useStoreCapabilities } from '@/lib/hooks/use-plan';
import { PLAN_TOOLS } from '@/lib/plan-tools';

/**
 * Tools — the paid tools a Mercaria plan unlocks, in one place (#89).
 *
 * Every row opens the tool; a tool the store does not hold opens to its own
 * calm explanation (`PlanToolGate`) rather than being hidden, so a merchant can
 * see what a tool does before deciding anything. Free commerce is not listed
 * here because none of it is a tool a plan sells.
 */
export default function ToolsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('planTools.documentTitle')}</title>
      </Head>
      <RequireStore>{(storeId) => <ToolsBody storeId={storeId} />}</RequireStore>
    </>
  );
}

function ToolsBody({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
  const { can } = useActiveStoreContext();
  const capabilities = useStoreCapabilities(storeId);

  if (capabilities.isPending) {
    return (
      <Screen title={t('planTools.title')}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (capabilities.isError || !capabilities.data) {
    return (
      <Screen title={t('planTools.title')}>
        <ScreenMessage title={t('planTools.loadFailed')} body={t('common.pleaseTryAgain')} />
      </Screen>
    );
  }

  const byKey = new Map(capabilities.data.capabilities.map((view) => [view.capability, view]));
  const tools = PLAN_TOOLS.filter((tool) => byKey.has(tool.capability) && can(tool.permission));

  return (
    <Screen title={t('planTools.title')} subtitle={t('planTools.subtitle')}>
      {tools.length === 0 ? (
        <ScreenMessage title={t('planTools.emptyTitle')} body={t('planTools.emptyBody')} />
      ) : (
        <View className="gap-2">
          {tools.map((tool) => {
            const view = byKey.get(tool.capability);
            const Icon = tool.icon;
            return (
              <Pressable
                key={tool.capability}
                onPress={() => router.push(tool.href)}
                className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-70"
              >
                <Icon size={20} color={colors.foreground} />
                <View className="flex-1 gap-1">
                  <Text className="text-sm font-semibold text-foreground">{t(tool.labelKey)}</Text>
                  <Text className="text-xs text-muted-foreground">{t(tool.descriptionKey)}</Text>
                  {view?.entitled ? (
                    <PlanUsage view={view} />
                  ) : (
                    <Text className="text-xs text-muted-foreground">
                      {t('planTools.notIncluded')}
                    </Text>
                  )}
                </View>
                <ChevronRight size={16} color={colors.mutedForeground} />
              </Pressable>
            );
          })}
        </View>
      )}
    </Screen>
  );
}
