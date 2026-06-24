import { Slot, Stack } from "expo-router";
import { View, Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AppErrorBoundary } from "@/components/error-boundary";
import { NavRail } from "@/components/shell/NavRail";
import { BottomTabBar } from "@/components/shell/BottomTabBar";
import { useNotificationSetup } from "@/lib/hooks/use-notification-setup";

const SCREEN_OPTIONS = { headerShown: false } as const;

const GESTURE_ROOT_STYLE = { flex: 1 } as const;

export default function AppLayout() {
  // Push notification registration + tap handling.
  useNotificationSetup();

  // NATIVE: a single full-bleed column with the floating-pill bottom bar as an
  // absolute overlay above it (the rail is web-only). No width measuring —
  // native is always the "mobile" tree. `<Stack>` gives real push/pop screen
  // transitions on native.
  if (Platform.OS !== "web") {
    return (
      <AppErrorBoundary>
        <GestureHandlerRootView style={GESTURE_ROOT_STYLE}>
          {/* The floating pill is an absolute overlay (NOT in flex flow), so the
              content column fills the screen and the bar floats above it. Each
              screen owns its own bottom padding to clear the pill. */}
          <View className="flex-1 bg-background">
            <Stack screenOptions={SCREEN_OPTIONS}>
              <Stack.Screen name="index" />
              <Stack.Screen name="stores/[handle]" />
              <Stack.Screen name="products/[id]" />
              <Stack.Screen name="cart" />
              <Stack.Screen name="settings/index" />
              <Stack.Screen name="settings/general" />
              <Stack.Screen name="settings/feedback" />
              <Stack.Screen name="notifications" />
              <Stack.Screen name="forgot-password" />
              <Stack.Screen name="reset-password" />
            </Stack>
            <BottomTabBar />
          </View>
        </GestureHandlerRootView>
      </AppErrorBoundary>
    );
  }

  // WEB: ONE responsive tree — the rail↔bottom-bar swap is done purely with
  // NativeWind `md:` breakpoints (768px), NOT JS width measurement.
  //  - Shell: block + full-bleed below md; a 2-col grid [76px rail | 1fr] at md+.
  //  - Rail: hidden below md, sticky full-height at md+.
  //  - Content: gutter inset at md+ (`md:p-2 md:pl-0`). Floating-pill clearance
  //    below md lives INSIDE each page's themed ScreenShell surface (its
  //    `pb-24`), NOT on this wrapper — so the brand surface reaches the bottom
  //    edge instead of leaving an un-themed strip under the pill.
  //  - Bottom bar: floating pill visible below md, hidden at md+.
  // The home screen's rounded panel + bleed mask are themselves gated to desktop.
  return (
    <AppErrorBoundary>
      <GestureHandlerRootView style={GESTURE_ROOT_STYLE}>
        <View className="min-h-screen bg-background md:grid md:grid-cols-[4.75rem_1fr]">
          <View className="sticky top-0 z-40 hidden h-screen md:flex md:row-start-1 md:col-start-1">
            <NavRail />
          </View>
          <View className="min-w-0 md:col-start-2 md:row-start-1 md:p-2 md:pl-0">
            {/* `<Slot>` (no absolute scene wrapper) so the route flows in normal
                document flow and the body scrolls / the sticky shell works.
                Floating-pill clearance below md comes from the page's themed
                ScreenShell `pb-24` (96px > 12px gap + 56px pill), keeping the
                clearance inside the brand surface — no un-themed strip. */}
            <Slot />
          </View>
          {/* Floating pill overlay below md. The wrapper is a fixed,
              full-width positioning context pinned to the viewport bottom; the
              <BottomTabBar/> inside is itself `position:absolute` and floats
              16px in from each edge, 12px above the bottom. Hidden at md+ where
              the NavRail takes over. */}
          <View className="fixed inset-x-0 bottom-0 z-[60] md:hidden">
            <BottomTabBar />
          </View>
        </View>
      </GestureHandlerRootView>
    </AppErrorBoundary>
  );
}
