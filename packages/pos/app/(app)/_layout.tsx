import { Slot, Stack } from "expo-router";
import { View, Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AppErrorBoundary } from "@/components/error-boundary";
import { AuthGate } from "@/components/AuthGate";
import { NavRail } from "@/components/shell/NavRail";
import { BottomTabBar } from "@/components/shell/BottomTabBar";

const SCREEN_OPTIONS = { headerShown: false } as const;

const GESTURE_ROOT_STYLE = { flex: 1 } as const;

export default function AppLayout() {
  // NATIVE: a single full-bleed column with the floating-pill bottom bar as an
  // absolute overlay above it (the rail is web-only). `<Stack>` gives real
  // push/pop screen transitions on native.
  if (Platform.OS !== "web") {
    return (
      <AppErrorBoundary>
        <GestureHandlerRootView style={GESTURE_ROOT_STYLE}>
          <AuthGate>
            <View className="flex-1 bg-background">
              <Stack screenOptions={SCREEN_OPTIONS} />
              <BottomTabBar />
            </View>
          </AuthGate>
        </GestureHandlerRootView>
      </AppErrorBoundary>
    );
  }

  // WEB: ONE responsive tree — the rail↔bottom-bar swap is done purely with
  // NativeWind `md:` breakpoints (768px). The rail is sticky full-height at md+;
  // the floating pill shows below md.
  return (
    <AppErrorBoundary>
      <GestureHandlerRootView style={GESTURE_ROOT_STYLE}>
        <AuthGate>
          <View className="min-h-screen bg-background md:grid md:grid-cols-[4.75rem_1fr]">
            <View className="sticky top-0 z-40 hidden h-screen md:flex md:row-start-1 md:col-start-1">
              <NavRail />
            </View>
            <View className="min-w-0 max-md:pb-[88px] md:col-start-2 md:row-start-1 md:p-2 md:pl-0">
              <Slot />
            </View>
            <View className="fixed inset-x-0 bottom-0 z-[60] md:hidden">
              <BottomTabBar />
            </View>
          </View>
        </AuthGate>
      </GestureHandlerRootView>
    </AppErrorBoundary>
  );
}
