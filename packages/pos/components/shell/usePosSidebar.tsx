import React, { useCallback, useMemo } from "react";
import { usePathname, useRouter } from "expo-router";
import type { SidebarProps } from "@oxy.so/bloom/sidebar";
import { ProfileButton, openAccountDialog, useAuth } from "@oxy.so/services";
import { toBloomIcon, useSidebarCollapse } from "@mercaria/ui";
import { Logo } from "@/components/Logo";
import { useTranslation } from "@/lib/i18n";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";
import { NAV_ITEMS, isNavItemActive } from "./nav-items";

/**
 * The POS's navigation as Bloom `Sidebar` props, for `AppShell`'s `sidebar`
 * slot. Navigation belongs to Mercaria; measurement, collapse, the drawer and
 * the row chrome belong to Bloom. The same descriptor feeds the in-flow rail and
 * the drawer.
 *
 * Rows come from {@link NAV_ITEMS}, each gated by the caller's permission on the
 * active store. The active-store `StoreSwitcher` stays in each screen's header
 * (it must remain reachable on a phone, where there is only the bottom bar), so
 * the footer carries only the account trigger.
 */
export function usePosSidebar(): SidebarProps {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useActiveStoreContext();
  const { showBottomSheet } = useAuth();
  const { collapsed, setCollapsed } = useSidebarCollapse();

  const goHome = useCallback(() => router.push("/"), [router]);

  // POS has no per-user settings route, so "Manage account" opens the SDK's
  // built-in ManageAccount bottom sheet instead of navigating to an app screen.
  const handleManage = useCallback(() => {
    showBottomSheet?.("ManageAccount");
  }, [showBottomSheet]);

  const visible = useMemo(() => NAV_ITEMS.filter((item) => can(item.permission)), [can]);
  const selected = visible.find((item) => isNavItemActive(item, pathname))?.key;

  return useMemo<SidebarProps>(
    () => ({
      surface: "plain",
      showSearch: false,
      // Bloom's own chrome labels default to English; every one it draws here
      // is passed translated.
      accessibilityLabel: t("nav.mainNavigation"),
      collapseLabel: t("nav.collapseSidebar"),
      expandLabel: t("nav.expandSidebar"),
      closeLabel: t("nav.closeSidebar"),
      showThemeToggle: false,
      collapsed,
      onCollapsedChange: setCollapsed,
      logo: {
        icon: <Logo size={28} />,
        accessibilityLabel: t("nav.register"),
        onPress: goHome,
      },
      selected,
      items: visible.map((item) => ({
        key: item.key,
        label: t(item.labelKey),
        icon: toBloomIcon(item.icon),
        // The route is read from the typed table, never from the row Bloom
        // hands back, so every push is checked against the real route tree.
        onPress: () => router.push(item.href),
      })),
      footer: ({ collapsed: railCollapsed }) => (
        <ProfileButton
          expanded={!railCollapsed}
          onNavigateManage={handleManage}
          onAddAccount={() => openAccountDialog()}
        />
      ),
    }),
    [collapsed, goHome, handleManage, router, selected, setCollapsed, t, visible],
  );
}
