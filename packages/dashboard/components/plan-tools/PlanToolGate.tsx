import type React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { MerchantEntitlementCapability, StoreCapabilityView } from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';
import { Button } from '@oxy.so/bloom/button';
import { ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { useTranslation } from '@/lib/i18n';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import { useStoreCapability } from '@/lib/hooks/use-plan';

/**
 * Renders a paid tool's screen when the store holds the capability, and a calm
 * explanation when it does not (#89 UX 5 and 6: no urgency, no threat).
 *
 * The explanation names the plans ON SALE that include the tool — read from the
 * server, never from a design constant — and links to the plan screen for
 * whoever may change the plan (`store:manage`); anyone else is told to ask the
 * store owner. Everything the store created with the tool earlier stays on the
 * server, readable and exportable; this gate hides only the tool's own screen.
 */
export function PlanToolGate({
  storeId,
  capability,
  children,
}: {
  storeId: string;
  capability: MerchantEntitlementCapability;
  children: (capability: StoreCapabilityView) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const { isPending, isError, capability: view } = useStoreCapability(storeId, capability);

  if (isPending) return <ScreenLoading />;
  if (isError) {
    return <ScreenMessage title={t('planTools.loadFailed')} body={t('common.pleaseTryAgain')} />;
  }
  if (!view) {
    return (
      <ScreenMessage
        title={t('planTools.unavailableTitle')}
        body={t('planTools.unavailableBody')}
      />
    );
  }
  if (!view.entitled) return <PlanToolUpsell view={view} />;
  return <>{children(view)}</>;
}

/** The not-included state: which plans include the tool, and who can change the plan. */
export function PlanToolUpsell({ view }: { view: StoreCapabilityView }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { can } = useActiveStoreContext();
  const plans = view.includedIn.map((plan) => plan.name).join(', ');

  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">{t('planTools.gateTitle')}</Text>
      <Text className="text-sm text-muted-foreground">
        {plans.length > 0 ? t('planTools.gateIncludedIn', { plans }) : t('planTools.gateNoPlan')}
      </Text>
      <Text className="text-xs text-muted-foreground">{t('planTools.gateFreeReminder')}</Text>
      {can('store:manage') ? (
        <View className="flex-row">
          <Button tone="accent" onPress={() => router.push('/settings/plan')}>
            {t('planTools.seePlans')}
          </Button>
        </View>
      ) : (
        <Text className="text-xs text-muted-foreground">{t('planTools.askOwner')}</Text>
      )}
    </View>
  );
}

/**
 * "3 of 5 used" for a quantified allowance, "Included" for a flag. Usage is the
 * server's counter; the client never computes what is left.
 */
export function PlanUsage({ view }: { view: StoreCapabilityView }) {
  const { t } = useTranslation();
  const text =
    view.limitKind === 'flag'
      ? t('planTools.usageIncluded')
      : view.limit === null
        ? t('planTools.usageNoLimit', { used: view.used })
        : t(
            view.limitKind === 'per_period'
              ? 'planTools.usageOfLimitPeriod'
              : 'planTools.usageOfLimit',
            {
              used: view.used,
              limit: view.limit,
            },
          );
  return <Text className="text-xs text-muted-foreground">{text}</Text>;
}
