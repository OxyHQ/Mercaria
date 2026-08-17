import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect } from 'react';
import { OxyProvider, useOxy } from '@oxyhq/services';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';
import { ImageResolverProvider } from '@oxyhq/bloom/image-resolver';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

import { AppErrorBoundary } from '@/components/error-boundary';
import AppSplashScreen from '@/components/AppSplashScreen';
import { KeyboardProvider } from '@/lib/keyboard';
import { SharedUiTranslationProvider, useColorScheme } from '@mercaria/ui';
import { AppFxProvider } from '@/lib/fx';
import { setTokenGetter } from '@/lib/api/client';
import { useGuestCartMerge } from '@/lib/hooks/use-cart';
import { OXY_CLIENT_ID } from '@/lib/config';
import { BLOOM_THEME_PERSIST_KEY, BLOOM_THEME_STORAGE } from '@/lib/themePersistence';
import { useTranslation } from '@/lib/i18n';
import 'react-native-reanimated';
import '../global.css';
import '@/lib/i18n';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(app)',
};

SplashScreen.preventAutoHideAsync();

const OXY_API_URL = process.env.EXPO_PUBLIC_OXY_API_URL || 'https://api.oxy.so';
const AUTH_REDIRECT_URI = Linking.createURL('/');

function AuthSetup({ children }: { children: React.ReactNode }) {
  const { oxyServices } = useOxy();

  setTokenGetter(() => oxyServices.getAccessToken() || null);

  // The guest→Oxy cart merge (#104). Mounted once, at the top, because the
  // trigger is signing IN and that can happen on any screen. It is a React
  // Query query rather than an effect on purpose: `enabled` flipping true runs
  // it exactly once, deduplicates, retries a failure and never re-runs — which
  // is the scheduling an effect would otherwise have to reimplement. Calling it
  // twice would converge anyway, server-side.
  useGuestCartMerge();

  // Resolve Oxy file IDs to thumbnail download URLs for any Bloom component
  // that reads useImageResolver() (e.g. Avatar with a raw file id `source`).
  const resolveImageSource = useCallback(
    (fileId: string): string | undefined => {
      const url = oxyServices.getFileDownloadUrl(fileId, 'thumb');
      return url && url.startsWith('http') ? url : undefined;
    },
    [oxyServices]
  );

  return (
    <ImageResolverProvider value={resolveImageSource}>
      {/* FX provider sits inside Oxy/Query (so the /rates query + bearer token
          work) and supplies display-side dual-currency state to PriceDisplay. */}
      <AppFxProvider>{children}</AppFxProvider>
    </ImageResolverProvider>
  );
}

function AppContent() {
  const { colors } = useColorScheme();

  return (
    <AuthSetup>
      <KeyboardProvider>
        <Stack
          screenOptions={{
            contentStyle: {
              backgroundColor: colors.background,
            },
          }}
        >
          <Stack.Screen name="(app)" options={{ headerShown: false }} />
        </Stack>
      </KeyboardProvider>
    </AuthSetup>
  );
}

function RootLayout() {
  // `@mercaria/ui`'s own reader-facing copy (#437) resolves through THIS app's
  // `t`, so a shared sentence and the screen around it are always in one
  // language — and, here, in one layout DIRECTION: the storefront is the app
  // that ships `ar` and mirrors for it (#397).
  const { t } = useTranslation();
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    Inter: require('../assets/fonts/Inter-VariableFont_opsz,wght.ttf'),
    'Inter-Italic': require('../assets/fonts/Inter-Italic-VariableFont_opsz,wght.ttf'),
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);

  if (!loaded) return null;

  return (
    <AppErrorBoundary>
      <SharedUiTranslationProvider t={t}>
        <BloomThemeProvider
          defaultMode="system"
          defaultColorPreset="blue"
          persistKey={BLOOM_THEME_PERSIST_KEY}
          storage={BLOOM_THEME_STORAGE}
          fonts={false}
          onFontsLoading={<AppSplashScreen />}
        >
          {/* Mercaria is a marketplace: anonymous visitors browse listings without
              being redirected to sign in. The SDK device-first cold boot restores
              returning sessions from persisted device credentials; sign-in is only
              required to buy or sell. */}
          <OxyProvider
            baseURL={OXY_API_URL}
            clientId={OXY_CLIENT_ID}
            authRedirectUri={Platform.OS !== 'web' ? AUTH_REDIRECT_URI : undefined}
          >
            <AppContent />
          </OxyProvider>
        </BloomThemeProvider>
      </SharedUiTranslationProvider>
    </AppErrorBoundary>
  );
}

export default RootLayout;
