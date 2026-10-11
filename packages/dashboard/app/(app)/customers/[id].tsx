import { View, Pressable } from 'react-native';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { ChevronLeft, User } from 'lucide-react-native';
import type { Customer, OrderSummary } from '@mercaria/shared-types';
import { Text, PriceDisplay, formatDate, useColorScheme } from '@mercaria/ui';
import { Screen, ScreenLoading } from '@/components/shell/Screen';
import { Button } from '@oxy.so/bloom/button';
import { DetailContent } from '@/components/shell/DetailContent';
import { canRetainDetailData } from '@/lib/detail-query-state';
import { RequireStore } from '@/components/shell/RequireStore';
import { OrderStatusBadge } from '@/components/orders/OrderStatusBadge';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import { useCustomer, useCustomerOrders } from '@/lib/hooks/use-customers';
import { useTranslation } from '@/lib/i18n';

export default function CustomerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('customers.detail.documentTitle')}</title>
      </Head>
      <RequireStore permission="customers:read">
        {(storeId) => (
          <CustomerDetailBody key={`${storeId}:${id}`} storeId={storeId} customerId={String(id)} />
        )}
      </RequireStore>
    </>
  );
}

function CustomerDetailBody({ storeId, customerId }: { storeId: string; customerId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { can } = useActiveStoreContext();
  const customer = useCustomer(storeId, customerId);
  const orders = useCustomerOrders(storeId, customerId);

  const back = (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">{t('common.back')}</Text>
    </Pressable>
  );

  const c = canRetainDetailData(customer.error) ? customer.data : undefined;
  const history = canRetainDetailData(orders.error) ? orders.data : undefined;
  const name = c
    ? (c.displayName ??
      c.email ??
      (c.isWalkIn ? t('customers.walkIn') : t('customers.fallbackName')))
    : t('customers.detail.title');

  return (
    <Screen title={name} subtitle={t('customers.detail.subtitle')} action={back}>
      <DetailContent
        testID="merchant-customer-detail"
        hasData={Boolean(c)}
        pending={customer.isPending}
        fetching={customer.isFetching}
        error={customer.isError}
        errorTitle={t('customers.detail.loadError')}
        onRetry={() => {
          void customer.refetch();
        }}
      >
        {c ? (
          <View className="gap-5">
            <CustomerCard customer={c} name={name} />
            <View
              testID="merchant-customer-orders"
              className="rounded-2xl border border-border bg-surface p-4"
            >
              <Text className="text-sm font-semibold text-foreground">
                {t('customers.detail.orders')}
              </Text>
              <View className="min-h-14 justify-center" accessibilityLiveRegion="polite">
                {orders.isError ? (
                  <View className="flex-row flex-wrap items-center justify-between gap-2">
                    <Text className="text-sm text-foreground">{t('orders.loadFailed')}</Text>
                    <Button
                      size="sm"
                      appearance="outline"
                      material="flat"
                      disabled={orders.isFetching}
                      onPress={() => {
                        void orders.refetch();
                      }}
                    >
                      {t('common.retry')}
                    </Button>
                  </View>
                ) : orders.isFetching && history ? (
                  <Text className="text-xs text-muted-foreground">{t('common.loading')}</Text>
                ) : null}
              </View>
              {orders.isPending ? (
                <ScreenLoading />
              ) : history?.length ? (
                <View className="gap-2">
                  {history.map((order) => (
                    <OrderRow key={order.id} order={order} canOpen={can('orders:read')} />
                  ))}
                </View>
              ) : !orders.isError && history ? (
                <Text className="text-sm text-muted-foreground">
                  {t('customers.detail.noOrders')}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}
      </DetailContent>
    </Screen>
  );
}

function CustomerCard({ customer, name }: { customer: Customer; name: string }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  return (
    <View
      testID="merchant-customer-card"
      className="rounded-2xl border border-border bg-surface p-4"
    >
      <View className="flex-row items-center gap-3">
        <View className="h-12 w-12 items-center justify-center rounded-full bg-muted">
          <User size={22} color={colors.mutedForeground} />
        </View>
        <View className="flex-1">
          <Text className="text-base font-semibold text-foreground">{name}</Text>
          {customer.email ? (
            <Text className="text-sm text-muted-foreground">{customer.email}</Text>
          ) : null}
          {customer.phone ? (
            <Text className="text-sm text-muted-foreground">{customer.phone}</Text>
          ) : null}
        </View>
      </View>
      <View className="mt-4 flex-row gap-4">
        <View className="flex-1">
          <Text className="text-xs uppercase text-muted-foreground">
            {t('customers.detail.orders')}
          </Text>
          <Text className="text-lg font-bold text-foreground">{customer.stats.orderCount}</Text>
        </View>
        <View className="flex-1">
          <Text className="text-xs uppercase text-muted-foreground">
            {t('customers.detail.lifetimeSpend')}
          </Text>
          <PriceDisplay price={customer.stats.totalSpent} primaryClassName="text-lg font-bold" />
        </View>
      </View>
    </View>
  );
}

function OrderRow({ order, canOpen }: { order: OrderSummary; canOpen: boolean }) {
  const { locale } = useTranslation();
  const content = (
    <Pressable
      disabled={!canOpen}
      accessibilityLabel={order.orderNumber}
      className="flex-row items-center justify-between gap-3 rounded-xl border border-border p-3 active:opacity-80"
    >
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{order.orderNumber}</Text>
        {/* The date stands alone under the order number, so an unformattable
            one renders nothing rather than "Invalid Date" — which is what the
            replaced expression produced, untranslated, in all twelve locales. */}
        <Text className="text-xs text-muted-foreground">{formatDate(order.createdAt, locale)}</Text>
      </View>
      <PriceDisplay price={order.grandTotal.shop} primaryClassName="text-sm font-semibold" />
      <OrderStatusBadge status={order.status} />
    </Pressable>
  );
  return canOpen ? (
    <Link href={{ pathname: '/orders/[id]', params: { id: order.id } }} asChild>
      {content}
    </Link>
  ) : (
    content
  );
}
