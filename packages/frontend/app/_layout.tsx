import { isOxyFileId } from '@mercaria/shared-types';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFonts } from 'expo-font';
import { Slot, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect } from 'react';
import { OxyProvider, useAccountColor, useOxy } from '@oxy.so/services/ui/client';
import { useSupervision } from '@oxy.so/services/ui/client';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { OverlayInertBoundary, PortalOutlet, PortalProvider } from '@oxy.so/bloom/portal';
import { expoRouterScrollAdapter } from '@oxy.so/bloom/scroll/expo-router';
import { ImageResolverProvider } from '@oxy.so/bloom/image-resolver';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

import { MercariaAskProvider } from '@/components/alia/MercariaAskProvider';
import { AppErrorBoundary } from '@/components/error-boundary';
import AppSplashScreen from '@/components/AppSplashScreen';
import { StorefrontSettingsProvider } from '@/components/settings/StorefrontSettingsProvider';
import { KeyboardProvider } from '@/lib/keyboard';
import { SharedUiTranslationProvider, useColorScheme } from '@mercaria/ui';
import { AppFxProvider } from '@/lib/fx';
import { setTokenGetter } from '@/lib/api/client';
import { useGuestCartMerge } from '@/lib/hooks/use-cart';
import { useReferralBinding } from '@/lib/hooks/use-referral-binding';
import { OXY_CLIENT_ID } from '@/lib/config';
import {
  BLOOM_DEFAULT_COLOR_PRESET,
  BLOOM_THEME_PERSIST_KEY,
  BLOOM_THEME_STORAGE,
} from '@/lib/themePersistence';
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
  const { oxyServices, user, isAuthenticated } = useOxy();
  const supervision = useSupervision();
  const ordinaryShopping =
    !isAuthenticated ||
    (!!user && user.kind !== 'personal') ||
    (!!supervision.data &&
      (supervision.data.self === null || supervision.data.self.status === 'ended'));

  setTokenGetter(() => oxyServices.session.accessToken || null);

  // The account's colour wears the Bloom theme for every Oxy app; signed out,
  // Bloom's default stays.
  useAccountColor();

  // The guest→Oxy cart merge (#104). Mounted once, at the top, because the
  // trigger is signing IN and that can happen on any screen. It is a React
  // Query query rather than an effect on purpose: `enabled` flipping true runs
  // it exactly once, deduplicates, retries a failure and never re-runs — which
  // is the scheduling an effect would otherwise have to reimplement. Calling it
  // twice would converge anyway, server-side.
  useGuestCartMerge(ordinaryShopping);

  // A followed referral link pays nobody until the click is bound to a subject
  // (#143), and the subject — a sign-in, the first cart write — can appear on
  // any screen. Mounted here for the same reason as the merge above.
  useReferralBinding();

  // Resolve public Oxy file IDs using the rendition requested by Bloom.
  // No rendition means the original; Avatar explicitly requests its thumbnail.
  const resolveImageSource = useCallback(
    (fileId: string, variant?: string): string | undefined => {
      if (!isOxyFileId(fileId)) return undefined;
      const url = oxyServices.assets.publicUrl(fileId, variant);
      return url?.startsWith('http') ? url : undefined;
    },
    [oxyServices],
  );

  return (
    <ImageResolverProvider value={resolveImageSource}>
      {/* FX provider sits inside Oxy/Query (so the /rates query + bearer token
          work) and supplies display-side dual-currency state to PriceDisplay. */}
      <AppFxProvider allowPreference={ordinaryShopping}>{children}</AppFxProvider>
    </ImageResolverProvider>
  );
}

function AppContent() {
  const { colors } = useColorScheme();

  return (
    <KeyboardProvider>
      {/* WEB: <Slot/>, so the matched route stays in normal document flow and
          Bloom's AppShell can scroll the DOCUMENT (sticky navigation, scroll
          restoration). A web Stack wraps every scene in a viewport-clamped
          card, which is a scroll container between the root and the shell. */}
      {Platform.OS === 'web' ? (
        <Slot />
      ) : (
        <Stack
          screenOptions={{
            contentStyle: {
              backgroundColor: colors.background,
            },
          }}
        >
          <Stack.Screen name="(app)" options={{ headerShown: false }} />
        </Stack>
      )}
    </KeyboardProvider>
  );
}

function RootLayout() {
  // `@mercaria/ui`'s own reader-facing copy (#437) resolves through THIS app's
  // `t`, so a shared sentence and the screen around it are always in one
  // language — and, here, in one layout DIRECTION: the storefront is the app
  // that ships `ar` and mirrors for it (#397).
  const { t, locale } = useTranslation();
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
      <SharedUiTranslationProvider t={t} locale={locale}>
        {/* The single Bloom root: theme, haptics, scroll restoration (keyed by
            expo-router through the module-level adapter) and the bottom-edge
            registry the app shell's bar publishes its height through. */}
        <BloomProvider
          locale={locale}
          scrollAdapter={expoRouterScrollAdapter}
          defaultMode="system"
          defaultColorPreset={BLOOM_DEFAULT_COLOR_PRESET}
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
            <AuthSetup>
              {/* Settings is Bloom's `SettingsModal`, which native draws
                  through the portal. The OUTLET sits inside the settings
                  provider and every data provider (`AuthSetup`): a portalled
                  page reads its context from where the outlet is, and outside
                  the inert boundary, which disables the app under a modal. */}
              <PortalProvider>
                <StorefrontSettingsProvider>
                  <OverlayInertBoundary testID="app-content-boundary">
                    {/* Alia's one sheet, above every route: a route unmounts
                        when it is left, and the conversation must not. */}
                    <MercariaAskProvider>
                      <AppContent />
                    </MercariaAskProvider>
                  </OverlayInertBoundary>
                  <PortalOutlet />
                </StorefrontSettingsProvider>
              </PortalProvider>
            </AuthSetup>
          </OxyProvider>
        </BloomProvider>
      </SharedUiTranslationProvider>
    </AppErrorBoundary>
  );
}

export default RootLayout;
