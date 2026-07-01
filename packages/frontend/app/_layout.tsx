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
import { Toaster } from '@/components/sonner';
import { KeyboardProvider } from '@/lib/keyboard';
import { useColorScheme } from '@mercaria/ui';
import { AppFxProvider } from '@/lib/fx';
import { setTokenGetter } from '@/lib/api/client';
import { OXY_CLIENT_ID } from '@/lib/config';
import { BLOOM_THEME_PERSIST_KEY, BLOOM_THEME_STORAGE } from '@/lib/themePersistence';
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
          {/* Editor presented as a transparent modal ABOVE the (app) drawer so
              the masonry grid + sidebar stay mounted and visible behind it —
              Keep-style overlay, not a page change. */}
          <Stack.Screen
            name="n/[id]"
            options={{
              presentation: "transparentModal",
              animation: "fade",
              headerShown: false,
              // Override the global opaque contentStyle so the modal screen's
              // content container does NOT paint a solid background. Without this
              // the inherited `colors.background` covers the (app) grid → solid
              // black behind the dialog on web. The native-stack web renderer
              // already (a) sets the transparentModal screen's own wrapper to
              // transparent and (b) keeps the previous (app) screen mounted and
              // displayed because the next screen is a transparent presentation,
              // so the grid + sidebar stay visible behind the dim backdrop.
              contentStyle: { backgroundColor: "transparent" },
            }}
          />
        </Stack>
      </KeyboardProvider>
      <Toaster />
    </AuthSetup>
  );
}

function RootLayout() {
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
      <BloomThemeProvider
        defaultMode="system"
        defaultColorPreset="blue"
        persistKey={BLOOM_THEME_PERSIST_KEY}
        storage={BLOOM_THEME_STORAGE}
        fonts={false}
        onFontsLoading={<AppSplashScreen />}
      >
        {/* Mercaria is a marketplace: anonymous visitors must be able to browse
            listings/shops/search without being force-redirected to auth. Sign-in
            is only required to buy or sell. The SDK cold boot now owns this: a
            truly first-time anonymous visitor is never force-bounced to `/sso`,
            while a returning visitor whose local session lapsed still earns one
            terminal establish bounce so a central-only cross-domain session is
            silently restored. No provider flag is needed. */}
        <OxyProvider
          baseURL={OXY_API_URL}
          clientId={OXY_CLIENT_ID}
          authRedirectUri={Platform.OS !== 'web' ? AUTH_REDIRECT_URI : undefined}
        >
          <AppContent />
        </OxyProvider>
      </BloomThemeProvider>
    </AppErrorBoundary>
  );
}

export default RootLayout;
