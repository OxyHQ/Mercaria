import { useEffect, type ReactNode } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { RadioGroup } from '@oxy.so/bloom/radio';
import { Collapsible } from '@oxy.so/bloom/collapsible';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectItemIndicator,
} from '@oxy.so/bloom/select';
import type { Money } from '@mercaria/shared-types';
import { Text } from '../ui/text';
import { PriceDisplay, usePriceText } from '../PriceDisplay';
import { useSharedUiTranslation } from '../../i18n/ui-translation';
import { useColorScheme } from '../../lib/useColorScheme';

/** Display data supplied by a selling-plan allocation. Prices and savings are
 * authoritative inputs, never calculated from a promotional percentage here.
 * This is presentation only: it neither authorizes nor creates recurring orders. */
export interface PurchasePlan {
  id: string;
  price: Money;
  originalPrice?: Money;
  frequencyLabel: string;
  savingsLabel?: string;
  prepaidLabel?: string;
  introductoryLabel?: string;
  unavailable?: boolean;
}

export type PurchasePlanSelection = { kind: 'one-time' } | { kind: 'subscription'; planId: string };

export interface PurchasePlanPickerProps {
  oneTimePrice: Money;
  plans: readonly PurchasePlan[];
  requiresSubscription?: boolean;
  mode: PurchasePlanSelection['kind'];
  selectedPlanId?: string;
  onModeChange: (mode: PurchasePlanSelection['kind']) => void;
  onPlanChange: (planId: string) => void;
  disabled?: boolean;
  renderActions: (selection: PurchasePlanSelection, plan?: PurchasePlan) => ReactNode;
}

function PlanPanel({
  checked,
  subscription,
  children,
}: {
  checked: boolean;
  subscription: boolean;
  children: ReactNode;
}) {
  const { colors } = useColorScheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(checked ? 1 : 0);
  useEffect(() => {
    const target = checked ? 1 : 0;
    progress.value = reduced
      ? target
      : withTiming(target, {
          duration: subscription ? 200 : 500,
          easing: Easing.bezier(0.42, 0, 0.58, 1),
        });
  }, [checked, progress, reduced, subscription]);
  const paint = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [colors.background, colors.card]),
    // The expanded body's measured padding owns its bottom gutter, so button
    // shadows have room inside the clipping viewport during the transition.
    paddingBottom: (subscription ? 8 : 16) * (1 - progress.value),
  }));
  return (
    <Animated.View
      className="p-space-16"
      style={[{ borderTopWidth: subscription ? 1 : 0, borderTopColor: colors.border }, paint]}
    >
      {children}
    </Animated.View>
  );
}

function PlanSummary({
  title,
  price,
  originalPrice,
  savingsLabel,
  prepaidLabel,
  introductoryLabel,
}: {
  title: string;
  price: Money;
} & Pick<PurchasePlan, 'originalPrice' | 'savingsLabel' | 'prepaidLabel' | 'introductoryLabel'>) {
  return (
    <View className="flex-1 gap-space-4">
      <View className="flex-row flex-wrap items-center gap-space-8">
        <Text className="text-shop-bodyTitleSmall text-foreground">{title}</Text>
        {savingsLabel ? (
          <View className="rounded-full bg-foreground px-space-6 py-space-2">
            <Text className="text-shop-badgeBold text-background">{savingsLabel}</Text>
          </View>
        ) : null}
      </View>
      <View className="flex-row flex-wrap items-baseline gap-space-8">
        <PriceDisplay price={price} primaryClassName="text-shop-bodyTitleLarge" />
        {originalPrice ? (
          <PriceDisplay
            price={originalPrice}
            primaryClassName="text-shop-bodyTitleLarge text-muted-foreground line-through"
          />
        ) : null}
      </View>
      {prepaidLabel ? (
        <Text className="text-shop-caption text-muted-foreground">{prepaidLabel}</Text>
      ) : null}
      {introductoryLabel ? (
        <Text className="text-shop-caption text-muted-foreground">{introductoryLabel}</Text>
      ) : null}
    </View>
  );
}

/** Shop's one-time/subscription card composition. Bloom owns radio navigation,
 * the frequency popover/sheet and height/focus transitions. Controls in the
 * expanding body are siblings of the radio, never nested inside its label. */
export function PurchasePlanPicker({
  oneTimePrice,
  plans,
  requiresSubscription = false,
  mode,
  selectedPlanId,
  onModeChange,
  onPlanChange,
  disabled = false,
  renderActions,
}: PurchasePlanPickerProps) {
  const t = useSharedUiTranslation();
  const priceText = usePriceText();
  const { colors } = useColorScheme();
  const plan = plans.find((item) => item.id === selectedPlanId);
  // An allocation removed by a variant change must never authorize an action.
  // The parent reconciles selection; this display does not pick another price.
  const frequency = plan ? (
    <View className="mt-space-12 mb-space-16">
      {plans.length === 1 ? (
        <Text className="text-shop-caption text-muted-foreground">{plan.frequencyLabel}</Text>
      ) : (
        <Select value={plan.id} disabled={disabled} onValueChange={onPlanChange} size="sm">
          <SelectTrigger
            label={t('ui.purchase.deliveryFrequency')}
            testID="purchase-plan-frequency"
            fieldStyle={{
              borderWidth: 0,
              backgroundColor: 'transparent',
              paddingLeft: 0,
              paddingRight: 0,
              paddingTop: 0,
              paddingBottom: 0,
            }}
          >
            <SelectValue style={{ fontSize: 12, lineHeight: 16, color: colors.mutedForeground }} />
            <SelectIcon />
          </SelectTrigger>
          <SelectContent
            label={t('ui.purchase.deliveryFrequency')}
            items={plans.map((item) => ({ value: item.id, label: item.frequencyLabel }))}
            renderItem={(item) => (
              <SelectItem value={item.value} label={item.label}>
                <SelectItemText>{item.label}</SelectItemText>
                <SelectItemIndicator />
              </SelectItem>
            )}
          />
        </Select>
      )}
    </View>
  ) : null;

  if (!plan)
    return requiresSubscription || plans.length > 0 ? null : (
      <>{renderActions({ kind: 'one-time' })}</>
    );
  const subscriptionTitle = t(
    requiresSubscription
      ? 'ui.purchase.subscriptionRequired'
      : plan.savingsLabel
        ? 'ui.purchase.subscribeAndSave'
        : 'ui.purchase.subscription',
  );
  const summary = <PlanSummary title={subscriptionTitle} {...plan} />;
  const subscriptionActions = renderActions({ kind: 'subscription', planId: plan.id }, plan);

  if (requiresSubscription)
    return (
      <View
        className="-mx-space-8 rounded-[28px] border border-border bg-card p-space-16 shadow-shop-s"
        testID="purchase-plan-required"
      >
        {summary}
        {frequency}
        {subscriptionActions}
      </View>
    );

  return (
    <View
      className="-mx-space-8 sm:mx-0 overflow-hidden rounded-[28px] border border-border bg-muted shadow-shop-s"
      testID="purchase-plan-picker"
    >
      <RadioGroup
        label={t('ui.purchase.options')}
        size="lg"
        tone="neutral"
        value={mode}
        disabled={disabled}
        style={{ gap: 0 }}
        optionStyle={{
          flexDirection: 'row-reverse',
          alignItems: 'center',
          width: '100%',
          padding: 0,
        }}
        onValueChange={onModeChange}
        options={[
          {
            value: 'one-time',
            label: t('ui.purchase.oneTime'),
            accessibilityLabel: `${t('ui.purchase.oneTime')}, ${priceText(oneTimePrice).primary}`,
            labelContent: <PlanSummary title={t('ui.purchase.oneTime')} price={oneTimePrice} />,
          },
          {
            value: 'subscription',
            label: subscriptionTitle,
            accessibilityLabel: [
              subscriptionTitle,
              plan.savingsLabel,
              priceText(plan.price).primary,
              plan.prepaidLabel,
              plan.introductoryLabel,
            ]
              .filter(Boolean)
              .join(', '),
            labelContent: summary,
          },
        ]}
        renderOption={(option, control, { checked, controlRef }) => (
          <PlanPanel
            key={option.value}
            checked={checked}
            subscription={option.value === 'subscription'}
          >
            {control}
            <Collapsible
              open={checked}
              returnFocusRef={controlRef}
              style={{ marginHorizontal: -16 }}
              contentStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
              testID={`purchase-plan-body-${option.value}`}
            >
              {option.value === 'subscription' ? (
                <>
                  {frequency}
                  {subscriptionActions}
                </>
              ) : (
                <View className="mt-space-12">{renderActions({ kind: 'one-time' })}</View>
              )}
            </Collapsible>
          </PlanPanel>
        )}
      />
    </View>
  );
}
