import React, { useCallback, useMemo } from "react";
import { usePathname, useRouter } from "expo-router";
import type { SidebarProps } from "@oxy.so/bloom/sidebar";
import { useOxy } from "@oxy.so/services";
import { Avatar } from "@oxy.so/bloom/avatar";
import { Button } from "@oxy.so/bloom/button";
import { shopNavigationIcon } from "@mercaria/ui";
import { Logo } from "@/components/Logo";
import { useTranslation } from "@/lib/i18n";
import { useCart } from "@/lib/hooks/use-cart";
import { NAV_ITEMS, isNavItemActive, type NavItem } from "./nav-items";

/** The destinations that have a screen; an unbuilt one has no route to push. */
type AvailableNavItem = Extract<NavItem, { available: true }>;

/**
 * The storefront's navigation as Bloom `Sidebar` props, for `AppShell`'s
 * `sidebar` slot. Navigation belongs to Mercaria; the compact rail, drawer,
 * measurement and row chrome belong to Bloom.
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
  const { user, oxyServices } = useOxy();
  const { data: cart } = useCart();
  const cartCount =
    cart?.items.reduce((total, item) => total + item.quantity, 0) ?? 0;
  const avatar = user?.avatar
    ? oxyServices.assets.publicUrl(user.avatar, "thumb")
    : undefined;

  const goHome = useCallback(() => router.push("/"), [router]);
  const goProfile = useCallback(() => router.push("/profile"), [router]);

  const available = useMemo(
    () => NAV_ITEMS.filter((item): item is AvailableNavItem => item.available),
    [],
  );

  const selected = available.find((item) =>
    isNavItemActive(item, pathname),
  )?.key;

  return useMemo<SidebarProps>(
    () => ({
      surface: "plain",
      variant: "rail",
      railLabels: "hidden",
      railSelection: "icon",
      railWidth: 64,
      showSearch: false,
      // Bloom's own chrome labels default to English; every one it draws here
      // is passed translated.
      accessibilityLabel: t("nav.mainNavigation"),
      collapseLabel: t("shell.sidebar.collapse"),
      expandLabel: t("shell.sidebar.expand"),
      showThemeToggle: false,
      logo: {
        icon: <Logo size={28} />,
        accessibilityLabel: t("nav.home"),
        onPress: goHome,
      },
      selected,
      items: available.map((item) => ({
        key: item.key,
        label: t(item.labelKey),
        icon: shopNavigationIcon(item.icon),
        badge: item.key === "cart" && cartCount > 0 ? cartCount : undefined,
        // The route is read from the typed table, never from the row Bloom
        // hands back, so every push is checked against the real route tree.
        onPress: () => router.push(item.href),
      })),
      footer: () => (
        <Button
          appearance="plain"
          tone="neutral"
          iconOnly
          accessibilityLabel={t("profile.title")}
          onPress={goProfile}
          icon={
            user
              ? () => (
                  <Avatar
                    uri={avatar}
                    name={user.name?.displayName ?? user.username}
                    size={32}
                  />
                )
              : shopNavigationIcon("profile")
          }
        />
      ),
    }),
    [
      available,
      avatar,
      cartCount,
      goHome,
      goProfile,
      router,
      selected,
      t,
      user,
    ],
  );
}
