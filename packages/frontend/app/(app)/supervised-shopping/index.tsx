import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Text, useFormatters } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { useTranslation } from '@/lib/i18n';
import {
  addSupervisedItem,
  removeSupervisedItem,
  supervisedCart,
  supervisedCatalog,
} from '@/lib/api/supervised-shopping';

export default function SupervisedShoppingScreen() {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const { user, isAuthenticated, openAccountDialog } = useOxy();
  const router = useRouter();
  const cache = useQueryClient();
  const [cursor, setCursor] = useState<string>();
  const cartKey = ['supervised-shopping', user?.id, 'cart'] as const;
  const catalog = useQuery({
    queryKey: ['supervised-shopping', user?.id, 'catalog', cursor],
    queryFn: () => supervisedCatalog(cursor),
    enabled: isAuthenticated,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const cart = useQuery({
    queryKey: cartKey,
    queryFn: supervisedCart,
    enabled: isAuthenticated,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const change = useMutation({
    mutationFn: (input: { listingId: string; variantId: string; remove?: boolean }) =>
      input.remove
        ? removeSupervisedItem(input.variantId)
        : addSupervisedItem({
            listingId: input.listingId,
            variantId: input.variantId,
            quantity: 1,
          }),
    onSuccess: (value) => cache.setQueryData(cartKey, value),
    onError: () => {
      void cart.refetch();
      void catalog.refetch();
    },
  });
  return (
    <ScreenShell hideComposer>
      <View className="mx-auto w-full max-w-3xl gap-6 px-4 py-6 md:px-8">
        <View className="gap-2">
          <Text accessibilityRole="header" className="text-2xl font-bold">
            {t('supervisedShopping.title')}
          </Text>
          <Text className="text-muted-foreground">{t('supervisedShopping.intro')}</Text>
        </View>
        {!isAuthenticated ? (
          <Button onPress={() => openAccountDialog()}>{t('cart.signIn')}</Button>
        ) : (
          <>
            {catalog.isPending ? (
              <Loading accessibilityLabel={t('common.loading')} />
            ) : catalog.isError ? (
              <>
                <EmptyState
                  title={t('supervisedShopping.unavailable')}
                  description={t('supervisedShopping.unavailableBody')}
                />
                <Button tone="neutral" onPress={() => catalog.refetch()}>
                  {t('common.tryAgain')}
                </Button>
              </>
            ) : (
              <View className="gap-4">
                {catalog.data.items.length === 0 ? (
                  <EmptyState
                    title={t('supervisedShopping.empty')}
                    description={t('supervisedShopping.emptyBody')}
                  />
                ) : null}
                {catalog.data.items.map((listing) => (
                  <View key={listing.id} className="gap-3 border-b border-border pb-4">
                    <Text className="text-lg font-semibold">{listing.title}</Text>
                    {listing.variants.map((variant) => (
                      <View key={variant.id} className="flex-row items-center gap-4">
                        <View className="flex-1 gap-1">
                          <Text>{variant.title}</Text>
                          {variant.options.map((option) => (
                            <Text key={option.name} className="text-sm text-muted-foreground">
                              {option.name}: {option.value}
                            </Text>
                          ))}
                          {variant.price ? <Text>{formatMoney(variant.price)}</Text> : null}
                        </View>
                        <Button
                          tone="neutral"
                          appearance="outline"
                          disabled={change.isPending || !variant.price}
                          onPress={() =>
                            change.mutate({ listingId: listing.id, variantId: variant.id })
                          }
                        >
                          {t('supervisedShopping.add')}
                        </Button>
                      </View>
                    ))}
                  </View>
                ))}
                {catalog.data.nextCursor ? (
                  <Button
                    tone="neutral"
                    appearance="plain"
                    onPress={() => setCursor(catalog.data.nextCursor ?? undefined)}
                  >
                    {t('common.pagination.next')}
                  </Button>
                ) : null}
              </View>
            )}
            <View className="gap-3 border-t border-border pt-5">
              <Text accessibilityRole="header" className="text-xl font-semibold">
                {t('cart.title')}
              </Text>
              {cart.isPending ? (
                <Loading accessibilityLabel={t('common.loading')} />
              ) : cart.isError ? (
                <EmptyState title={t('supervisedShopping.unavailable')} />
              ) : (
                <>
                  {cart.data.items.length === 0 ? (
                    <Text className="text-muted-foreground">{t('cart.empty.title')}</Text>
                  ) : null}
                  {cart.data.items.map((item) => (
                    <View key={item.variantId} className="flex-row items-center gap-3">
                      <View className="flex-1 gap-1">
                        <Text>
                          {item.selection?.title ?? t('supervisedShopping.itemUnavailable')}
                        </Text>
                        {item.selection ? (
                          <>
                            <Text className="text-sm text-muted-foreground">
                              {item.selection.variantTitle} · {item.quantity}
                            </Text>
                            <Text>{formatMoney(item.selection.lineTotal)}</Text>
                          </>
                        ) : null}
                      </View>
                      <Button
                        tone="neutral"
                        appearance="plain"
                        disabled={change.isPending}
                        onPress={() =>
                          change.mutate({
                            listingId: item.listingId,
                            variantId: item.variantId,
                            remove: true,
                          })
                        }
                      >
                        {t('supervisedShopping.remove')}
                      </Button>
                    </View>
                  ))}
                  {cart.data.subtotal ? (
                    <Text className="font-semibold">
                      {t('cart.group.subtotal')}: {formatMoney(cart.data.subtotal)}
                    </Text>
                  ) : null}
                  <Button
                    disabled={!cart.data.checkoutAvailable || change.isPending}
                    onPress={() => router.push('/supervised-shopping/checkout')}
                  >
                    {t('supervisedShopping.reviewPurchase')}
                  </Button>
                </>
              )}
              {change.isError ? (
                <Text accessibilityRole="alert">{t('supervisedShopping.changeError')}</Text>
              ) : null}
            </View>
          </>
        )}
      </View>
    </ScreenShell>
  );
}
