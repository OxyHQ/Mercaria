import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import {
  preventNativeSplashAutoHide,
  useHideNativeSplashWhenReady,
} from "@oxyhq/expo-splash";
import { useCallback, useEffect } from "react";
import { OxyProvider, useOxy } from "@oxyhq/services";
import { BloomThemeProvider } from "@oxyhq/bloom/theme";
import { ImageResolverProvider } from "@oxyhq/bloom/image-resolver";
import * as Linking from "expo-linking";
import { Platform } from "react-native";

import { AppErrorBoundary } from "@/components/error-boundary";
import AppSplashScreen from "@/components/AppSplashScreen";
import { Toaster } from "@/components/sonner";
import { KeyboardProvider } from "@/lib/keyboard";
import { useColorScheme } from "@mercaria/ui";
import { AppFxProvider } from "@/lib/fx";
import { setTokenGetter } from "@/lib/api/client";
import { OXY_CLIENT_ID, OXY_API_URL } from "@/lib/config";
import { BLOOM_THEME_PERSIST_KEY, BLOOM_THEME_STORAGE } from "@/lib/themePersistence";
import "react-native-reanimated";
import "../global.css";

export { ErrorBoundary } from "expo-router";

export const unstable_settings = {
  initialRouteName: "(app)",
};

// Hold the native OS splash (Oxy family "Instagram, from Meta" pattern): Mercaria's
// own logo centered on the dark brand background with the Oxy symbol pinned to the
// bottom — configured by `@oxyhq/expo-splash` in `app.config.js`. The custom
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
        <Stack
          screenOptions={{
            contentStyle: { backgroundColor: colors.background },
            headerShown: false,
          }}
        >
          <Stack.Screen name="(app)" options={{ headerShown: false }} />
        </Stack>
      </KeyboardProvider>
      <Toaster />
    </AuthSetup>
  );
}

function RootLayout() {
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
  // the custom <AppSplashScreen> below (via BloomThemeProvider `onFontsLoading`)
  // owns the loading visual.
  if (!loaded) return null;

  return (
    <AppErrorBoundary>
      <BloomThemeProvider
        defaultMode="system"
        defaultColorPreset="blue"
        persistKey={BLOOM_THEME_PERSIST_KEY}
        storage={BLOOM_THEME_STORAGE}
        fonts={false}
        onFontsLoading={Platform.OS === "web" ? <AppSplashScreen /> : null}
      >
        {/* The dashboard REQUIRES login — there is no anonymous browse path, so
            it does NOT set `disableAutoSso`. The SDK cold boot owns callback
            consume, FedCM/silent restore, stored-session restore and the SSO
            bounce so a returning admin is restored (or bounced to auth) for
            free; the auth gate in `(app)/_layout.tsx` renders the sign-in
            screen for an unauthenticated visitor. */}
        <OxyProvider
          baseURL={OXY_API_URL}
          clientId={OXY_CLIENT_ID}
          authRedirectUri={Platform.OS !== "web" ? AUTH_REDIRECT_URI : undefined}
        >
          <AppContent />
        </OxyProvider>
      </BloomThemeProvider>
    </AppErrorBoundary>
  );
}

export default RootLayout;
