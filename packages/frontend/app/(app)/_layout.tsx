import { Slot, Stack } from "expo-router";
import { Platform, useWindowDimensions } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AppShell } from "@oxy.so/bloom/app-shell";
import { AppErrorBoundary } from "@/components/error-boundary";
import { useStorefrontSidebar } from "@/components/shell/useStorefrontSidebar";
import { BottomTabBar } from "@/components/shell/BottomTabBar";
import { useNotificationSetup } from "@/lib/hooks/use-notification-setup";
import { ShoppingActionsProvider } from "@/components/shell/ShoppingActionsProvider";

const SCREEN_OPTIONS = { headerShown: false } as const;

const GESTURE_ROOT_STYLE = { flex: 1 } as const;

const IS_WEB = Platform.OS === "web";

/**
 * The storefront's reading column. A MAXIMUM, not a width: Bloom's feed column
 * shrinks to the space it has, so this only centres the page once the window is
 * wider than a product grid wants to be (the old `max-w-[2000px]`).
 */
const CONTENT_WIDTH = 2000;

export default function AppLayout() {
  // Push notification registration + tap handling.
  useNotificationSetup();

  const sidebar = useStorefrontSidebar();
  const { width } = useWindowDimensions();

  // Bloom's `AppShell` owns the responsive layout: the sidebar in flow from
  // `md` (a drawer below it), the bottom bar below it, and the framed
  // `ContentPanel` around the page (`panel`). This layout only supplies the
  // app-specific slots: the routed content element (a `<Stack>` for native
  // push/pop transitions, a `<Slot>` for the web document-scroll flow), the
  // storefront sidebar and the `BottomTabBar`.
  const routed = IS_WEB ? (
    <Slot />
  ) : (
    <Stack screenOptions={SCREEN_OPTIONS}>
      <Stack.Screen name="index" />
      <Stack.Screen name="stores/[handle]" />
      {/* The PUBLIC P2P seller page (#92), keyed on the Oxy account id —
            never a handle, which a person can change. */}
      <Stack.Screen name="sellers/[oxyUserId]" />
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
    </Stack>
  );

  return (
    <AppErrorBoundary>
      <ShoppingActionsProvider>
        <GestureHandlerRootView style={GESTURE_ROOT_STYLE}>
          <AppShell
            variant="feed"
            panel
            // WEB scrolls the DOCUMENT (sticky navigation, the address bar
            // collapsing, scroll restoration); NATIVE is one fixed frame and each
            // page owns its scroller (`ScreenShell`).
            scroll={IS_WEB ? "document" : "fixed"}
            sidebar={sidebar}
            // Mobile destinations live in the bottom bar or Profile (Orders),
            // so no drawer trigger is needed. Pages draw their own headings.
            header={null}
            bottomBar={<BottomTabBar />}
            navFrom="md"
            contentWidth={CONTENT_WIDTH}
            gutter={width >= 768 ? 8 : 0}
            navigationGap={4}
          >
            {routed}
          </AppShell>
        </GestureHandlerRootView>
      </ShoppingActionsProvider>
    </AppErrorBoundary>
  );
}
