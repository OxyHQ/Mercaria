import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { Redirect, Slot, Stack, useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import { useSupervision } from '@oxy.so/services/ui/client';
import { AppShell, AppShellPanel } from '@oxy.so/bloom/app-shell';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Logo } from '@/components/Logo';
import { useTranslation } from '@/lib/i18n';

/** Advisory navigation only: the server validates every operation with Oxy. Unknown never renders the ordinary feed. */
export function SupervisedStorefrontGate({ children }: { children: ReactNode }) {
  const { user, isAuthenticated, isAuthResolved, showBottomSheet } = useOxy();
  const supervision = useSupervision();
  const cache = useQueryClient();
  const pathname = usePathname();
  const params = useLocalSearchParams<{ checkoutGroupId?: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const supervised =
    supervision.data?.self !== null &&
    supervision.data?.self !== undefined &&
    supervision.data.self.status !== 'ended';
  const boundary = `${user?.id ?? ''}:${supervised ? 'supervised' : 'ordinary'}`;
  const previousBoundary = useRef<string | undefined>(undefined);
  const [readyBoundary, setReadyBoundary] = useState<string>();
  useEffect(() => {
    if (
      !isAuthResolved ||
      (isAuthenticated && !user) ||
      (isAuthenticated && user?.kind === 'personal' && !supervision.data)
    )
      return;
    let live = true;
    void (async () => {
      if (
        previousBoundary.current !== boundary &&
        (previousBoundary.current !== undefined || supervised)
      ) {
        // Finish cancellation before clearing so an old in-flight request cannot
        // repopulate a different account or policy boundary.
        await cache.cancelQueries({ predicate: (query) => query.queryKey[0] !== 'oxy' });
        cache.removeQueries({ predicate: (query) => query.queryKey[0] !== 'oxy' });
      }
      if (live) {
        previousBoundary.current = boundary;
        setReadyBoundary(boundary);
      }
    })();
    return () => {
      live = false;
    };
  }, [boundary, cache, isAuthResolved, isAuthenticated, supervision.data, supervised, user]);
  if (
    !isAuthResolved ||
    (isAuthenticated && !user) ||
    (isAuthenticated && user?.kind === 'personal' && !supervision.data && !supervision.isError)
  ) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Loading accessibilityLabel={t('common.loading')} />
      </View>
    );
  }
  if (isAuthenticated && user?.kind === 'personal' && supervision.isError) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-background p-6">
        <EmptyState
          title={t('supervisedShopping.unavailable')}
          description={t('supervisedShopping.unavailableBody')}
        />
        <Button onPress={() => supervision.refetch()}>{t('common.tryAgain')}</Button>
      </View>
    );
  }
  if (readyBoundary !== boundary)
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Loading accessibilityLabel={t('common.loading')} />
      </View>
    );
  if (!supervised || !isAuthenticated) return <>{children}</>;
  if (pathname === '/checkout/return' && typeof params.checkoutGroupId === 'string') {
    return (
      <Redirect
        href={{
          pathname: '/supervised-shopping/checkout',
          params: { checkoutGroupId: params.checkoutGroupId },
        }}
      />
    );
  }
  if (pathname !== '/supervised-shopping' && pathname !== '/supervised-shopping/checkout') {
    return <Redirect href="/supervised-shopping" />;
  }
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppShell
        variant="feed"
        panels
        scroll={Platform.OS === 'web' ? 'document' : 'fixed'}
        header={
          <View className="flex-row items-center justify-between gap-3 px-4 py-3">
            <Button
              appearance="plain"
              tone="neutral"
              onPress={() => router.replace('/supervised-shopping')}
              accessibilityLabel={t('supervisedShopping.title')}
            >
              <Logo size={24} />
            </Button>
            <Button
              appearance="plain"
              tone="neutral"
              onPress={() => showBottomSheet?.('Supervision')}
            >
              {t('supervisedShopping.account')}
            </Button>
          </View>
        }
      >
        <AppShellPanel>
          {Platform.OS === 'web' ? <Slot /> : <Stack screenOptions={{ headerShown: false }} />}
        </AppShellPanel>
      </AppShell>
    </GestureHandlerRootView>
  );
}
