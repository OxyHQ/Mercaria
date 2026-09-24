import React, { useCallback, useMemo } from "react";
import { usePathname, useRouter } from "expo-router";
import type { SidebarProps } from "@oxy.so/bloom/sidebar";
import { ProfileButton, openAccountDialog } from "@oxy.so/services";
import { toBloomIcon, useSidebarCollapse } from "@mercaria/ui";
import { Logo } from "@/components/Logo";
import { useTranslation } from "@/lib/i18n";
import { NAV_ITEMS, isNavItemActive, type NavItem } from "./nav-items";

/** The destinations that have a screen; an unbuilt one has no route to push. */
type AvailableNavItem = Extract<NavItem, { available: true }>;

/**
 * The storefront's navigation as Bloom `Sidebar` props, for `AppShell`'s
 * `sidebar` slot. Navigation belongs to Mercaria; measurement, collapse, the
 * drawer and the row chrome belong to Bloom. The same descriptor feeds the
 * in-flow rail and the drawer.
 *
 * Rows come from {@link NAV_ITEMS} — the model the mobile bottom bar reads too —
 * with each label resolved here, at the render site, because the table holds
 * KEYS. Bloom has no disabled row, so a destination whose screen is not built
 * (`available: false`) is left out rather than rendered dead.
 */
export function useStorefrontSidebar(): SidebarProps {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { collapsed, setCollapsed } = useSidebarCollapse();

  const goHome = useCallback(() => router.push("/"), [router]);
  const goSettings = useCallback(() => router.push("/(app)/settings"), [router]);

  const available = useMemo(
    () => NAV_ITEMS.filter((item): item is AvailableNavItem => item.available),
    [],
  );

  const selected = available.find((item) => isNavItemActive(item, pathname))?.key;

  return useMemo<SidebarProps>(
    () => ({
      surface: "plain",
      showSearch: false,
      // Bloom's own chrome labels default to English; every one it draws here
      // is passed translated.
      accessibilityLabel: t("nav.mainNavigation"),
      collapseLabel: t("shell.sidebar.collapse"),
      expandLabel: t("shell.sidebar.expand"),
      showThemeToggle: false,
      collapsed,
      onCollapsedChange: setCollapsed,
      logo: {
        icon: <Logo size={28} />,
        accessibilityLabel: t("nav.home"),
        onPress: goHome,
      },
      selected,
      items: available.map((item) => ({
        key: item.key,
        label: t(item.labelKey),
        icon: toBloomIcon(item.icon),
        // The route is read from the typed table, never from the row Bloom
        // hands back, so every push is checked against the real route tree.
        onPress: () => router.push(item.href),
      })),
      // Account trigger. ProfileButton owns all three auth states
      // (undetermined skeleton, signed-in avatar + account switcher, signed-out
      // "Sign in") and follows the rail's collapsed state.
      footer: ({ collapsed: railCollapsed }) => (
        <ProfileButton
          expanded={!railCollapsed}
          onNavigateManage={goSettings}
          onAddAccount={() => openAccountDialog()}
        />
      ),
    }),
    [available, collapsed, goHome, goSettings, router, selected, setCollapsed, t],
  );
}
