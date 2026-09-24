import { Slot, Stack } from "expo-router";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AppShell, AppShellMenuButton } from "@oxy.so/bloom/app-shell";
import { AppErrorBoundary } from "@/components/error-boundary";
import { AuthGate } from "@/components/AuthGate";
import { usePosSidebar } from "@/components/shell/usePosSidebar";
import { BottomTabBar } from "@/components/shell/BottomTabBar";
import { useTranslation } from "@/lib/i18n";

const SCREEN_OPTIONS = { headerShown: false } as const;

const GESTURE_ROOT_STYLE = { flex: 1 } as const;

const IS_WEB = Platform.OS === "web";

/**
 * The shell, as a component of its own so it mounts INSIDE `AuthGate`: the
 * sidebar reads the active store's permissions, which only mean something for
 * a signed-in user — exactly as the old sidebar, rendered in the same place.
 */
function Shell() {
  const { t } = useTranslation();
  const sidebar = usePosSidebar();

  // Bloom's `AppShell` owns the responsive layout: the sidebar in flow from
  // `md` (a drawer below it, opened by the menu button in the header), the
  // bottom bar below `md`, and the clearance under it. This layout only
  // supplies the app-specific slots: the routed content element (a `<Stack>`
  // for native push/pop transitions, a `<Slot>` for the web document-scroll
  // flow), the POS sidebar and the `BottomTabBar`.
  const routed = IS_WEB ? <Slot /> : <Stack screenOptions={SCREEN_OPTIONS} />;

  return (
    <AppShell
      variant="dashboard"
      // WEB scrolls the DOCUMENT (sticky navigation, scroll restoration);
      // NATIVE is one fixed frame and each page owns its scroller (`Screen`).
      scroll={IS_WEB ? "document" : "fixed"}
      sidebar={sidebar}
      // The drawer carries the account footer, which the bottom bar does not,
      // so below `md` the header keeps its menu button — ours, for its label.
      header={<AppShellMenuButton accessibilityLabel={t("nav.openNavigation")} />}
      bottomBar={<BottomTabBar />}
      navFrom="md"
    >
      {routed}
    </AppShell>
  );
}

export default function AppLayout() {
  return (
    <AppErrorBoundary>
      <GestureHandlerRootView style={GESTURE_ROOT_STYLE}>
        <AuthGate>
          <Shell />
        </AuthGate>
      </GestureHandlerRootView>
    </AppErrorBoundary>
  );
}
