import React, { useCallback, useMemo } from "react";
import { View, Pressable } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { ChevronsLeft, ChevronsRight } from "lucide-react-native";
import { ProfileButton, openAccountDialog, useAuth } from "@oxyhq/services";
import {
  AppSidebar,
  GhostIconButton,
  useRailTooltip,
  useSidebarCollapse,
  cn,
  type AppSidebarItem,
} from "@mercaria/ui";
import { Logo } from "@/components/Logo";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";
import { NAV_ITEMS, isNavItemActive } from "./nav-items";

/**
 * POS sidebar — a thin app wrapper over the shared {@link AppSidebar}. It feeds
 * Mercaria's POS {@link NAV_ITEMS} (each gated by the caller's permission on the
 * active store), builds the header (logo → home + collapse trigger) and footer
 * (the ProfileButton account switcher), and delegates the rail chrome, collapse
 * behavior, hover tooltips, and active treatment to the shared component. The
 * shared UI store owns the expanded ⇄ collapsed flag; the `AppShell` sizes the
 * rail off the same flag.
 *
 * The active-store `StoreSwitcher` stays in each screen's header (it must remain
 * reachable on mobile/native, where there is no rail — only the bottom bar), so
 * this footer carries only the account trigger.
 */
export function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useActiveStoreContext();
  const { showBottomSheet } = useAuth();
  const { collapsed, collapse, expand } = useSidebarCollapse();

  const goHome = useCallback(() => router.push("/"), [router]);

  // POS has no per-user settings route, so "Manage account" opens the SDK's
  // built-in ManageAccount bottom sheet instead of navigating to an app screen.
  const handleManage = useCallback(() => {
    showBottomSheet?.("ManageAccount");
  }, [showBottomSheet]);

  const items = useMemo<AppSidebarItem[]>(
    () =>
      NAV_ITEMS.filter((item) => can(item.permission)).map((item) => ({
        key: item.key,
        label: item.label,
        icon: item.icon,
        href: item.href,
        active: isNavItemActive(item, pathname),
      })),
    [can, pathname],
  );

  const handleSelect = useCallback(
    (item: AppSidebarItem) => {
      router.push(item.href as never);
    },
    [router],
  );

  const expandTooltip = useRailTooltip("Expand sidebar");

  // Header — logo chip on the left, collapse trigger on the right (expanded).
  const header = (
    <View className={cn("flex-row items-center", collapsed && "justify-center")}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Register"
        onPress={goHome}
        className="p-1.5 mx-0.5 rounded-xl web:hover:bg-muted active:bg-muted"
      >
        <Logo size={collapsed ? 26 : 30} />
      </Pressable>
      {!collapsed && (
        <View className="ml-auto">
          <GhostIconButton icon={ChevronsLeft} label="Collapse sidebar" onPress={collapse} />
        </View>
      )}
    </View>
  );

  // Account trigger. ProfileButton owns all three auth states (undetermined
  // skeleton, signed-in avatar + account switcher, signed-out "Sign in") and the
  // device-account switcher menu. It expands with the sidebar and is pinned to
  // the very bottom (footer) below the nav list.
  const profile = (
    <ProfileButton
      expanded={!collapsed}
      onNavigateManage={handleManage}
      onAddAccount={() => openAccountDialog()}
    />
  );

  // Footer — pinned to the bottom edge. The account button sits at the very
  // bottom; on the collapsed rail the expand trigger sits just above it (the
  // header carries the collapse trigger when expanded).
  const footer = collapsed ? (
    <View className="gap-2 items-center">
      <GhostIconButton
        icon={ChevronsRight}
        label="Expand sidebar"
        onPress={expand}
        anchorProps={expandTooltip.anchorProps}
      />
      {expandTooltip.tooltip}
      {profile}
    </View>
  ) : (
    <View className="gap-2">{profile}</View>
  );

  return (
    <AppSidebar
      items={items}
      onSelect={handleSelect}
      collapsed={collapsed}
      header={header}
      footer={footer}
      backgroundColor="bg-background"
    />
  );
}
