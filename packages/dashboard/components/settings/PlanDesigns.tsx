import { View } from 'react-native';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import { MERCHANT_PLAN_DESIGNS, MERCHANT_PLAN_DESIGN_COPY } from '@/lib/merchant-plan-designs';

/** A clearly labelled product proposal, separate from server-owned offers and billing. */
export function PlanDesigns() {
  const { t } = useTranslation();
  return (
    <View className="gap-4">
      <View className="gap-1">
        <Text className="text-lg font-semibold text-foreground">
          {t('settings.plan.design.title')}
        </Text>
        <Text className="text-sm text-muted-foreground">{t('settings.plan.design.notice')}</Text>
      </View>
      <View className="flex-row flex-wrap gap-4">
        {MERCHANT_PLAN_DESIGNS.map((plan) => (
          <View
            key={plan.key}
            className="min-w-64 flex-1 gap-3 rounded-2xl border border-border bg-surface p-4"
          >
            <Text className="text-base font-semibold text-foreground">{t(plan.nameKey)}</Text>
            <Text className="text-sm text-muted-foreground">{t(plan.summaryKey)}</Text>
            <View className="gap-2">
              {plan.capabilities.map((capability) => (
                <Text key={capability} className="text-sm text-foreground">
                  {t(MERCHANT_PLAN_DESIGN_COPY[capability])}
                </Text>
              ))}
            </View>
          </View>
        ))}
      </View>
      <Text className="text-sm text-muted-foreground">{t('settings.plan.design.ethics')}</Text>
    </View>
  );
}
