import { Slot, Stack } from "expo-router";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AppShell } from "@mercaria/ui";
import { AppErrorBoundary } from "@/components/error-boundary";
import { Sidebar } from "@/components/shell/Sidebar";
import { BottomTabBar } from "@/components/shell/BottomTabBar";
import { useNotificationSetup } from "@/lib/hooks/use-notification-setup";

const SCREEN_OPTIONS = { headerShown: false } as const;

const GESTURE_ROOT_STYLE = { flex: 1 } as const;

export default function AppLayout() {
  // Push notification registration + tap handling.
  useNotificationSetup();

  // The shared `AppShell` owns the responsive layout (sticky collapsible rail on
  // web, full-bleed + floating bottom bar on native/mobile). This layout only
  // supplies the app-specific slots: the routed content element (a `<Stack>` for
  // native push/pop transitions, a `<Slot>` for the web document-scroll flow),
  // the storefront `Sidebar`, and the `BottomTabBar`.
  const routed =
    Platform.OS === "web" ? (
      <Slot />
    ) : (
      <Stack screenOptions={SCREEN_OPTIONS}>
        <Stack.Screen name="index" />
        <Stack.Screen name="stores/[handle]" />
        <Stack.Screen name="products/[id]" />
        <Stack.Screen name="cart" />
        <Stack.Screen name="checkout" />
        <Stack.Screen name="orders/index" />
        <Stack.Screen name="orders/[id]" />
        <Stack.Screen name="settings/index" />
        <Stack.Screen name="settings/general" />
        <Stack.Screen name="settings/addresses" />
        <Stack.Screen name="settings/feedback" />
        <Stack.Screen name="notifications" />
        <Stack.Screen name="forgot-password" />
        <Stack.Screen name="reset-password" />
      </Stack>
    );

  return (
    <AppErrorBoundary>
      <GestureHandlerRootView style={GESTURE_ROOT_STYLE}>
        <AppShell sidebar={<Sidebar />} bottomBar={<BottomTabBar />}>
          {routed}
        </AppShell>
      </GestureHandlerRootView>
    </AppErrorBoundary>
  );
}
