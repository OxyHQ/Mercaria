import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Text, useFormatters } from '@mercaria/ui';
import type { CheckoutInput, CurrencyCode } from '@mercaria/shared-types';
import { nanoid } from 'nanoid/non-secure';
import { ScreenShell } from '@/components/shell/ScreenShell';
import {
  CheckoutDestinationForm,
  EMPTY_CHECKOUT_DRAFT,
  cleanAddress,
  isDraftComplete,
} from '@/components/checkout/CheckoutDestinationForm';
import { CardPaymentStep } from '@/components/payment/CardPaymentStep';
import { useTranslation } from '@/lib/i18n';
import {
  prepareSupervisedPurchase,
  resumeSupervisedPurchase,
  supervisedPurchase,
} from '@/lib/api/supervised-shopping';

export default function SupervisedCheckoutScreen() {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const { user, showBottomSheet } = useOxy();
  const router = useRouter();
  const params = useLocalSearchParams<{ checkoutGroupId?: string }>();
  const checkoutGroupId =
    typeof params.checkoutGroupId === 'string' ? params.checkoutGroupId : undefined;
  const [draft, setDraft] = useState(EMPTY_CHECKOUT_DRAFT);
  const attempt = useRef<{ key: string; input: CheckoutInput } | undefined>(undefined);
  const [paymentError, setPaymentError] = useState(false);
  const [sheetClosed, setSheetClosed] = useState(false);
  const purchase = useQuery({
    queryKey: ['supervised-shopping', user?.id, 'checkout', checkoutGroupId],
    queryFn: () => {
      if (!checkoutGroupId) throw new Error('Checkout group is missing');
      return supervisedPurchase(checkoutGroupId);
    },
    enabled: !!user?.id && !!checkoutGroupId,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) =>
      ['confirmed', 'rejected', 'cancelled'].includes(
        query.state.data?.purchaseApproval.status ?? '',
      )
        ? false
        : 5000,
  });
  const prepare = useMutation({
    mutationFn: () => {
      // Keep the exact request and key through a lost response. Contact values stay
      // in memory; only the server-issued group is ever placed in a URL.
      attempt.current ??= {
        key: nanoid(),
        input: {
          paymentMethod: 'card',
          destination: {
            type: 'inline_shipping_address',
            address: cleanAddress(draft.address),
            saveToAddressBook: false,
          },
        },
      };
      return prepareSupervisedPurchase(attempt.current.input, attempt.current.key);
    },
    onSuccess: (result) =>
      router.replace({
        pathname: '/supervised-shopping/checkout',
        params: { checkoutGroupId: result.checkoutGroupId },
      }),
  });
  const resume = useMutation({
    mutationFn: () => {
      if (!checkoutGroupId) throw new Error('Checkout group is missing');
      return resumeSupervisedPurchase(checkoutGroupId);
    },
    onSuccess: () => {
      setSheetClosed(false);
      setPaymentError(false);
      void purchase.refetch();
    },
  });
  const approval = !purchase.isError ? purchase.data?.purchaseApproval : undefined;
  const paid =
    purchase.data?.paymentStatus?.status === 'succeeded' || approval?.status === 'confirmed';
  const statusLabel =
    approval?.status === 'pending'
      ? t('supervisedShopping.pending')
      : approval?.status === 'approved' || approval?.status === 'reserved'
        ? t('supervisedShopping.approved')
        : approval?.status === 'confirmed'
          ? t('supervisedShopping.paid')
          : t('supervisedShopping.closed');
  const money = (amount: number) => {
    if (!approval) return '';
    return formatMoney({ amount, currency: approval.currency as CurrencyCode });
  };
  return (
    <ScreenShell hideComposer>
      <View className="mx-auto w-full max-w-2xl gap-5 px-4 py-6 md:px-8">
        <Text accessibilityRole="header" className="text-2xl font-bold">
          {t('supervisedShopping.reviewPurchase')}
        </Text>
        {!checkoutGroupId ? (
          <>
            <Text className="text-muted-foreground">{t('supervisedShopping.approvalIntro')}</Text>
            {!attempt.current ? (
              <CheckoutDestinationForm
                draft={draft}
                onChange={setDraft}
                canSaveToAddressBook={false}
                collectContact={false}
              />
            ) : null}
            {prepare.isError ? (
              <Text accessibilityRole="alert">{t('supervisedShopping.prepareError')}</Text>
            ) : null}
            <Button
              disabled={prepare.isPending || (!attempt.current && !isDraftComplete(draft, false))}
              onPress={() => prepare.mutate()}
            >
              {prepare.isPending
                ? t('common.loading')
                : attempt.current
                  ? t('common.tryAgain')
                  : t('supervisedShopping.requestApproval')}
            </Button>
          </>
        ) : purchase.isPending ? (
          <Loading accessibilityLabel={t('common.loading')} />
        ) : purchase.isError ? (
          <>
            <EmptyState
              title={t('supervisedShopping.unavailable')}
              description={t('supervisedShopping.unavailableBody')}
            />
            <Button tone="neutral" onPress={() => purchase.refetch()}>
              {t('common.tryAgain')}
            </Button>
          </>
        ) : approval ? (
          <>
            <Text className="text-lg font-semibold" accessibilityLiveRegion="polite">
              {paid ? t('supervisedShopping.paid') : statusLabel}
            </Text>
            {approval.lineItems.map((line) => (
              <View key={line.itemReference} className="gap-1 border-b border-border pb-3">
                <Text className="font-medium">{line.title}</Text>
                {line.optionsText ? (
                  <Text className="text-sm text-muted-foreground">{line.optionsText}</Text>
                ) : null}
                <Text>
                  {line.quantity} · {money(line.lineAmountMinor)}
                </Text>
              </View>
            ))}
            <Text>
              {t('supervisedShopping.shipping')}: {money(approval.shippingMinor)}
            </Text>
            <Text>
              {t('supervisedShopping.tax')}: {money(approval.taxMinor)}
            </Text>
            {approval.discountMinor ? (
              <Text>
                {t('supervisedShopping.discount')}: {money(approval.discountMinor)}
              </Text>
            ) : null}
            {approval.roundingAdjustmentMinor ? (
              <Text>
                {t('supervisedShopping.rounding')}: {money(approval.roundingAdjustmentMinor)}
              </Text>
            ) : null}
            <Text className="text-xl font-semibold">
              {t('supervisedShopping.total')}: {money(approval.amountMinor)}
            </Text>
            <Button
              tone="neutral"
              appearance="outline"
              onPress={() =>
                showBottomSheet?.({ screen: 'Supervision', props: { approvalId: approval.id } })
              }
            >
              {t('supervisedShopping.viewApproval')}
            </Button>
            {!paid &&
            (approval.status === 'approved' || approval.status === 'reserved') &&
            !resume.data?.payment ? (
              <Button disabled={resume.isPending} onPress={() => resume.mutate()}>
                {resume.isPending ? t('common.loading') : t('supervisedShopping.continuePayment')}
              </Button>
            ) : null}
            {!paid && resume.data?.payment && !sheetClosed ? (
              <CardPaymentStep
                payment={resume.data.payment}
                onCompleted={() => {
                  setSheetClosed(true);
                  void purchase.refetch();
                }}
                onCancelled={() => {
                  setSheetClosed(true);
                  void purchase.refetch();
                }}
                onFailed={() => setPaymentError(true)}
              />
            ) : null}
            {!paid && sheetClosed ? (
              <Button
                tone="neutral"
                onPress={() => {
                  resume.reset();
                  setSheetClosed(false);
                }}
              >
                {t('supervisedShopping.continuePayment')}
              </Button>
            ) : null}
            {resume.isError || paymentError ? (
              <Text accessibilityRole="alert">{t('supervisedShopping.paymentError')}</Text>
            ) : null}
            {approval.status === 'pending' ? (
              <Text className="text-muted-foreground">{t('supervisedShopping.pendingBody')}</Text>
            ) : null}
            <Button tone="neutral" appearance="plain" onPress={() => purchase.refetch()}>
              {t('supervisedShopping.refresh')}
            </Button>
          </>
        ) : null}
        <Button
          tone="neutral"
          appearance="plain"
          onPress={() => router.replace('/supervised-shopping')}
        >
          {t('checkout.keepShopping')}
        </Button>
      </View>
    </ScreenShell>
  );
}
