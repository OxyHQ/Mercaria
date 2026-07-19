import { Slot, Stack } from "expo-router";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AppShell } from "@mercaria/ui";
import { AppErrorBoundary } from "@/components/error-boundary";
import { AuthGate } from "@/components/AuthGate";
import { Sidebar } from "@/components/shell/Sidebar";
import { BottomTabBar } from "@/components/shell/BottomTabBar";

const SCREEN_OPTIONS = { headerShown: false } as const;

const GESTURE_ROOT_STYLE = { flex: 1 } as const;

export default function AppLayout() {
  // The shared `AppShell` owns the responsive layout (sticky collapsible rail on
  // web, full-bleed + floating bottom bar on native/mobile). This layout only
  // supplies the app-specific slots: the routed content element (a `<Stack>` for
  // native push/pop transitions, a `<Slot>` for the web document-scroll flow),
  // the dashboard `Sidebar`, and the `BottomTabBar`.
  const routed =
    Platform.OS === "web" ? <Slot /> : <Stack screenOptions={SCREEN_OPTIONS} />;

  return (
    <AppErrorBoundary>
      <GestureHandlerRootView style={GESTURE_ROOT_STYLE}>
        <AuthGate>
          <AppShell sidebar={<Sidebar />} bottomBar={<BottomTabBar />}>
            {routed}
          </AppShell>
        </AuthGate>
      </GestureHandlerRootView>
    </AppErrorBoundary>
  );
}
