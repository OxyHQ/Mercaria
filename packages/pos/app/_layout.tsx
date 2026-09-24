import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useFonts } from "expo-font";
import { Slot, Stack } from "expo-router";
import {
  preventNativeSplashAutoHide,
  useHideNativeSplashWhenReady,
} from "@oxy.so/expo-splash";
import { useCallback, useEffect } from "react";
import { OxyProvider, useOxy } from "@oxy.so/services";
import { BloomProvider } from "@oxy.so/bloom/provider";
import { expoRouterScrollAdapter } from "@oxy.so/bloom/scroll/expo-router";
import { ImageResolverProvider } from "@oxy.so/bloom/image-resolver";
import * as Linking from "expo-linking";
import { Platform } from "react-native";

import { AppErrorBoundary } from "@/components/error-boundary";
import AppSplashScreen from "@/components/AppSplashScreen";
import { KeyboardProvider } from "@/lib/keyboard";
import { SharedUiTranslationProvider, useColorScheme } from "@mercaria/ui";
import { AppFxProvider } from "@/lib/fx";
import { setTokenGetter } from "@/lib/api/client";
import { OXY_CLIENT_ID, OXY_API_URL } from "@/lib/config";
import { BLOOM_THEME_PERSIST_KEY, BLOOM_THEME_STORAGE } from "@/lib/themePersistence";
import "react-native-reanimated";
import "../global.css";
// Imported at the ROOT for its side effect as much as for the binding: building
// the i18n store applies the resolved locale (device, then the persisted
// preference) before the first paint, so no screen renders a frame of English on
// a device set to another language.
import { useTranslation } from "@/lib/i18n";

export { ErrorBoundary } from "expo-router";

export const unstable_settings = {
  initialRouteName: "(app)",
};

// Hold the native OS splash (Oxy family "Instagram, from Meta" pattern): Mercaria's
// own logo centered on the dark brand background with the Oxy symbol pinned to the
// bottom — configured by `@oxy.so/expo-splash` in `app.config.js`. The custom
// `AppSplashScreen` React overlay is gated to web only. No-op on web (the helper
// guards `Platform.OS === 'web'`).
preventNativeSplashAutoHide();

const AUTH_REDIRECT_URI = Linking.createURL("/");

function AuthSetup({ children }: { children: React.ReactNode }) {
  const { oxyServices } = useOxy();

  setTokenGetter(() => oxyServices.getAccessToken() || null);

  // Resolve Oxy file IDs to thumbnail download URLs for any Bloom component
  // that reads useImageResolver() (e.g. Avatar with a raw file id `source`).
  const resolveImageSource = useCallback(
    (fileId: string): string | undefined => {
      const url = oxyServices.getFileDownloadUrl(fileId, "thumb");
      return url && url.startsWith("http") ? url : undefined;
    },
    [oxyServices],
  );

  return (
    <ImageResolverProvider value={resolveImageSource}>
      <AppFxProvider>{children}</AppFxProvider>
    </ImageResolverProvider>
  );
}

function AppContent() {
  const { colors } = useColorScheme();

  return (
    <AuthSetup>
      <KeyboardProvider>
        {/* WEB: <Slot/>, so the matched route stays in normal document flow and
            Bloom's AppShell can scroll the DOCUMENT (sticky navigation, scroll
            restoration). A web Stack wraps every scene in a viewport-clamped
            card, which is a scroll container between the root and the shell. */}
        {Platform.OS === "web" ? (
          <Slot />
        ) : (
          <Stack
            screenOptions={{
              contentStyle: { backgroundColor: colors.background },
              headerShown: false,
            }}
          >
            <Stack.Screen name="(app)" options={{ headerShown: false }} />
          </Stack>
        )}
      </KeyboardProvider>
    </AuthSetup>
  );
}

function RootLayout() {
  // `@mercaria/ui`'s own reader-facing copy (#437) resolves through THIS app's
  // `t`, so a shared sentence and the screen around it are always in one
  // language. Read here rather than inside a nested component so the provider
  // below sits above every branch that renders anything.
  const { t, locale } = useTranslation();
  const [loaded, error] = useFonts({
    SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
    Inter: require("../assets/fonts/Inter-VariableFont_opsz,wght.ttf"),
    "Inter-Italic": require("../assets/fonts/Inter-Italic-VariableFont_opsz,wght.ttf"),
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  // NATIVE readiness flips on font-load ALONE — never on the custom splash fade
  // (which only exists on web). The shared hook hides the held OS splash once
  // ready; it is a no-op on web (the OS splash was never held there). Gating
  // native readiness on the web-only fade would hang the OS splash forever.
  useHideNativeSplashWhenReady(loaded);

  // On native the held OS splash covers this null render until fonts load; on web
  // the custom <AppSplashScreen> below (via BloomProvider `onFontsLoading`)
  // owns the loading visual.
  if (!loaded) return null;

  return (
    <AppErrorBoundary>
      <SharedUiTranslationProvider t={t} locale={locale}>
        {/* The single Bloom root: theme, haptics, scroll restoration (keyed by
            expo-router through the module-level adapter) and the bottom-edge
            registry the app shell's bar publishes its height through. */}
        <BloomProvider
          scrollAdapter={expoRouterScrollAdapter}
          defaultMode="system"
          defaultColorPreset="blue"
          persistKey={BLOOM_THEME_PERSIST_KEY}
          storage={BLOOM_THEME_STORAGE}
          fonts={false}
          onFontsLoading={Platform.OS === "web" ? <AppSplashScreen /> : null}
        >
          {/* POS requires login — no anonymous surface. The SDK device-first cold
              boot restores sessions from persisted device credentials; the auth
              gate renders sign-in when unauthenticated. */}
          <OxyProvider
            baseURL={OXY_API_URL}
            clientId={OXY_CLIENT_ID}
            authRedirectUri={Platform.OS !== "web" ? AUTH_REDIRECT_URI : undefined}
          >
            <AppContent />
          </OxyProvider>
        </BloomProvider>
      </SharedUiTranslationProvider>
    </AppErrorBoundary>
  );
}

export default RootLayout;
