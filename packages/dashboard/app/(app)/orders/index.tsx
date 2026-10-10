import React, { useState } from 'react';
import { View, Pressable, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import type { OrderStatus, MerchantOrderSummary } from '@mercaria/shared-types';
import {
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
} from '@oxy.so/bloom/table';
import { Text, PriceDisplay, formatDate } from '@mercaria/ui';
import { Screen } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import {
  StatusFilter,
  ResourceList,
  ResourceState,
  ListPagination,
} from '@/components/lists/ResourceList';
import { OrderStatusBadge, ORDER_STATUS_LABEL_KEYS } from '@/components/orders/OrderStatusBadge';
import { useOrders } from '@/lib/hooks/use-orders';
import { useTranslation } from '@/lib/i18n';

export default function OrdersScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('orders.documentTitle')}</title>
      </Head>
      <RequireStore permission="orders:read">
        {(storeId) => <OrdersBody key={storeId} storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function OrdersBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { t, locale } = useTranslation();
  const { width } = useWindowDimensions();
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const [page, setPage] = useState(1);
  const { data, isPending, isFetching, isPlaceholderData, isError, refetch } = useOrders(
    storeId,
    page,
    status,
  );
  const orders = data?.data ?? [];
  const options = [
    { value: 'all' as const, label: t('common.all') },
    ...(Object.keys(ORDER_STATUS_LABEL_KEYS) as OrderStatus[]).map((value) => ({
      value,
      label: t(ORDER_STATUS_LABEL_KEYS[value]),
    })),
  ];
  const openOrder = (id: string) => router.push({ pathname: '/orders/[id]', params: { id } });
  const orderLink = (order: MerchantOrderSummary) => (
    <Pressable
      disabled={isPlaceholderData}
      onPress={() => openOrder(order.id)}
      accessibilityRole="button"
      accessibilityLabel={order.orderNumber}
      className="rounded py-2 active:opacity-70 web:hover:opacity-70"
    >
      <Text className="text-sm font-semibold text-foreground">{order.orderNumber}</Text>
    </Pressable>
  );
  return (
    <Screen title={t('orders.title')}>
      <ResourceList
        testID="merchant-orders-list"
        busy={isFetching}
        toolbar={
          <View className="flex-row">
            <StatusFilter
              value={status}
              options={options}
              onChange={(next) => {
                setStatus(next);
                setPage(1);
              }}
            />
          </View>
        }
        footer={
          data && !isError ? (
            <ListPagination
              page={data.pagination.page}
              pages={data.pagination.pages}
              busy={isFetching}
              onPage={setPage}
            />
          ) : null
        }
      >
        {isPending || isError || !orders.length ? (
          <ResourceState
            loading={isPending}
            error={isError}
            errorTitle={t('orders.loadFailed')}
            filtered={status !== 'all'}
            emptyTitle={t('orders.empty.title')}
            emptyBody={t('orders.empty.body')}
            onRetry={() => {
              void refetch();
            }}
            onClear={() => {
              setStatus('all');
              setPage(1);
            }}
          />
        ) : width >= 768 ? (
          <Table accessibilityLabel={t('orders.title')} size="sm" minWidth={700}>
            <TableHeader>
              <TableColumn width={110}>
                <Text className="text-xs font-semibold text-muted-foreground">
                  {t('orders.detail.title')}
                </Text>
              </TableColumn>
              <TableColumn flex={1.2}>
                <Text className="text-xs font-semibold text-muted-foreground">
                  {t('resourceList.date')}
                </Text>
              </TableColumn>
              <TableColumn flex={1.5}>
                <Text className="text-xs font-semibold text-muted-foreground">
                  {t('resourceList.customer')}
                </Text>
              </TableColumn>
              <TableColumn width={140}>
                <Text className="text-xs font-semibold text-muted-foreground">
                  {t('common.status')}
                </Text>
              </TableColumn>
              <TableColumn width={65} align="end">
                <Text className="text-xs font-semibold text-muted-foreground">
                  {t('orders.detail.items')}
                </Text>
              </TableColumn>
              <TableColumn width={120} align="end">
                <Text className="text-xs font-semibold text-muted-foreground">
                  {t('orders.totals.total')}
                </Text>
              </TableColumn>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id} testID="merchant-order-row">
                  <TableCell>{orderLink(order)}</TableCell>
                  <TableCell>
                    <Text className="text-xs text-muted-foreground">
                      {formatDate(order.createdAt, locale) ?? t('common.unknown')}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Text className="text-sm text-foreground" numberOfLines={2}>
                      {order.buyer.displayLabel}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <OrderStatusBadge status={order.status} />
                  </TableCell>
                  <TableCell>
                    <Text className="text-sm text-foreground">{order.itemCount}</Text>
                  </TableCell>
                  <TableCell>
                    <PriceDisplay price={order.grandTotal.shop} primaryClassName="text-sm" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <View>
            {orders.map((order) => (
              <View
                key={order.id}
                testID="merchant-order-row"
                className="gap-2 border-b border-border p-4"
              >
                <View className="flex-row items-center justify-between gap-3">
                  {orderLink(order)}
                  <PriceDisplay
                    price={order.grandTotal.shop}
                    primaryClassName="text-sm font-semibold"
                  />
                </View>
                <Text className="text-sm text-foreground" numberOfLines={2}>
                  {order.buyer.displayLabel}
                </Text>
                <View className="flex-row flex-wrap items-center justify-between gap-2">
                  <OrderStatusBadge status={order.status} />
                  {formatDate(order.createdAt, locale) ? (
                    <Text className="text-xs text-muted-foreground">
                      {t('orders.row.itemsPlacedOn', {
                        count: order.itemCount,
                        date: formatDate(order.createdAt, locale),
                      })}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        )}
      </ResourceList>
    </Screen>
  );
}
