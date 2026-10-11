import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { assertSafeMoneyAmount, type Money } from '@mercaria/shared-types';
import {
  PurchaseOptions,
  PurchasePlanPicker,
  Text,
  useFormatters,
  type PurchasePlan,
  type PurchasePlanSelection,
} from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import type { PurchasePreview } from '@/lib/catalog/purchase-preview';

function sampleMoney(amount: number): Money {
  assertSafeMoneyAmount(amount, 'purchase-plan-preview');
  return { amount, currency: 'EUR' };
}

/** Isolated UI fixture. No cart, checkout or order hook is imported here.
 * Its parent remounts it when the variant/scenario changes, clearing feedback. */
export function PurchasePlanPreview({ scenario }: { scenario: PurchasePreview }) {
  const { t } = useTranslation();
  const { formatPercent, formatMoney } = useFormatters();
  const required = scenario === 'required';
  const [mode, setMode] = useState<PurchasePlanSelection['kind']>(
    required ? 'subscription' : 'one-time',
  );
  const [planId, setPlanId] = useState('monthly');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<'cart' | 'checkout'>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const clearFeedback = () => {
    clearTimeout(timer.current);
    setPending(false);
    setResult(undefined);
  };
  const simulate = (action: 'cart' | 'checkout') => {
    clearTimeout(timer.current);
    setResult(undefined);
    setPending(true);
    timer.current = setTimeout(() => {
      setPending(false);
      setResult(action);
      timer.current = setTimeout(() => setResult(undefined), 3000);
    }, 500);
  };
  const originalPrice = sampleMoney(2999);
  const plans: PurchasePlan[] = [
    {
      id: 'monthly',
      price: sampleMoney(scenario === 'prepaid' ? 7647 : scenario === 'introductory' ? 1499 : 2549),
      originalPrice: scenario === 'prepaid' ? sampleMoney(8997) : originalPrice,
      savingsLabel: t('product.purchasePreview.save', {
        percent: formatPercent(scenario === 'introductory' ? 5000 : 1500, 0),
      }),
      frequencyLabel: t('product.purchasePreview.monthly'),
      unavailable: scenario === 'unavailable',
      prepaidLabel:
        scenario === 'prepaid'
          ? t('product.purchasePreview.prepaid', { price: formatMoney(sampleMoney(2549)) })
          : undefined,
      introductoryLabel:
        scenario === 'introductory'
          ? t('product.purchasePreview.introductory', { price: formatMoney(sampleMoney(2549)) })
          : undefined,
    },
  ];
  if (!required && scenario !== 'prepaid' && scenario !== 'introductory')
    plans.push({
      id: 'bimonthly',
      price: sampleMoney(2399),
      originalPrice,
      savingsLabel: t('product.purchasePreview.save', { percent: formatPercent(2000, 0) }),
      frequencyLabel: t('product.purchasePreview.bimonthly'),
      unavailable: scenario === 'unavailable',
    });

  return (
    <View className="gap-space-12" testID="purchase-plan-preview">
      <Text className="text-shop-caption text-muted-foreground">
        {t('product.purchasePreview.notice')}
      </Text>
      <PurchasePlanPicker
        oneTimePrice={originalPrice}
        plans={plans}
        requiresSubscription={required}
        mode={mode}
        selectedPlanId={planId}
        onModeChange={(value) => {
          clearFeedback();
          setMode(value);
        }}
        onPlanChange={(value) => {
          clearFeedback();
          setPlanId(value);
        }}
        disabled={pending}
        renderActions={(selection, plan) => (
          <PurchaseOptions
            horizontal
            purchaseKind={selection.kind}
            canBuy={!plan?.unavailable}
            added={result === 'cart' && selection.kind === mode}
            isPending={pending}
            onAddToCart={() => simulate('cart')}
            onBuyNow={() => simulate('checkout')}
          />
        )}
      />
      <Text
        accessibilityLiveRegion="polite"
        className="text-shop-caption text-muted-foreground"
        testID="purchase-preview-result"
      >
        {result
          ? t(
              result === 'cart'
                ? 'product.purchasePreview.cartResult'
                : 'product.purchasePreview.checkoutResult',
            )
          : ''}
      </Text>
    </View>
  );
}
